import { sql } from "drizzle-orm";
import { pgSchema, text, uuid, integer, jsonb, timestamp, primaryKey, unique, foreignKey, check } from "drizzle-orm/pg-core";

/** SQL migration owns immutable triggers; these definitions mirror its relational structure. */
export function commandSchema(name: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error("INVALID_SCHEMA");
  const s = pgSchema(name);
  const projects = s.table("projects", {
    tenantId: text("tenant_id").notNull(), projectId: uuid("project_id").notNull(), dependencyEpoch: integer("dependency_epoch").notNull().default(0),
  }, (t) => [primaryKey({ columns: [t.tenantId, t.projectId] }), check("project_epoch_nonnegative", sql`${t.dependencyEpoch} >= 0`)]);
  const aggregates = s.table("aggregates", {
    tenantId: text("tenant_id").notNull(), aggregateId: uuid("aggregate_id").notNull(), projectId: uuid("project_id").notNull(), machineId: text("machine_id").notNull(),
    contractVersion: text("contract_version").notNull(), scope: jsonb("scope").notNull(), scopeHash: text("scope_hash").notNull(), state: text("state").notNull(),
    version: integer("version").notNull(), dependencyEpoch: integer("dependency_epoch").notNull(),
  }, (t) => [primaryKey({ columns: [t.tenantId, t.aggregateId] }), foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    check("aggregate_version_nonnegative", sql`${t.version} >= 0`), check("aggregate_epoch_nonnegative", sql`${t.dependencyEpoch} >= 0`), check("aggregate_scope_hash", sql`length(${t.scopeHash}) = 64`)]);
  const idem = s.table("idempotency_records", {
    tenantId: text("tenant_id").notNull(), actorId: text("actor_id").notNull(), key: text("key").notNull(), semanticHash: text("semantic_hash").notNull(), result: jsonb("result").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  }, (t) => [primaryKey({ columns: [t.tenantId, t.actorId, t.key] }), check("semantic_hash_length", sql`length(${t.semanticHash}) = 64`)]);
  const transitions = s.table("transition_commits", {
    id: uuid("id").primaryKey(), tenantId: text("tenant_id").notNull(), aggregateId: uuid("aggregate_id").notNull(), version: integer("version").notNull(),
    transitionId: text("transition_id").notNull(), actorId: text("actor_id").notNull(), at: timestamp("at", { withTimezone: true }).notNull(),
  }, (t) => [unique().on(t.tenantId, t.aggregateId, t.version), check("commit_version_positive", sql`${t.version} > 0`),
    foreignKey({ columns: [t.tenantId, t.aggregateId], foreignColumns: [aggregates.tenantId, aggregates.aggregateId] })]);
  const events = s.table("command_events", {
    id: uuid("id").primaryKey(), tenantId: text("tenant_id").notNull(), aggregateId: uuid("aggregate_id").notNull(), version: integer("version").notNull(), sequence: integer("sequence").notNull(), body: jsonb("body").notNull(),
  }, (t) => [unique().on(t.tenantId, t.aggregateId, t.version, t.sequence), check("event_sequence_positive", sql`${t.sequence} > 0`),
    foreignKey({ columns: [t.tenantId, t.aggregateId, t.version], foreignColumns: [transitions.tenantId, transitions.aggregateId, transitions.version] })]);
  const ledger = s.table("audit_ledger", {
    id: uuid("id").primaryKey(), tenantId: text("tenant_id").notNull(), aggregateId: uuid("aggregate_id").notNull(), version: integer("version").notNull(), body: jsonb("body").notNull(),
    previousHash: text("previous_hash"), entryHash: text("entry_hash").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  }, (t) => [unique().on(t.tenantId, t.aggregateId, t.version), check("ledger_entry_hash", sql`length(${t.entryHash}) = 64`), check("ledger_previous_hash", sql`${t.previousHash} IS NULL OR length(${t.previousHash}) = 64`),
    foreignKey({ columns: [t.tenantId, t.aggregateId, t.version], foreignColumns: [transitions.tenantId, transitions.aggregateId, transitions.version] })]);
  const outbox = s.table("command_outbox", { id: uuid("id").primaryKey(), eventId: uuid("event_id").notNull().unique().references(() => events.id), body: jsonb("body").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull() });
  const receipts = s.table("handler_receipts", { handler: text("handler").notNull(), eventId: uuid("event_id").notNull().references(() => events.id), receivedAt: timestamp("received_at", { withTimezone: true }).notNull() }, (t) => [primaryKey({ columns: [t.handler, t.eventId] })]);
  const migrations = s.table("schema_migrations", { version: text("version").primaryKey(), checksum: text("checksum").notNull() });
  return { projects, aggregates, idem, transitions, events, ledger, outbox, receipts, migrations };
}
