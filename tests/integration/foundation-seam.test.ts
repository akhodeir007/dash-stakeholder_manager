import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAuthorizationService } from "../../src/auth/authorization";
import { canonicalHash, createCommandEngine, type CommandEnvelope, type EngineOptions } from "../../src/domain/commands/engine";
import type { EvidenceAuthorizationFact, HumanRole, RoleAssignment, ScopeBinding, TransitionRule, VerifiedSessionRecord } from "../../src/contracts/foundation";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/aor_test") throw new Error("Disposable PostgreSQL required for foundation seam tests");
const now = new Date("2026-11-02T12:00:00Z");
let db: Client;
const cleanup: { schema: string; engine: ReturnType<typeof createCommandEngine> }[] = [];
beforeAll(async () => { db = new Client({ connectionString: url }); await db.connect(); });
afterEach(async () => {
  for (const item of cleanup.splice(0)) { await item.engine.close(); await db.query(`DROP SCHEMA IF EXISTS "${item.schema}" CASCADE`); }
});
afterAll(async () => { await db?.end(); });

async function fixture(role: HumanRole = "AOR_LEAD", operation: TransitionRule["operation"] = "TRANSITION", facts?: EngineOptions["loadAuthorizationFacts"]) {
  const projectId = randomUUID(), aggregateId = randomUUID(), schema = `seam_${randomUUID().replaceAll("-", "")}`;
  const scope: ScopeBinding = { kind: "PROJECT_SCOPE", projectId, scopeVersion: 1, evidenceVersionIds: [] };
  const rule: TransitionRule = { id: "synthetic-transition", machineId: "synthetic", event: "APPLY", from: ["A"], to: "B", roles: ["AOR_LEAD", "STAKEHOLDER_MANAGER"], guards: ["synthetic-only"], effects: [], operation };
  let active = true;
  const transactions: unknown[] = [];
  const service = createAuthorizationService({
    rules: [rule],
    verifySession: async (credential, transaction) => {
      transactions.push(transaction);
      if (credential !== "synthetic-credential") return null;
      const assignment: RoleAssignment = { id: "assignment", actorId: "synthetic-user", version: 1, tenantId: "synthetic-tenant", role,
        scope: { kind: "PROJECT", projectId, allPackages: false }, verified: true, active, validFrom: "2026-01-01T00:00:00Z", validUntil: null };
      const session: VerifiedSessionRecord = { actorId: "synthetic-user", tenantId: "synthetic-tenant", kind: "HUMAN", expiresAt: "2099-01-01T00:00:00Z", assignments: [assignment] };
      return session;
    },
  });
  const engine = createCommandEngine({ connectionString: url!, schema, authorization: service, transitions: [rule], guards: { "synthetic-only": () => true }, payloadValidators: { [rule.id]: () => true }, clock: () => new Date(now), loadAuthorizationFacts: facts });
  cleanup.push({ schema, engine }); await engine.initialize();
  await db.query(`INSERT INTO "${schema}".projects VALUES ('synthetic-tenant',$1,0)`, [projectId]);
  await db.query(`INSERT INTO "${schema}".aggregates (tenant_id,aggregate_id,project_id,machine_id,contract_version,scope,scope_hash,state,version,dependency_epoch) VALUES ('synthetic-tenant',$1,$2,'synthetic','1.2',$3,$4,'A',0,0)`, [aggregateId, projectId, JSON.stringify(scope), canonicalHash(scope)]);
  const command: CommandEnvelope = { commandId: randomUUID(), commandName: "APPLY", aggregateId, transitionId: rule.id, contractVersion: "1.2", idempotencyKey: randomUUID(), expected: { aggregateVersion: 0, dependencyEpoch: 0 }, scope, payload: {} };
  const count = async () => Number((await db.query(`SELECT count(*) AS count FROM "${schema}".transition_commits`)).rows[0].count);
  return { engine, command, schema, count, transactions, revoke: () => { active = false; } };
}

describe("actual authorization policy and PostgreSQL command seam", () => {
  it("commits with a privately resolved in-scope principal and refreshes it within the DB transaction", async () => {
    const f = await fixture(); expect((await f.engine.execute("synthetic-credential", f.command)).ok).toBe(true);
    expect(await f.count()).toBe(1); expect(f.transactions.length).toBeGreaterThan(2);
    for (const transaction of f.transactions) expect(typeof (transaction as { query: unknown }).query).toBe("function");
  });
  it("rejects an authenticated but disallowed local role without any success writes", async () => {
    const f = await fixture("CLIENT_EXECUTIVE");
    expect(await f.engine.execute("synthetic-credential", f.command)).toMatchObject({ ok: false, error: "FORBIDDEN" }); expect(await f.count()).toBe(0);
  });
  it("does not treat a caller-supplied principal object as a credential", async () => {
    const f = await fixture();
    expect(await f.engine.execute({ actorId: "synthetic-user", verified: true, roles: ["AOR_LEAD"] }, f.command)).toMatchObject({ ok: false, error: "UNAUTHENTICATED" }); expect(await f.count()).toBe(0);
  });
  it("denies revoked assignments even for a cached idempotent response", async () => {
    const f = await fixture(); await f.engine.execute("synthetic-credential", f.command); f.revoke();
    expect((await f.engine.execute("synthetic-credential", f.command)).ok).toBe(false); expect(await f.count()).toBe(1);
  });
  it("denies evidence validation when no server evidence facts are loaded", async () => {
    const f = await fixture("STAKEHOLDER_MANAGER", "VALIDATE_EVIDENCE");
    expect((await f.engine.execute("synthetic-credential", { ...f.command, payload: { evidence: { class: "NOC", uploaderId: "other", verified: true } } })).ok).toBe(false); expect(await f.count()).toBe(0);
  });
  it("uses transaction-loaded evidence facts, not forged payload independence claims", async () => {
    const f = await fixture("STAKEHOLDER_MANAGER", "VALIDATE_EVIDENCE", async (transaction) => {
      await transaction.query("SELECT 1");
      return { evidence: { class: "NOC", uploaderId: "synthetic-user" } };
    });
    expect((await f.engine.execute("synthetic-credential", { ...f.command, payload: { uploaderId: "someone-else", independentValidationVerified: true } })).ok).toBe(false); expect(await f.count()).toBe(0);
  });
  it("allows independently authorized evidence facts without implementing live evidence approval", async () => {
    const facts: EvidenceAuthorizationFact = { class: "NOC", uploaderId: "synthetic-other-uploader" };
    const f = await fixture("STAKEHOLDER_MANAGER", "VALIDATE_EVIDENCE", async (transaction) => { await transaction.query("SELECT 1"); return { evidence: facts }; });
    expect((await f.engine.execute("synthetic-credential", f.command)).ok).toBe(true); expect(await f.count()).toBe(1);
  });
});
