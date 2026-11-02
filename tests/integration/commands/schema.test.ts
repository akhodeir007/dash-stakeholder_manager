import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { commandSchema } from "../../../src/db/schema";
import { migrateCommandSchema } from "../../../src/db/migrate";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/aor_test") throw new Error("Disposable database required");
const schema = `schema_${randomUUID().replaceAll("-", "")}`;
const pool = new Pool({ connectionString: url });
const project = randomUUID(), aggregate = randomUUID(), event = randomUUID();
beforeAll(async () => {
  await migrateCommandSchema(pool, schema);
  await pool.query(`INSERT INTO "${schema}".projects VALUES ('t',$1,0)`, [project]);
  await pool.query(`INSERT INTO "${schema}".aggregates VALUES ('t',$1,$2,'synthetic','1.2','{}',$3,'A',0,0)`, [aggregate, project, "0".repeat(64)]);
  await pool.query(`INSERT INTO "${schema}".transition_commits VALUES ($1,'t',$2,1,'synthetic','actor',now())`, [randomUUID(), aggregate]);
  await pool.query(`INSERT INTO "${schema}".command_events VALUES ($1,'t',$2,1,1,'{}')`, [event, aggregate]);
  await pool.query(`INSERT INTO "${schema}".command_outbox VALUES ($1,$2,'{}',now())`, [randomUUID(), event]);
});
afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); });

it("Drizzle columns, SQL types and nullability match every migrated table", async () => {
  for (const table of Object.values(commandSchema(schema))) {
    const config = getTableConfig(table);
    const rows = (await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2", [schema, config.name])).rows;
    expect(rows).toHaveLength(config.columns.length);
    for (const column of config.columns) {
      const actual = rows.find((row) => row.column_name === column.name);
      expect(actual).toBeDefined(); expect(actual?.data_type).toBe(column.getSQLType());
      expect(actual?.is_nullable).toBe(column.notNull ? "NO" : "YES");
    }
  }
});
it("enforces unique transition versions and sequenced event identities", async () => {
  await expect(pool.query(`INSERT INTO "${schema}".transition_commits VALUES ($1,'t',$2,1,'duplicate','actor',now())`, [randomUUID(), aggregate])).rejects.toMatchObject({ code: "23505" });
  await expect(pool.query(`INSERT INTO "${schema}".command_events VALUES ($1,'t',$2,1,1,'{}')`, [randomUUID(), aggregate])).rejects.toMatchObject({ code: "23505" });
});
it("enforces event-to-commit and outbox-to-event foreign keys", async () => {
  await expect(pool.query(`INSERT INTO "${schema}".command_events VALUES ($1,'t',$2,99,1,'{}')`, [randomUUID(), aggregate])).rejects.toMatchObject({ code: "23503" });
  await expect(pool.query(`INSERT INTO "${schema}".command_outbox VALUES ($1,$2,'{}',now())`, [randomUUID(), randomUUID()])).rejects.toMatchObject({ code: "23503" });
});
it("enforces one outbox row per event and one handler receipt per event", async () => {
  await expect(pool.query(`INSERT INTO "${schema}".command_outbox VALUES ($1,$2,'{}',now())`, [randomUUID(), event])).rejects.toMatchObject({ code: "23505" });
  await pool.query(`INSERT INTO "${schema}".handler_receipts VALUES ('handler',$1,now())`, [event]);
  await expect(pool.query(`INSERT INTO "${schema}".handler_receipts VALUES ('handler',$1,now())`, [event])).rejects.toMatchObject({ code: "23505" });
});
it("rejects negative versions and malformed immutable scope hashes", async () => {
  await expect(pool.query(`UPDATE "${schema}".aggregates SET version=-1`)).rejects.toMatchObject({ code: "23514" });
  await expect(pool.query(`UPDATE "${schema}".aggregates SET scope_hash='invalid'`)).rejects.toMatchObject({ code: "23514" });
});
it("detects a changed versioned migration checksum", async () => {
  await pool.query(`UPDATE "${schema}".schema_migrations SET checksum='incorrect'`);
  await expect(migrateCommandSchema(pool, schema)).rejects.toThrow("MIGRATION_CHECKSUM_MISMATCH");
});
