import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import canonicalize from "canonicalize";
import { Pool, type PoolClient } from "pg";
import YAML from "yaml";
import { migrateCommandSchema } from "../../db/migrate";
import type { AuthorizationContext, AuthorizationPort, JsonValue, Principal, Role, ScopeBinding, TransitionRule } from "../../contracts/foundation";

export interface CommandEnvelope {
  commandId: string; commandName: string; aggregateId: string; transitionId: string;
  idempotencyKey: string; contractVersion: string;
  expected: { aggregateVersion: number; dependencyEpoch: number };
  scope: ScopeBinding; payload: JsonValue;
}
export type CommandError = "SCHEMA_INVALID" | "UNAUTHENTICATED" | "FORBIDDEN" | "APPROVAL_INVALID" |
  "STATE_CONFLICT" | "VERSION_CONFLICT" | "DEPENDENCY_STALE" | "GUARD_DENIED" |
  "IDEMPOTENCY_CONFLICT" | "TRANSIENT_FAILURE";
export type CommandResult = {
  ok: true; aggregateVersion: number; state: string; eventIds: string[]; replayed: boolean;
  error?: never; retryable?: never;
} | {
  ok: false; error: CommandError; retryable: boolean; failedGuards?: string[];
  aggregateVersion?: never; state?: never; eventIds?: never; replayed?: never;
};
export type FaultPoint = "state" | "epoch" | "commit" | "event" | "ledger" | "outbox" | "idempotency";
type GuardInput = { payload: JsonValue; principal: Principal; transaction: PoolClient; now: Date };
export interface EngineOptions {
  connectionString: string; schema: string; authorization: AuthorizationPort;
  transitions: readonly TransitionRule[];
  guards: Readonly<Record<string, (input: GuardInput) => unknown | Promise<unknown>>>;
  payloadValidators?: Readonly<Record<string, (payload: JsonValue) => unknown>>;
  clock: () => Date;
  loadAuthorizationFacts?: (client: PoolClient, input: { principal: Principal; scope: ScopeBinding; commandHash: string; dependencyEpoch: number }) => Promise<Pick<AuthorizationContext, "approvals" | "evidence"> | undefined>;
  buildEvents?: (body: Readonly<Record<string, JsonValue>>) => readonly JsonValue[] | Promise<readonly JsonValue[]>;
  /** Trusted test/configuration hook, never populated from command input. */
  fault?: (point: FaultPoint) => void | Promise<void>;
}

