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

export interface BundleServiceOptions {
  connectionString: string;
  schema: string;
  authorization: AuthorizationPort;
  clock: () => Date;
}

export interface BundleServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createBundle(
    credential: unknown,
    input: { aggregateId: string; projectId: string; scope: ScopeBinding },
  ): Promise<void>;
  transitionBundle(
    credential: unknown,
    input: {
      aggregateId: string;
      transitionId: string;
      scope: ScopeBinding;
      payload: Record<string, JsonValue>;
    },
  ): Promise<CommandResult>;
  getBundleRevisions(aggregateId: string): Promise<readonly number[]>;
}

const { version: CONTRACT_VERSION, transitions: ALL_TRANSITIONS } = loadMachineDefinitions();
const DOMAIN_TRANSITIONS = ALL_TRANSITIONS.filter((t) => t.machineId === "SM_6_bundle");
const RULE_BY_ID = new Map(DOMAIN_TRANSITIONS.map((r) => [r.id, r] as const));

const asRecord = (payload: JsonValue): Record<string, JsonValue> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

export function createBundleService(options: BundleServiceOptions): BundleServicePort {
  const { connectionString, schema, authorization, clock } = options;
  const pool = new Pool({ connectionString, max: 6 });
  let retryNonce = 0;

  const guards: Record<string, (input: { payload: JsonValue }) => unknown> = {
    all_items_added: ({ payload }) => asRecord(payload).allItemsAdded === true,
    all_items_validated: ({ payload }) => asRecord(payload).allItemsValidated === true,
    no_open_blocker: ({ payload }) => asRecord(payload).noOpenBlocker === true,
    bundle_hash_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).bundleHashRecorded),
    authorized_signatory: ({ payload }) => asRecord(payload).authorizedSignatory === true,
    return_reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).returnReasonRecorded),
    submission_receipt_captured: ({ payload }) => asRecord(payload).submissionReceiptCaptured === true,
    acknowledgement_captured: ({ payload }) => asRecord(payload).acknowledgementCaptured === true,
    authority_review_started: ({ payload }) => asRecord(payload).authorityReviewStarted === true,
    approval_evidence_captured: ({ payload }) => asRecord(payload).approvalEvidenceCaptured === true,
    comments_linked: ({ payload }) => asRecord(payload).commentsLinked === true,
    rejection_reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).rejectionReasonRecorded),
    new_revision_created: ({ payload }) => asRecord(payload).newRevisionCreated === true,
    reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).reasonRecorded),
    replacement_bundle_recorded: ({ payload }) => asRecord(payload).replacementBundleRecorded === true,
    closure_evidence_captured: ({ payload }) => asRecord(payload).closureEvidenceCaptured === true,
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
        CREATE TABLE IF NOT EXISTS "${schema}".bundle_revisions (
          bundle_id uuid NOT NULL,
          revision integer NOT NULL CHECK (revision > 0),
          created_at timestamptz NOT NULL,
          PRIMARY KEY (bundle_id, revision)
        );
      `);
    },

    async close() {
      await engine.close();
      await pool.end();
    },

    async createBundle(credential, input) {
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
        ) VALUES ($1, $2, $3, 'SM_6_bundle', $4, $5::jsonb, $6, 'DRAFT', 0, $7)`,
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
      await pool.query(
        `INSERT INTO "${schema}".bundle_revisions (bundle_id, revision, created_at) VALUES ($1, 1, $2)`,
        [input.aggregateId, clock().toISOString()],
      );
    },

    async transitionBundle(credential, input) {
      const rule = RULE_BY_ID.get(input.transitionId);
      if (!rule) throw new Error(`Unknown SM_6_bundle transition ${input.transitionId}`);
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
      if (!result.ok) {
        retryNonce += 1;
      } else {
        retryNonce = 0;
        if (input.transitionId === "S6-T10") {
          const revRes = await pool.query<{ max_rev: number | null }>(
            `SELECT MAX(revision) AS max_rev FROM "${schema}".bundle_revisions WHERE bundle_id = $1`,
            [input.aggregateId],
          );
          const nextRev = (revRes.rows[0]?.max_rev ?? 1) + 1;
          await pool.query(
            `INSERT INTO "${schema}".bundle_revisions (bundle_id, revision, created_at) VALUES ($1, $2, $3)`,
            [input.aggregateId, nextRev, clock().toISOString()],
          );
        }
      }
      return result;
    },

    async getBundleRevisions(aggregateId) {
      const res = await pool.query<{ revision: number }>(
        `SELECT revision FROM "${schema}".bundle_revisions WHERE bundle_id = $1 ORDER BY revision ASC`,
        [aggregateId],
      );
      return Object.freeze(res.rows.map((r) => r.revision));
    },
  };
}
