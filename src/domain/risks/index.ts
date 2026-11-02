import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
  ApprovalFact,
  AuthorizationPort,
  JsonValue,
  ScopeBinding,
} from "../../contracts/foundation";
import {
  canonicalHash,
  createCommandEngine,
  loadMachineDefinitions,
  normalizeScope,
  type CommandEnvelope,
  type CommandResult,
} from "../commands/engine";

export interface RiskServiceOptions {
  connectionString: string;
  schema: string;
  authorization: AuthorizationPort;
  clock: () => Date;
}

export interface RiskServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createRisk(
    credential: unknown,
    input: { aggregateId: string; projectId: string; scope: ScopeBinding },
  ): Promise<void>;
  transitionRisk(
    credential: unknown,
    input: {
      aggregateId: string;
      transitionId: string;
      scope: ScopeBinding;
      payload: Record<string, JsonValue>;
      approvals?: readonly ApprovalFact[];
    },
  ): Promise<CommandResult>;
  computeDualControlBinding(input: {
    aggregateId: string;
    transitionId: string;
    scope: ScopeBinding;
    payload: Record<string, JsonValue>;
  }): Promise<{ commandHash: string; scopeHash: string; dependencyEpoch: number }>;
}

const { version: CONTRACT_VERSION, transitions: ALL_TRANSITIONS } = loadMachineDefinitions();
const DOMAIN_TRANSITIONS = ALL_TRANSITIONS.filter((t) => t.machineId === "SM_7_risk");
const RULE_BY_ID = new Map(DOMAIN_TRANSITIONS.map((r) => [r.id, r] as const));

const asRecord = (payload: JsonValue): Record<string, JsonValue> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const validDateStr = (v: unknown): boolean =>
  typeof v === "string" && v.trim().length > 0 && Number.isFinite(Date.parse(v));

export function createRiskService(options: RiskServiceOptions): RiskServicePort {
  const { connectionString, schema, authorization, clock } = options;
  const pool = new Pool({ connectionString, max: 6 });
  let pendingApprovals: readonly ApprovalFact[] | undefined;
  let retryNonce = 0;

  const guards: Record<string, (input: { payload: JsonValue }) => unknown> = {
    severity_assigned: ({ payload }) =>
      ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(String(asRecord(payload).severityAssigned ?? "")),
    owner_assigned: ({ payload }) => nonEmptyStr(asRecord(payload).ownerAssigned),
    decision_due_date_set: ({ payload }) => validDateStr(asRecord(payload).decisionDueDateSet),
    mitigation_plan_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).mitigationPlanRecorded),
    escalation_level_assigned: ({ payload }) => nonEmptyStr(asRecord(payload).escalationLevelAssigned),
    escalation_reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).escalationReasonRecorded),
    escalation_resolved: ({ payload }) => asRecord(payload).escalationResolved === true,
    reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).reasonRecorded),
    resolution_evidence_captured: ({ payload }) => asRecord(payload).resolutionEvidenceCaptured === true,
    closure_approved: ({ payload }) => asRecord(payload).closureApproved === true,
    executive_approval_recorded: ({ payload }) => asRecord(payload).executiveApprovalRecorded === true,
    review_date_recorded: ({ payload }) => validDateStr(asRecord(payload).reviewDateRecorded),
    rationale_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).rationaleRecorded),
    review_date_reached_or_conditions_changed: ({ payload }) =>
      asRecord(payload).reviewDateReachedOrConditionsChanged === true,
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
    loadAuthorizationFacts: async () => (pendingApprovals ? { approvals: pendingApprovals } : undefined),
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

  async function buildEnvelope(input: {
    aggregateId: string;
    transitionId: string;
    scope: ScopeBinding;
    payload: Record<string, JsonValue>;
  }): Promise<CommandEnvelope> {
    const rule = RULE_BY_ID.get(input.transitionId);
    if (!rule) throw new Error(`Unknown SM_7_risk transition ${input.transitionId}`);
    const { version, epoch } = await getAggregateExpected(input.aggregateId);
    const normScope = normalizeScope(input.scope);
    return {
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
  }

  return {
    async initialize() {
      await engine.initialize();
    },

    async close() {
      await engine.close();
      await pool.end();
    },

    async createRisk(credential, input) {
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
      await pool.query(
        `INSERT INTO "${schema}".aggregates (
          tenant_id, aggregate_id, project_id, machine_id, contract_version, scope, scope_hash, state, version, dependency_epoch
        ) VALUES ($1, $2, $3, 'SM_7_risk', $4, $5::jsonb, $6, 'OPEN', 0, $7)`,
        [
          principal.tenantId,
          input.aggregateId,
          input.projectId,
          CONTRACT_VERSION,
          JSON.stringify(normScope),
          scopeHash,
          epoch,
        ],
      );
    },

    async transitionRisk(credential, input) {
      const envelope = await buildEnvelope(input);
      pendingApprovals = input.approvals;
      try {
        const result = await engine.execute(credential, envelope);
        if (!result.ok) retryNonce += 1;
        else retryNonce = 0;
        return result;
      } finally {
        pendingApprovals = undefined;
      }
    },

    async computeDualControlBinding(input) {
      const env = await buildEnvelope(input);
      const commandHash = canonicalHash({
        commandName: env.commandName,
        aggregateId: env.aggregateId,
        transitionId: env.transitionId,
        idempotencyKey: env.idempotencyKey,
        contractVersion: env.contractVersion,
        expected: env.expected,
        scope: env.scope,
        payload: env.payload,
      });
      const scopeHash = canonicalHash(env.scope);
      return {
        commandHash,
        scopeHash,
        dependencyEpoch: env.expected.dependencyEpoch,
      };
    },
  };
}