class Denied extends Error {
  constructor(readonly code: CommandError, readonly failedGuards?: string[]) { super(code); }
}
const failure = (error: CommandError, failedGuards?: string[]): CommandResult => ({ ok: false, error, retryable: error === "TRANSIENT_FAILURE", ...(failedGuards ? { failedGuards } : {}) });
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Denied("SCHEMA_INVALID");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) throw new Denied("SCHEMA_INVALID");
}
export function cloneJson(value: unknown): JsonValue {
  const seen = new Set<object>(); let nodes = 0;
  const copy = (v: unknown, depth: number): JsonValue => {
    if (++nodes > 20_000 || depth > 64) throw new Denied("SCHEMA_INVALID");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string" && v.isWellFormed()) return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "object" || !v || seen.has(v) || Object.getOwnPropertySymbols(v).length) throw new Denied("SCHEMA_INVALID");
    seen.add(v);
    let result: JsonValue;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) throw new Denied("SCHEMA_INVALID");
      result = Array.from(v, (item) => copy(item, depth + 1));
    } else {
      const record = object(v); const out: Record<string, JsonValue> = Object.create(null);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(record))) {
        if (!descriptor.enumerable || !("value" in descriptor) || !key.isWellFormed()) throw new Denied("SCHEMA_INVALID");
        out[key] = copy(descriptor.value, depth + 1);
      }
      result = out;
    }
    seen.delete(v); return result;
  };
  return copy(value, 0);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function canonicalHash(value: unknown): string {
  const text = canonicalize(cloneJson(value));
  if (typeof text !== "string" || text.length > 1_000_000) throw new Denied("SCHEMA_INVALID");
  return createHash("sha256").update(text).digest("hex");
}
function strings(value: unknown, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || !value.every(nonempty) || new Set(value).size !== value.length) throw new Denied("SCHEMA_INVALID");
  return [...value];
}
export function normalizeScope(value: unknown): ScopeBinding {
  const s = object(cloneJson(value));
  if (s.kind === "PROJECT_SCOPE") {
    keys(s, ["kind", "projectId", "scopeVersion", "evidenceVersionIds"]);
    if (!uuid(s.projectId) || !integer(s.scopeVersion)) throw new Denied("SCHEMA_INVALID");
    return { kind: s.kind, projectId: s.projectId, scopeVersion: Number(s.scopeVersion), evidenceVersionIds: strings(s.evidenceVersionIds).sort() };
  }
  if (s.kind === "PACKAGE_GATE") {
    keys(s, ["kind", "projectId", "packageId", "plotIds", "scopeVersion", "designRevision", "requirementSnapshotId", "evidenceVersionIds"]);
    if (!uuid(s.projectId) || !uuid(s.packageId) || !integer(s.scopeVersion) || !nonempty(s.designRevision) || !nonempty(s.requirementSnapshotId)) throw new Denied("SCHEMA_INVALID");
    return { kind: s.kind, projectId: s.projectId, packageId: s.packageId, plotIds: strings(s.plotIds, false).sort(), scopeVersion: Number(s.scopeVersion), designRevision: s.designRevision, requirementSnapshotId: s.requirementSnapshotId, evidenceVersionIds: strings(s.evidenceVersionIds).sort() };
  }
  if (s.kind === "PROVISIONAL_PLOT_SCOPE") {
    keys(s, ["kind", "provisionalCaseId", "plotIds", "intakeVersion", "initiatorAssignmentId", "sourceAssertionIds"]);
    if (!uuid(s.provisionalCaseId) || !integer(s.intakeVersion) || !nonempty(s.initiatorAssignmentId)) throw new Denied("SCHEMA_INVALID");
    return { kind: s.kind, provisionalCaseId: s.provisionalCaseId, plotIds: strings(s.plotIds, false).sort(), intakeVersion: Number(s.intakeVersion), initiatorAssignmentId: s.initiatorAssignmentId, sourceAssertionIds: strings(s.sourceAssertionIds).sort() };
  }
  throw new Denied("SCHEMA_INVALID");
}
function snapshotCommand(value: unknown): CommandEnvelope {
  const c = object(cloneJson(value));
  keys(c, ["commandId", "commandName", "aggregateId", "transitionId", "idempotencyKey", "contractVersion", "expected", "scope", "payload"]);
  const expected = object(c.expected); keys(expected, ["aggregateVersion", "dependencyEpoch"]);
  if (!uuid(c.commandId) || !uuid(c.aggregateId) || ![c.commandName, c.transitionId, c.idempotencyKey, c.contractVersion].every(nonempty) || !integer(expected.aggregateVersion) || !integer(expected.dependencyEpoch)) throw new Denied("SCHEMA_INVALID");
  return freeze({ ...c, expected, scope: normalizeScope(c.scope) }) as unknown as CommandEnvelope;
}
function semanticHash(c: CommandEnvelope) {
  return canonicalHash({ commandName: c.commandName, aggregateId: c.aggregateId, transitionId: c.transitionId,
    idempotencyKey: c.idempotencyKey, contractVersion: c.contractVersion, expected: c.expected, scope: c.scope, payload: c.payload });
}
const ROLES: Role[] = ["SYSTEM_ADMIN", "STAKEHOLDER_MANAGER", "AOR_LEAD", "THIRD_PARTY_INSPECTOR", "CLIENT_EXECUTIVE", "DISCIPLINE_LEAD", "CONTRACTOR", "SYSTEM"];
function validateRule(rule: TransitionRule): TransitionRule {
  if (![rule.id, rule.machineId, rule.event, rule.to].every(nonempty) || !["TRANSITION", "VALIDATE_EVIDENCE", "RECORD_STAMP"].includes(rule.operation)) throw new Error("INVALID_MACHINE_DEFINITIONS");
  strings(rule.from, false); strings(rule.roles, false); strings(rule.guards); strings(rule.effects);
  if (!rule.roles.every((role) => ROLES.includes(role))) throw new Error("INVALID_MACHINE_DEFINITIONS");
  for (const pair of rule.dualControlPairs ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((role) => rule.roles.includes(role))) throw new Error("INVALID_MACHINE_DEFINITIONS");
  }
  return freeze(structuredClone(rule));
}

