import { randomUUID, createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCommandEngine, loadMachineDefinitions, type CommandEnvelope, type EngineOptions } from "../../../src/domain/commands/engine";
import type { AuthorizationPort, JsonValue, Principal, ScopeBinding, TransitionRule } from "../../../src/contracts/foundation";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("An explicitly disposable loopback aor_test PostgreSQL database is required");
}
const now = new Date("2026-11-02T12:00:00Z");
const principal: Principal = { actorId: "synthetic-actor", tenantId: "synthetic-tenant", kind: "HUMAN", expiresAt: "2099-01-01T00:00:00Z", issuedAt: now.toISOString(), assignments: [] };
const allow: AuthorizationPort = { resolve: async () => principal, authorize: () => ({ allowed: true }) };
const baseRule: TransitionRule = { id: "t1", machineId: "synthetic", event: "GO", from: ["A"], to: "B", roles: ["AOR_LEAD"], guards: ["synthetic"], effects: [], operation: "TRANSITION" };
const hash = (value: unknown) => createHash("sha256").update(canonicalize(value)!).digest("hex");
type Options = Partial<EngineOptions> & { buildEvents?: () => JsonValue[]; payloadValidators?: Record<string, (payload: JsonValue) => boolean> };
let admin: Client;
const resources: { schema: string; engine: ReturnType<typeof createCommandEngine> }[] = [];

async function fixture(options: Options = {}) {
  const schema = `cmd_${randomUUID().replaceAll("-", "")}`;
  const projectId = randomUUID(), aggregateId = randomUUID();
  const scope: ScopeBinding = { kind: "PROJECT_SCOPE", projectId, scopeVersion: 1, evidenceVersionIds: [] };
  const engine = createCommandEngine({ connectionString: url!, schema, authorization: allow, transitions: [baseRule], guards: { synthetic: () => true }, clock: () => new Date(now), payloadValidators: { t1: () => true, t2: () => true }, ...options });
  resources.push({ schema, engine });
  await engine.initialize();
  await admin.query(`INSERT INTO "${schema}".projects (tenant_id,project_id,dependency_epoch) VALUES ($1,$2,0)`, [principal.tenantId, projectId]);
  // Fixture-only initialization. Runtime engine must expose no arbitrary state setter.
  async function seed(id = aggregateId, targetScope: ScopeBinding = scope) {
    await admin.query(`INSERT INTO "${schema}".aggregates (tenant_id,aggregate_id,project_id,machine_id,contract_version,scope,scope_hash,state,version,dependency_epoch) VALUES ($1,$2,$3,'synthetic','1.2',$4,$5,'A',0,0)`, [principal.tenantId, id, projectId, JSON.stringify(targetScope), hash(targetScope)]);
  }
  await seed();
  const command: CommandEnvelope = { commandId: randomUUID(), commandName: "GO", aggregateId, transitionId: "t1", idempotencyKey: randomUUID(), contractVersion: "1.2", expected: { aggregateVersion: 0, dependencyEpoch: 0 }, scope, payload: { x: 1 } };
  const counts = async () => {
    const result = await admin.query(`SELECT (SELECT count(*)::int FROM "${schema}".transition_commits) commits, (SELECT count(*)::int FROM "${schema}".command_events) events, (SELECT count(*)::int FROM "${schema}".audit_ledger) ledger, (SELECT count(*)::int FROM "${schema}".command_outbox) outbox, (SELECT count(*)::int FROM "${schema}".idempotency_records) idem`);
    return result.rows[0];
  };
  const state = async () => (await admin.query(`SELECT state,version,dependency_epoch FROM "${schema}".aggregates WHERE aggregate_id=$1`, [aggregateId])).rows[0];
  return { schema, engine, projectId, aggregateId, scope, command, seed, counts, state };
}

beforeAll(async () => { admin = new Client({ connectionString: url }); await admin.connect(); });
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.engine.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${resource.schema}" CASCADE`);
  }
});
afterAll(async () => { await admin?.end(); });
const empty = { commits: 0, events: 0, ledger: 0, outbox: 0, idem: 0 };

