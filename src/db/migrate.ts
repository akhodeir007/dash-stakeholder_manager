import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";

/** Administrative bootstrap only; no HTTP route exposes migrations or state initialization. */
export async function migrateCommandSchema(pool: Pool, schema: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("INVALID_SCHEMA");
  const sql = readFileSync(new URL("./migrations/0001_command_foundation.sql", import.meta.url), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`aor-migrate:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}",pg_catalog`);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, checksum text NOT NULL)");
    const existing = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version='0001'");
    if (existing.rows[0] && existing.rows[0].checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
    if (!existing.rowCount) {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations VALUES ('0001',$1)", [checksum]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
