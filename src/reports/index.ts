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
import { computeAbuDhabiBusinessDays } from "../jobs";

export function computeDeterministicKpis(
  items: readonly {
    entityId: string;
    status: string;
    submittedAt: string | null;
    approvedAt: string | null;
  }[],
): {
  readonly snapshotHash: string;
  readonly durationsByEntity: Readonly<Record<string, number | "UNKNOWN_DURATION">>;
  readonly conflictQuarantinedCount: number;
} {
  const durationsByEntity: Record<string, number | "UNKNOWN_DURATION"> = {};
  let conflictQuarantinedCount = 0;

  const sorted = [...items].sort((a, b) => a.entityId.localeCompare(b.entityId));
  for (const item of sorted) {
    if (item.status.includes("CONFLICT")) {
      conflictQuarantinedCount += 1;
    }
    const bdays = computeAbuDhabiBusinessDays(item.submittedAt, item.approvedAt, []);
    durationsByEntity[item.entityId] = bdays === null ? "UNKNOWN_DURATION" : bdays;
  }

  const snapshotHash = canonicalHash({
    durationsByEntity,
    conflictQuarantinedCount,
    items: sorted,
  });

  return Object.freeze({
    snapshotHash,
    durationsByEntity: Object.freeze(durationsByEntity),
    conflictQuarantinedCount,
  });
}

export interface ReportServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createReport(
    credential: unknown,
    input: { aggregateId: string; projectId: string; templateVersion: string; scope: ScopeBinding },
  ): Promise<void>;
  transitionReport(
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
const DOMAIN_TRANSITIONS = ALL_TRANSITIONS.filter((t) => t.machineId === "SM_9_report");
const RULE_BY_ID = new Map(DOMAIN_TRANSITIONS.map((r) => [r.id, r] as const));

const asRecord = (payload: JsonValue): Record<string, JsonValue> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

export function createReportService(options: {
  connectionString: string;
  schema: string;
  authorization: AuthorizationPort;
  clock: () => Date;
}): ReportServicePort {
  const { connectionString, schema, authorization, clock } = options;
  const pool = new Pool({ connectionString, max: 6 });
  let retryNonce = 0;

  const guards: Record<string, (input: { payload: JsonValue }) => unknown> = {
    template_version_resolved: ({ payload }) => asRecord(payload).templateVersionResolved === true,
    data_snapshot_created: ({ payload }) => asRecord(payload).dataSnapshotCreated === true,
    render_succeeded: ({ payload }) => asRecord(payload).renderSucceeded === true,
    snapshot_hash_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).snapshotHashRecorded),
    approver_recorded: ({ payload }) => asRecord(payload).approverRecorded === true,
    distribution_list_resolved: ({ payload }) => asRecord(payload).distributionListResolved === true,
    reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).reasonRecorded),
    render_error_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).renderErrorRecorded),
    retry_budget_available: ({ payload }) => asRecord(payload).retryBudgetAvailable === true,
    newer_report_published: ({ payload }) => asRecord(payload).newerReportPublished === true,
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
    },

    async close() {
      await engine.close();
      await pool.end();
    },

    async createReport(credential, input) {
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
        ) VALUES ($1, $2, $3, 'SM_9_report', $4, $5::jsonb, $6, 'REQUESTED', 0, $7)`,
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

    async transitionReport(credential, input) {
      const rule = RULE_BY_ID.get(input.transitionId);
      if (!rule) throw new Error(`Unknown SM_9_report transition ${input.transitionId}`);
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