describe("real PostgreSQL atomic command foundation", () => {
  it("commits state and all success records, then replays without another write", async () => {
    const f = await fixture();
    expect((await f.engine.execute("credential", f.command)).ok).toBe(true);
    expect((await f.engine.execute("credential", f.command)).replayed).toBe(true);
    expect(await f.counts()).toEqual({ commits: 1, events: 1, ledger: 1, outbox: 1, idem: 1 });
    expect((await f.state()).state).toBe("B");
  });
  it("transport command ID changes do not invalidate semantic replay", async () => {
    const f = await fixture();
    const first = await f.engine.execute("x", f.command);
    const replay = await f.engine.execute("x", { ...f.command, commandId: randomUUID() });
    expect(replay).toMatchObject({ ok: true, replayed: true, eventIds: first.eventIds });
  });
  it.each([false, undefined, "true"])("denies non-true guard result %s atomically", async (value) => {
    const f = await fixture({ guards: { synthetic: () => value as boolean } });
    expect(await f.engine.execute("x", f.command)).toMatchObject({ ok: false, error: "GUARD_DENIED" });
    expect(await f.counts()).toEqual(empty); expect((await f.state()).version).toBe(0);
  });
  it("denies an unregistered guard", async () => {
    const f = await fixture({ guards: {} });
    expect(await f.engine.execute("x", f.command)).toMatchObject({ ok: false, error: "GUARD_DENIED" });
    expect(await f.counts()).toEqual(empty);
  });
  it("denies a throwing guard without surfacing SQL/internal errors", async () => {
    const f = await fixture({ guards: { synthetic: () => { throw new Error("sensitive internal message"); } } });
    const result = await f.engine.execute("x", f.command);
    expect(result).toMatchObject({ ok: false, error: "GUARD_DENIED" });
    expect(JSON.stringify(result)).not.toContain("sensitive"); expect(await f.counts()).toEqual(empty);
  });
  it("requires registered payload validation", async () => {
    const f = await fixture({ payloadValidators: {} });
    expect((await f.engine.execute("x", f.command)).ok).toBe(false); expect(await f.counts()).toEqual(empty);
  });
  it("denies unauthenticated credentials and forged payload privileges", async () => {
    const f = await fixture({ authorization: { ...allow, resolve: async () => null } });
    expect(await f.engine.execute("x", { ...f.command, payload: { roles: ["SYSTEM_ADMIN"], guardResults: true } })).toMatchObject({ ok: false, error: "UNAUTHENTICATED" });
    expect(await f.counts()).toEqual(empty);
  });
  it("denies another tenant without disclosing its aggregate", async () => {
    const f = await fixture({ authorization: { ...allow, resolve: async () => ({ ...principal, tenantId: "other" }) } });
    expect((await f.engine.execute("x", f.command)).ok).toBe(false); expect(await f.counts()).toEqual(empty);
  });
  it("denies mismatched package/project scope", async () => {
    const f = await fixture();
    const scope = { ...f.scope, projectId: randomUUID() } as ScopeBinding;
    expect((await f.engine.execute("x", { ...f.command, scope })).ok).toBe(false); expect(await f.counts()).toEqual(empty);
  });
  it("denies a stale aggregate version", async () => {
    const f = await fixture();
    expect(await f.engine.execute("x", { ...f.command, expected: { ...f.command.expected, aggregateVersion: 5 } })).toMatchObject({ ok: false, error: "VERSION_CONFLICT" });
    expect(await f.counts()).toEqual(empty);
  });
  it("denies a stale dependency epoch", async () => {
    const f = await fixture();
    await admin.query(`UPDATE "${f.schema}".projects SET dependency_epoch=1`);
    expect(await f.engine.execute("x", f.command)).toMatchObject({ ok: false, error: "DEPENDENCY_STALE" }); expect(await f.counts()).toEqual(empty);
  });
  it("same key with another payload conflicts without a second write", async () => {
    const f = await fixture(); await f.engine.execute("x", f.command);
    expect(await f.engine.execute("x", { ...f.command, payload: { x: 2 } })).toMatchObject({ ok: false, error: "IDEMPOTENCY_CONFLICT" });
    expect((await f.counts()).commits).toBe(1);
  });
  it("same key across command names conflicts", async () => {
    const f = await fixture({ transitions: [baseRule, { ...baseRule, id: "t2", event: "OTHER" }] });
    await f.engine.execute("x", f.command);
    expect(await f.engine.execute("x", { ...f.command, commandName: "OTHER", transitionId: "t2" })).toMatchObject({ ok: false, error: "IDEMPOTENCY_CONFLICT" });
  });
  it("concurrent duplicate keys produce one commit and one replay", async () => {
    const f = await fixture();
    const results = await Promise.all([f.engine.execute("x", f.command), f.engine.execute("x", f.command)]);
    expect(results.every((r) => r.ok)).toBe(true); expect(results.filter((r) => r.replayed).length).toBe(1);
    expect((await f.counts()).commits).toBe(1);
  });
  it("concurrent distinct writers cannot both use expected version zero", async () => {
    const f = await fixture();
    const results = await Promise.all([f.engine.execute("x", f.command), f.engine.execute("x", { ...f.command, idempotencyKey: randomUUID() })]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.find((r) => !r.ok)?.error).toBe("VERSION_CONFLICT"); expect((await f.counts()).commits).toBe(1);
  });
  it.each(["state", "commit", "event", "ledger", "outbox", "idempotency"])("rolls back every success write after injected %s failure", async (point) => {
    const f = await fixture({ fault: (step) => { if (step === point) throw new Error("injected"); } });
    expect((await f.engine.execute("x", f.command)).ok).toBe(false);
    expect(await f.counts()).toEqual(empty); expect(await f.state()).toMatchObject({ state: "A", version: 0, dependency_epoch: 0 });
  });
  it("emits multiple sequenced events in one aggregate version", async () => {
    const f = await fixture({ buildEvents: () => [{ notice: 1 }, { notice: 2 }] });
    expect((await f.engine.execute("x", f.command)).ok).toBe(true);
    expect(await f.counts()).toEqual({ commits: 1, events: 2, ledger: 1, outbox: 2, idem: 1 });
    expect((await admin.query(`SELECT sequence FROM "${f.schema}".command_events ORDER BY sequence`)).rows.map((r) => r.sequence)).toEqual([1, 2]);
  });
  it.each(["command_events", "audit_ledger", "command_outbox", "transition_commits"])("rejects UPDATE and DELETE on immutable %s records", async (table) => {
    const f = await fixture(); await f.engine.execute("x", f.command);
    await expect(admin.query(`UPDATE "${f.schema}".${table} SET id=id`)).rejects.toThrow(/immutable/i);
    await expect(admin.query(`DELETE FROM "${f.schema}".${table}`)).rejects.toThrow(/immutable/i);
  });
  it.each([NaN, undefined, () => true, new Date()])("rejects non-JSON payload %s without throwing", async (payload) => {
    const f = await fixture(); expect(await f.engine.execute("x", { ...f.command, payload: payload as JsonValue })).toMatchObject({ ok: false, error: "SCHEMA_INVALID" });
    expect(await f.counts()).toEqual(empty);
  });
  it("rejects cyclic payloads and top-level actor/privilege fields", async () => {
    const f = await fixture(); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect((await f.engine.execute("x", { ...f.command, payload: cyclic as JsonValue })).ok).toBe(false);
    expect((await f.engine.execute("x", { ...f.command, actorId: "forged" } as CommandEnvelope)).ok).toBe(false);
    expect(await f.counts()).toEqual(empty);
  });
  it("freezes caller registry and payload against mid-guard mutation", async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const rule = { ...baseRule };
    const f = await fixture({ transitions: [rule], guards: { synthetic: async () => { entered(); await resume; return true; } } });
    const pending = f.engine.execute("x", f.command); await ready;
    rule.to = "C"; (f.command.payload as Record<string, JsonValue>).x = 99; release();
    expect(await pending).toMatchObject({ ok: true, state: "B" });
    const body = (await admin.query(`SELECT body FROM "${f.schema}".command_events`)).rows[0].body;
    expect(body.payload).toEqual({ x: 1 });
  });
  it("rechecks changed authorization after awaited guards", async () => {
    let authorized = true;
    const f = await fixture({ authorization: { ...allow, authorize: () => authorized ? { allowed: true } : { allowed: false, code: "FORBIDDEN", reason: "revoked" } }, guards: { synthetic: () => { authorized = false; return true; } } });
    expect((await f.engine.execute("x", f.command)).ok).toBe(false); expect(await f.counts()).toEqual(empty);
  });
  it("binds refreshed identity to the original tenant and actor", async () => {
    let count = 0;
    const f = await fixture({ authorization: { ...allow, resolve: async () => (++count === 1 ? principal : { ...principal, actorId: "changed" }) } });
    expect((await f.engine.execute("x", f.command)).ok).toBe(false); expect(await f.counts()).toEqual(empty);
  });
  it("denies authorization-fact loader exceptions atomically", async () => {
    const f = await fixture({ loadAuthorizationFacts: async () => { throw new Error("failed"); } });
    expect((await f.engine.execute("x", f.command)).ok).toBe(false); expect(await f.counts()).toEqual(empty);
  });
  it("replays history after invalidation but never grants a new stale action", async () => {
    const f = await fixture(); await f.engine.execute("x", f.command);
    await admin.query(`UPDATE "${f.schema}".projects SET dependency_epoch=1`);
    expect(await f.engine.execute("x", f.command)).toMatchObject({ ok: true, replayed: true });
    expect((await f.engine.execute("x", { ...f.command, idempotencyKey: randomUUID(), expected: { aggregateVersion: 1, dependencyEpoch: 0 } })).ok).toBe(false);
    expect((await f.counts()).commits).toBe(1);
  });
  it("bounds serialization retries and rolls each failed attempt back", async () => {
    let attempts = 0;
    const f = await fixture({ fault: (point) => { if (point === "state") { attempts++; throw Object.assign(new Error("retry"), { code: "40001" }); } } });
    expect(await f.engine.execute("x", f.command)).toMatchObject({ ok: false, error: "TRANSIENT_FAILURE" });
    expect(attempts).toBe(3); expect(await f.counts()).toEqual(empty);
  });
  it("loader pins roles, operations, source states and all dual control pairs", () => {
    const definitions = loadMachineDefinitions();
    expect(definitions.transitions).toHaveLength(173);
    expect(definitions.transitions.find((t) => t.id === "S10-T04")?.operation).toBe("VALIDATE_EVIDENCE");
    expect(definitions.transitions.find((t) => t.id === "S2DS-T03")?.operation).toBe("RECORD_STAMP");
    expect(definitions.transitions.find((t) => t.id === "S7-T07")?.dualControlPairs).toEqual([["CLIENT_EXECUTIVE", "CLIENT_EXECUTIVE"]]);
    for (const id of ["S2B-T11", "S2BC-T15", "S4-T07", "S4-T09", "S10-T10"]) expect(definitions.transitions.find((t) => t.id === id)?.invalidatesDependencies).toBe(true);
  });
  it("invalidates epochs atomically and denies a concurrent stale dependent action", async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const invalidator: TransitionRule = { ...baseRule, id: "t2", event: "INVALIDATE", guards: ["hold"], invalidatesDependencies: true };
    const f = await fixture({ transitions: [baseRule, invalidator], guards: { synthetic: () => true, hold: async () => { entered(); await resume; return true; } } });
    const dependencyId = randomUUID(); await f.seed(dependencyId);
    const invalidation = f.engine.execute("x", { ...f.command, aggregateId: dependencyId, transitionId: "t2", commandName: "INVALIDATE", idempotencyKey: randomUUID() });
    await ready; const action = f.engine.execute("x", f.command); release();
    expect((await invalidation).ok).toBe(true);
    expect(await action).toMatchObject({ ok: false, error: "DEPENDENCY_STALE" });
    expect((await admin.query(`SELECT dependency_epoch FROM "${f.schema}".projects`)).rows[0].dependency_epoch).toBe(1);
    expect((await f.state()).version).toBe(0); expect((await f.counts()).commits).toBe(1);
  });
  it("rolls epoch invalidation back with the rest of a failed command", async () => {
    const f = await fixture({ transitions: [{ ...baseRule, invalidatesDependencies: true }], fault: (step) => { if (step === "epoch") throw new Error("injected"); } });
    expect((await f.engine.execute("x", f.command)).ok).toBe(false);
    expect((await admin.query(`SELECT dependency_epoch FROM "${f.schema}".projects`)).rows[0].dependency_epoch).toBe(0);
    expect(await f.counts()).toEqual(empty);
  });
  it("hash-chains immutable audit entries across consecutive versions", async () => {
    const f = await fixture({ transitions: [baseRule, { ...baseRule, id: "t2", event: "NEXT", from: ["B"], to: "C" }] });
    expect((await f.engine.execute("x", f.command)).ok).toBe(true);
    expect((await f.engine.execute("x", { ...f.command, commandName: "NEXT", transitionId: "t2", idempotencyKey: randomUUID(), expected: { aggregateVersion: 1, dependencyEpoch: 0 } })).ok).toBe(true);
    const rows = (await admin.query(`SELECT body,previous_hash,entry_hash FROM "${f.schema}".audit_ledger ORDER BY version`)).rows;
    expect(rows[0].previous_hash).toBeNull(); expect(rows[1].previous_hash).toBe(rows[0].entry_hash);
    for (const row of rows) expect(row.entry_hash).toBe(hash({ previousHash: row.previous_hash, body: row.body }));
  });
  it("rechecks clock-sensitive guards immediately before commit", async () => {
    let valid = true;
    const f = await fixture({ guards: { synthetic: () => valid }, fault: (step) => { if (step === "idempotency") valid = false; } });
    expect(await f.engine.execute("x", f.command)).toMatchObject({ ok: false, error: "GUARD_DENIED" });
    expect(await f.counts()).toEqual(empty); expect((await f.state()).version).toBe(0);
  });
  it("rechecks identity and permissions after all writes but before commit", async () => {
    let permitted = true;
    const f = await fixture({ authorization: { ...allow, authorize: () => permitted ? { allowed: true } : { allowed: false, code: "FORBIDDEN", reason: "revoked" } }, fault: (step) => { if (step === "idempotency") permitted = false; } });
    expect(await f.engine.execute("x", f.command)).toMatchObject({ ok: false, error: "FORBIDDEN" }); expect(await f.counts()).toEqual(empty);
  });
  it("migration bootstrap is repeatable and has no public runtime seed setter", async () => {
    const f = await fixture(); await expect(f.engine.initialize()).resolves.toBeUndefined();
    expect("seedAggregate" in f.engine).toBe(false);
    expect((await admin.query(`SELECT count(*)::int AS count FROM "${f.schema}".schema_migrations`)).rows[0].count).toBe(1);
  });
  it("cached history does not rerun execution-only payload validators", async () => {
    let valid = true;
    const f = await fixture({ payloadValidators: { t1: () => valid } });
    expect((await f.engine.execute("x", f.command)).ok).toBe(true); valid = false;
    expect(await f.engine.execute("x", f.command)).toMatchObject({ ok: true, replayed: true });
    expect((await f.counts()).commits).toBe(1);
  });
});
