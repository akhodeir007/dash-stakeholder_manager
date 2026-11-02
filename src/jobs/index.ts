import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
  AuthorizationPort,
  JsonValue,
  ScopeBinding,
} from "../contracts/foundation";
import {
  canonicalHash,
  createCommandEngine,
  loadMachineDefinitions,
  normalizeScope,
  type CommandEnvelope,
  type CommandResult,
} from "../domain/commands/engine";

/**
 * Abu Dhabi business calendar (Asia/Dubai UTC+4, Mon-Fri workdays, Sat/Sun weekend).
 * Returns null if either timestamp is null/invalid so unknown dates never fabricate 0 duration.
 */
export function computeAbuDhabiBusinessDays(
  startIso: string | null,
  endIso: string | null,
  holidays: readonly string[] = [],
): number | null {
  if (!startIso || !endIso) return null;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;

  const holidaySet = new Set(holidays);
  const dubaiOffsetMs = 4 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const startDay = Math.floor((startMs + dubaiOffsetMs) / dayMs);
  const endDay = Math.floor((endMs + dubaiOffsetMs) / dayMs);

  let businessDays = 0;
  for (let d = startDay + 1; d <= endDay; d++) {
    const dt = new Date(d * dayMs);
    const dow = dt.getUTCDay(); // 0=Sun, 6=Sat
    const dateKey = dt.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(dateKey)) {
      businessDays += 1;
    }
  }
  return businessDays;
}

export interface EscalationServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  evaluateEscalationRules(
    credential: unknown,
    input: {
      projectId: string;
      businessDate: string;
      scope: ScopeBinding;
      candidates: readonly {
        ruleId: "RULE_1" | "RULE_2" | "RULE_3" | "RULE_4";
        entityId: string;
        conditionMet: boolean;
      }[];
    },
  ): Promise<{ createdCount: number; dedupedCount: number; escalationIds: readonly string[] }>;
  transitionEscalation(
    credential: unknown,
    input: {
      aggregateId: string;
      transitionId: string;
      scope: ScopeBinding;
      payload: Record<string, JsonValue>;
    },
  ): Promise<CommandResult>;
}

const { version: CONTRACT_VERSION, transitions: ALL_TRANSITIONS } = loadMachineDefinitions();
const DOMAIN_TRANSITIONS = ALL_TRANSITIONS.filter((t) => t.machineId === "SM_8_escalation");
const RULE_BY_ID = new Map(DOMAIN_TRANSITIONS.map((r) => [r.id, r] as const));

const asRecord = (payload: JsonValue): Record<string, JsonValue> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