/** Source metadata only. Domain guard/payload implementations are never fabricated. */
export function loadMachineDefinitions(path = resolve(process.cwd(), "docs/state-machines.yaml")): { version: string; transitions: readonly TransitionRule[] } {
  try {
    const doc = object(YAML.parse(readFileSync(path, "utf8")));
    if (doc.version !== "1.2") throw new Error();
    const machines = object(doc.machines);
    const policy = object(object(doc.behavioral_contract).evidence_validation);
    const rolePairs = object(policy.dual_control_role_pairs);
    const transitions: TransitionRule[] = [];
    for (const [machineId, rawMachine] of Object.entries(machines)) {
      const machine = object(rawMachine), states = object(machine.states);
      if (!nonempty(machine.initial) || !(machine.initial in states) || !Array.isArray(machine.transitions)) throw new Error();
      if (machine.terminal !== undefined && !strings(machine.terminal).every((state) => state in states)) throw new Error();
      for (const raw of machine.transitions) {
        const t = object(raw), from = strings(Array.isArray(t.from) ? t.from : [t.from], false);
        if (!nonempty(t.to) || !(t.to in states) || !from.every((state) => state in states) || !nonempty(t.id) || !nonempty(t.event)) throw new Error();
        const roles = strings(t.roles, false) as Role[], guards = strings(t.guards), effects = strings(t.effects ?? []);
        let pairs: [Role, Role][] | undefined;
        if (t.dual_control === true) {
          if (!Array.isArray(rolePairs[t.id]) || !(rolePairs[t.id] as unknown[]).length) throw new Error();
          pairs = rolePairs[t.id] as [Role, Role][];
        }
        const invalidatingEffects = new Set(["block_downstream", "block_downstream_permits", "block_downstream_until_revalidated",
          "flag_affected_cases", "flag_affected_cases_for_revalidation", "invalidate_dependency_epoch",
          "lock_step02", "lock_step02b", "lock_step04", "lock_step04_release", "lock_step05",
          "lock_structural_plan_review", "lock_inspection_tasks", "lock_soil_stamp",
          "recompute_dependent_gates", "version_bump"]);
        const material = invalidatingEffects.has(t.id) ||
          effects.some((effect) => invalidatingEffects.has(effect)) ||
          t.to === "DMP_AMENDMENT_REQUIRED" || t.to === "VALIDITY_EXPIRED" || t.to === "EXPIRED" ||
          t.to === "REJECTED_INFRASTRUCTURE_UNAVAILABLE" || t.to === "REOPENED" || t.to === "SUPERSEDED" ||
          t.id === "S11-T06" || t.id === "SM1-T07" || t.id === "SM1-T03" || t.id === "SM1-T05";
        transitions.push(validateRule({ id: t.id, machineId, event: t.event, from, to: t.to, roles, guards, effects,
          operation: t.id === "S10-T04" ? "VALIDATE_EVIDENCE" : t.id === "S2DS-T03" ? "RECORD_STAMP" : "TRANSITION",
          ...(pairs ? { dualControlPairs: pairs } : {}), invalidatesDependencies: material }));
      }
    }
    if (!transitions.length || new Set(transitions.map((t) => t.id)).size !== transitions.length) throw new Error();
    return freeze({ version: doc.version, transitions });
  } catch { throw new Error("INVALID_MACHINE_DEFINITIONS"); }
}

function principalValid(p: Principal | null, time: Date): p is Principal {
  return !!p && nonempty(p.actorId) && nonempty(p.tenantId) && Number.isFinite(Date.parse(p.expiresAt)) && Date.parse(p.expiresAt) > time.getTime();
}
function identityFingerprint(p: Principal) {
  return canonicalHash({ actorId: p.actorId, tenantId: p.tenantId, kind: p.kind,
    assignments: [...p.assignments].sort((a, b) => a.id.localeCompare(b.id)), serviceCapabilities: [...(p.serviceCapabilities ?? [])].sort() });
}
function advisoryKey(value: string) {
  return BigInt.asIntN(64, BigInt(`0x${createHash("sha256").update(value).digest("hex").slice(0, 16)}`)).toString();
}
interface AggregateRow { project_id: string; machine_id: string; contract_version: string; scope_hash: string; state: string; version: number; dependency_epoch: number }

