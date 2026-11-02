import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
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

export interface CommentServiceOptions {
  connectionString: string;
  schema: string;
  authorization: AuthorizationPort;
  clock: () => Date;
}

export interface CommentServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createComment(
    credential: unknown,
    input: { aggregateId: string; projectId: string; scope: ScopeBinding },
  ): Promise<void>;
  transitionComment(
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
const DOMAIN_TRANSITIONS = ALL_TRANSITIONS.filter((t) => t.machineId === "SM_5_comment");
const RULE_BY_ID = new Map(DOMAIN_TRANSITIONS.map((r) => [r.id, r] as const));

const asRecord = (payload: JsonValue): Record<string, JsonValue> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

export function createCommentService(options: CommentServiceOptions): CommentServicePort {
  const { connectionString, schema, authorization, clock } = options;
  const pool = new Pool({ connectionString, max: 6 });
  let retryNonce = 0;

  const guards: Record<string, (input: { payload: JsonValue }) => unknown> = {
    category_assigned: ({ payload }) => asRecord(payload).categoryAssigned === true,
    discipline_assigned: ({ payload }) => asRecord(payload).disciplineAssigned === true,
    owner_assigned: ({ payload }) => asRecord(payload).ownerAssigned === true,
    due_date_set: ({ payload }) => nonEmptyStr(asRecord(payload).dueDateSet),
    response_text_entered: ({ payload }) => nonEmptyStr(asRecord(payload).responseTextEntered),
    revised_drawing_uploaded: ({ payload }) => asRecord(payload).revisedDrawingUploaded === true,
    stamped_revision_present_if_structural: ({ payload }) =>
      asRecord(payload).stampedRevisionPresentIfStructural === true,
    discipline_lead_approval: ({ payload }) => asRecord(payload).disciplineLeadApproval === true,
    bundle_submitted: ({ payload }) => asRecord(payload).bundleSubmitted === true,
    submission_receipt_captured: ({ payload }) => asRecord(payload).submissionReceiptCaptured === true,
    authority_closure_evidence_captured: ({ payload }) =>
      asRecord(payload).authorityClosureEvidenceCaptured === true,
    authority_rejection_evidence_captured: ({ payload }) =>
      asRecord(payload).authorityRejectionEvidenceCaptured === true,
    dispute_reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).disputeReasonRecorded),
    resolution_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).resolutionRecorded),
    reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).reasonRecorded),
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

    async createComment(credential, input) {
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
        ) VALUES ($1, $2, $3, 'SM_5_comment', $4, $5::jsonb, $6, 'NEW', 0, $7)`,
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

    async transitionComment(credential, input) {
      const rule = RULE_BY_ID.get(input.transitionId);
      if (!rule) throw new Error(`Unknown SM_5_comment transition ${input.transitionId}`);
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