export function createEscalationService(options: {
  connectionString: string;
  schema: string;
  authorization: AuthorizationPort;
  clock: () => Date;
}): EscalationServicePort {
  const { connectionString, schema, authorization, clock } = options;
  const pool = new Pool({ connectionString, max: 6 });
  let retryNonce = 0;

  const guards: Record<string, (input: { payload: JsonValue }) => unknown> = {
    dedupe_key_unique: ({ payload }) => asRecord(payload).dedupeKeyUnique === true,
    recipient_resolved: ({ payload }) => asRecord(payload).recipientResolved === true,
    template_rendered: ({ payload }) => asRecord(payload).templateRendered === true,
    delivery_webhook_received: ({ payload }) => asRecord(payload).deliveryWebhookReceived === true,
    acknowledgment_recorded: ({ payload }) => asRecord(payload).acknowledgmentRecorded === true,
    acknowledgment_deadline_passed: ({ payload }) => asRecord(payload).acknowledgmentDeadlinePassed === true,
    next_level_resolved: ({ payload }) => asRecord(payload).nextLevelResolved === true,
    delivery_failed: ({ payload }) => asRecord(payload).deliveryFailed === true,
    retry_budget_available: ({ payload }) => asRecord(payload).retryBudgetAvailable === true,
    condition_resolved_or_acknowledged: ({ payload }) =>
      asRecord(payload).conditionResolvedOrAcknowledged === true,
  };

  const payloadValidators: Record<string, (payload: JsonValue) => boolean> = Object.fromEntries(
    DOMAIN_TRANSITIONS.map((t) => [t.id, (p: JsonValue) => typeof p === "object" && p !== null && !Array.isArray(p)]),
  );

  const engine = createCommandEngine({
    connectionString,
    schema,
    authorization,
    transitions: ALL_TRANSITIONS,
    guards,
    payloadValidators,
    clock,
  });

  async function getAggregateExpected(aggregateId: string): Promise<{ version: number; epoch: number }> {
    const res = await pool.query<{ version: number; project_id: string; tenant_id: string }>(
      `SELECT version, project_id, tenant_id FROM "${schema}".aggregates WHERE aggregate_id = $1 LIMIT 1`,
      [aggregateId],
    );
    if (res.rowCount === 0) return { version: 0, epoch: 0 };
    const { version, project_id, tenant_id } = res.rows[0];
    const proj = await pool.query<{ dependency_epoch: number }>(
      `SELECT dependency_epoch FROM "${schema}".projects WHERE tenant_id = $1 AND project_id = $2`,
      [tenant_id, project_id],
    );
    const epoch = proj.rows[0]?.dependency_epoch ?? 0;
    await pool.query(
      `UPDATE "${schema}".aggregates SET dependency_epoch = $1 WHERE tenant_id = $2 AND aggregate_id = $3`,
      [epoch, tenant_id, aggregateId],
    );
    return { version, epoch };
  }

  return {
    async initialize() {
      await engine.initialize();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "${schema}".escalation_dedupe (
          tenant_id text NOT NULL,
          dedupe_key text NOT NULL,
          escalation_id uuid NOT NULL,
          created_at timestamptz NOT NULL,
          PRIMARY KEY (tenant_id, dedupe_key)
        );
      `);
    },

    async close() {
      await engine.close();
      await pool.end();
    },

    async evaluateEscalationRules(credential, input) {
      const principal = await authorization.resolve(credential, clock());
      if (!principal) throw new Error("UNAUTHENTICATED");
      const normScope = normalizeScope(input.scope);
      const scopeHash = canonicalHash(normScope);

      await pool.query(
        `INSERT INTO "${schema}".projects (tenant_id, project_id, dependency_epoch)
         VALUES ($1, $2, 0)
         ON CONFLICT (tenant_id, project_id) DO NOTHING`,
        [principal.tenantId, input.projectId],
      );
      const projRes = await pool.query<{ dependency_epoch: number }>(
        `SELECT dependency_epoch FROM "${schema}".projects WHERE tenant_id = $1 AND project_id = $2`,
        [principal.tenantId, input.projectId],
      );
      const epoch = projRes.rows[0]?.dependency_epoch ?? 0;

      let createdCount = 0;
      let dedupedCount = 0;
      const escalationIds: string[] = [];

      for (const cand of input.candidates) {
        if (!cand.conditionMet) continue;
        const dedupeKey = `${cand.ruleId}:${cand.entityId}:${input.businessDate}`;
        const existing = await pool.query<{ escalation_id: string }>(
          `SELECT escalation_id FROM "${schema}".escalation_dedupe WHERE tenant_id = $1 AND dedupe_key = $2`,
          [principal.tenantId, dedupeKey],
        );
        if ((existing.rowCount ?? 0) > 0) {
          dedupedCount += 1;
          escalationIds.push(existing.rows[0].escalation_id);
          continue;
        }
        const escId = randomUUID();
        await pool.query(
          `INSERT INTO "${schema}".escalation_dedupe (tenant_id, dedupe_key, escalation_id, created_at)
           VALUES ($1, $2, $3, $4)`,
          [principal.tenantId, dedupeKey, escId, clock().toISOString()],
        );
        await pool.query(
          `INSERT INTO "${schema}".aggregates (
            tenant_id, aggregate_id, project_id, machine_id, contract_version, scope, scope_hash, state, version, dependency_epoch
          ) VALUES ($1, $2, $3, 'SM_8_escalation', $4, $5::jsonb, $6, 'PENDING', 0, $7)`,
          [
            principal.tenantId,
            escId,
            input.projectId,
            CONTRACT_VERSION,
            JSON.stringify(normScope),
            scopeHash,
            epoch,
          ],
        );
        createdCount += 1;
        escalationIds.push(escId);
      }
      return { createdCount, dedupedCount, escalationIds: Object.freeze(escalationIds) };
    },

    async transitionEscalation(credential, input) {
      const rule = RULE_BY_ID.get(input.transitionId);
      if (!rule) throw new Error(`Unknown SM_8_escalation transition ${input.transitionId}`);
      const { version, epoch } = await getAggregateExpected(input.aggregateId);
      const normScope = normalizeScope(input.scope);
      const envelope: CommandEnvelope = {
        commandId: randomUUID(),
        commandName: rule.event,
        aggregateId: input.aggregateId,
        transitionId: rule.id,
        idempotencyKey: `${input.aggregateId}:${rule.id}:v${version}:e${epoch}:n${retryNonce}`,
        contractVersion: CONTRACT_VERSION,
        expected: { aggregateVersion: version, dependencyEpoch: epoch },
        scope: normScope,
        payload: input.payload,
      };
      const result = await engine.execute(credential, envelope);
      if (!result.ok) retryNonce += 1;
      else retryNonce = 0;
      return result;
    },
  };
}