export function createCommandEngine(options: EngineOptions) {
  if (!options.authorization || typeof options.authorization.resolve !== "function" || typeof options.authorization.authorize !== "function" || typeof options.clock !== "function") throw new Error("Trusted authorization and clock are required");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema)) throw new Error("INVALID_SCHEMA");
  const schema = options.schema;
  const registry = new Map(options.transitions.map((rule) => { const copy = validateRule(rule); return [copy.id, copy] as const; }));
  if (!registry.size || registry.size !== options.transitions.length) throw new Error("INVALID_MACHINE_DEFINITIONS");
  const guards = Object.freeze({ ...options.guards }), validators = Object.freeze({ ...options.payloadValidators });
  const authorization = Object.freeze({ resolve: options.authorization.resolve.bind(options.authorization), authorize: options.authorization.authorize.bind(options.authorization) });
  const readClock = options.clock, loadFacts = options.loadAuthorizationFacts, buildEvents = options.buildEvents, fault = options.fault;
  const pool = new Pool({ connectionString: options.connectionString, connectionTimeoutMillis: 3000, max: 10 });
  const q = (table: string) => `"${schema}".${table}`;
  const clock = () => { const time = new Date(readClock().getTime()); if (!Number.isFinite(time.getTime())) throw new Denied("TRANSIENT_FAILURE"); return time; };
  const evaluateGuards = async (rule: TransitionRule, command: CommandEnvelope, principal: Principal, transaction: PoolClient) => {
    const failed: string[] = [];
    for (const name of rule.guards) {
      try {
        if (!Object.hasOwn(guards, name) || await guards[name]({ payload: command.payload, principal, transaction, now: clock() }) !== true) failed.push(name);
      } catch { failed.push(name); }
    }
    if (failed.length) throw new Denied("GUARD_DENIED", failed);
  };
  const execute = async (credential: unknown, input: CommandEnvelope): Promise<CommandResult> => {
    let command: CommandEnvelope, rule: TransitionRule, commandHash: string;
    try {
      command = snapshotCommand(input);
      rule = registry.get(command.transitionId)!;
      if (!rule || rule.event !== command.commandName) return failure("STATE_CONFLICT");
      // Provisional intake creation/storage is a later domain slice, not a fake project binding.
      if (command.scope.kind === "PROVISIONAL_PLOT_SCOPE") return failure("GUARD_DENIED");
      commandHash = semanticHash(command);
    } catch { return failure("SCHEMA_INVALID"); }
    for (let attempt = 0; attempt < 3; attempt++) {
      let client: PoolClient | undefined;
      try {
        client = await pool.connect(); await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const initial = await authorization.resolve(credential, clock(), client);
        if (!principalValid(initial, clock())) throw new Denied("UNAUTHENTICATED");
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [advisoryKey(`${initial.tenantId}:${initial.actorId}:${command.idempotencyKey}`)]);
        const cached = await client.query<{ semantic_hash: string; result: CommandResult }>(`SELECT semantic_hash,result FROM ${q("idempotency_records")} WHERE tenant_id=$1 AND actor_id=$2 AND key=$3`, [initial.tenantId, initial.actorId, command.idempotencyKey]);
        if (cached.rows[0]) {
          if (cached.rows[0].semantic_hash !== commandHash) throw new Denied("IDEMPOTENCY_CONFLICT");
          const fresh = await authorization.resolve(credential, clock(), client);
          if (!principalValid(fresh, clock()) || fresh.actorId !== initial.actorId || fresh.tenantId !== initial.tenantId) throw new Denied("UNAUTHENTICATED");
          const decision = authorization.authorize(fresh, { transitionId: rule.id, scope: command.scope, mode: "REPLAY" }, clock());
          if (!decision.allowed) throw new Denied(decision.code);
          await client.query("COMMIT"); return { ...cached.rows[0].result, replayed: true } as CommandResult;
        }
        const validator = Object.hasOwn(validators, rule.id) ? validators[rule.id] : undefined;
        if (!validator) throw new Denied("GUARD_DENIED");
        let payloadValid: unknown;
        try { payloadValid = validator(command.payload); } catch { throw new Denied("SCHEMA_INVALID"); }
        if (payloadValid !== true) throw new Denied("GUARD_DENIED");
        const header = await client.query<{ project_id: string }>(`SELECT project_id FROM ${q("aggregates")} WHERE tenant_id=$1 AND aggregate_id=$2`, [initial.tenantId, command.aggregateId]);
        if (!header.rows[0]) throw new Denied("FORBIDDEN");
        const projectId = header.rows[0].project_id;
        const project = await client.query<{ dependency_epoch: number }>(`SELECT dependency_epoch FROM ${q("projects")} WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE`, [initial.tenantId, projectId]);
        if (!project.rows[0]) throw new Denied("FORBIDDEN");
        const result = await client.query<AggregateRow>(`SELECT * FROM ${q("aggregates")} WHERE tenant_id=$1 AND aggregate_id=$2 FOR UPDATE`, [initial.tenantId, command.aggregateId]);
        const aggregate = result.rows[0], epoch = project.rows[0].dependency_epoch;
        if (!aggregate || aggregate.project_id !== projectId) throw new Denied("FORBIDDEN");
        if (aggregate.scope_hash !== canonicalHash(command.scope) || aggregate.machine_id !== rule.machineId || aggregate.contract_version !== command.contractVersion) throw new Denied("FORBIDDEN");
        if (aggregate.version !== command.expected.aggregateVersion) throw new Denied("VERSION_CONFLICT");
        if (epoch !== command.expected.dependencyEpoch || aggregate.dependency_epoch !== epoch) throw new Denied("DEPENDENCY_STALE");
        if (!rule.from.includes(aggregate.state)) throw new Denied("STATE_CONFLICT");
        const locked = await authorization.resolve(credential, clock(), client);
        if (!principalValid(locked, clock()) || locked.actorId !== initial.actorId || locked.tenantId !== initial.tenantId) throw new Denied("UNAUTHENTICATED");
        const access = authorization.authorize(locked, { transitionId: rule.id, scope: command.scope, mode: "REPLAY" }, clock());
        if (!access.allowed) throw new Denied(access.code);
        await evaluateGuards(rule, command, locked, client);
        const fresh = await authorization.resolve(credential, clock(), client);
        if (!principalValid(fresh, clock()) || fresh.actorId !== initial.actorId || fresh.tenantId !== initial.tenantId) throw new Denied("UNAUTHENTICATED");
        if (identityFingerprint(fresh) !== identityFingerprint(locked)) throw new Denied("FORBIDDEN");
        const facts = await loadFacts?.(client, { principal: fresh, scope: command.scope, commandHash, dependencyEpoch: epoch });
        const context: AuthorizationContext = { ...facts, commandHash, scopeHash: canonicalHash(command.scope), dependencyEpoch: epoch };
        const decision = authorization.authorize(fresh, { transitionId: rule.id, scope: command.scope, context, mode: "EXECUTE" }, clock());
        if (!decision.allowed) throw new Denied(decision.code);
        const version = aggregate.version + 1, time = clock();
        const newEpoch = rule.invalidatesDependencies ? epoch + 1 : epoch;
        const body: Record<string, JsonValue> = freeze({ commandId: command.commandId, commandName: command.commandName, aggregateId: command.aggregateId,
          transitionId: rule.id, from: aggregate.state, to: rule.to, version, scope: cloneJson(command.scope), dependencyEpoch: newEpoch,
          payload: command.payload, actorId: fresh.actorId, tenantId: fresh.tenantId, occurredAt: time.toISOString(), contractVersion: command.contractVersion });
        const generated = buildEvents ? await buildEvents(body) : [{}];
        if (!Array.isArray(generated) || !generated.length || generated.length > 100) throw new Denied("SCHEMA_INVALID");
        const eventPayloads = generated.map((item) => cloneJson(item));
        await client.query(`UPDATE ${q("aggregates")} SET state=$1,version=$2,dependency_epoch=$3 WHERE tenant_id=$4 AND aggregate_id=$5`, [rule.to, version, newEpoch, fresh.tenantId, command.aggregateId]); await fault?.("state");
        if (rule.invalidatesDependencies) {
          await client.query(`UPDATE ${q("projects")} SET dependency_epoch=$1 WHERE tenant_id=$2 AND project_id=$3`, [newEpoch, fresh.tenantId, projectId]); await fault?.("epoch");
        }
        await client.query(`INSERT INTO ${q("transition_commits")} (id,tenant_id,aggregate_id,version,transition_id,actor_id,at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), fresh.tenantId, command.aggregateId, version, rule.id, fresh.actorId, time]); await fault?.("commit");
        const eventIds: string[] = [];
        for (const [index, data] of eventPayloads.entries()) {
          const eventId = randomUUID(); eventIds.push(eventId);
          await client.query(`INSERT INTO ${q("command_events")} (id,tenant_id,aggregate_id,version,sequence,body) VALUES ($1,$2,$3,$4,$5,$6)`, [eventId, fresh.tenantId, command.aggregateId, version, index + 1, { ...body, eventId, eventType: rule.event, schemaVersion: 1, producerId: rule.id, data }]); await fault?.("event");
        }
        const previous = await client.query<{ entry_hash: string }>(`SELECT entry_hash FROM ${q("audit_ledger")} WHERE tenant_id=$1 AND aggregate_id=$2 ORDER BY version DESC LIMIT 1`, [fresh.tenantId, command.aggregateId]);
        const previousHash = previous.rows[0]?.entry_hash ?? null;
        const auditBody = { ...body, eventIds, commandHash };
        await client.query(`INSERT INTO ${q("audit_ledger")} (id,tenant_id,aggregate_id,version,body,previous_hash,entry_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), fresh.tenantId, command.aggregateId, version, auditBody, previousHash, canonicalHash({ previousHash, body: auditBody }), time]); await fault?.("ledger");
        for (const eventId of eventIds) {
          await client.query(`INSERT INTO ${q("command_outbox")} (id,event_id,body,created_at) SELECT $1,id,body,$3 FROM ${q("command_events")} WHERE id=$2`, [randomUUID(), eventId, time]); await fault?.("outbox");
        }
        const success: CommandResult = { ok: true, aggregateVersion: version, state: rule.to, eventIds, replayed: false };
        await client.query(`INSERT INTO ${q("idempotency_records")} (tenant_id,actor_id,key,semantic_hash,result,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [fresh.tenantId, fresh.actorId, command.idempotencyKey, commandHash, success, time]); await fault?.("idempotency");
        // Final clock/assignment/evidence check: late revocation rolls every success write back.
        const atCommit = await authorization.resolve(credential, clock(), client);
        if (!principalValid(atCommit, clock()) || identityFingerprint(atCommit) !== identityFingerprint(locked)) throw new Denied("UNAUTHENTICATED");
        const finalFacts = await loadFacts?.(client, { principal: atCommit, scope: command.scope, commandHash, dependencyEpoch: epoch });
        const finalDecision = authorization.authorize(atCommit, { transitionId: rule.id, scope: command.scope,
          context: { ...finalFacts, commandHash, scopeHash: context.scopeHash, dependencyEpoch: epoch }, mode: "EXECUTE" }, clock());
        if (!finalDecision.allowed) throw new Denied(finalDecision.code);
        await evaluateGuards(rule, command, atCommit, client);
        await client.query("COMMIT"); return success;
      } catch (error: unknown) {
        await client?.query("ROLLBACK").catch(() => undefined);
        if (error instanceof Denied) return failure(error.code, error.failedGuards);
        const sqlError = error as { code?: string; constraint?: string };
        const retry = sqlError?.code === "40001" || sqlError?.code === "40P01" ||
          (sqlError?.code === "23505" && sqlError.constraint === "idempotency_records_pkey");
        if (!retry || attempt === 2) return failure("TRANSIENT_FAILURE");
      } finally { client?.release(); }
    }
    return failure("TRANSIENT_FAILURE");
  };
  return { execute, initialize: () => migrateCommandSchema(pool, schema), close: () => pool.end() };
}
