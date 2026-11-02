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

export interface MasterplanServiceOptions {
  connectionString: string;
  schema: string;
  authorization: AuthorizationPort;
  clock: () => Date;
}

export interface MasterplanServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createMasterplan(
    credential: unknown,
    input: {
      aggregateId: string;
      projectId: string;
      scope: ScopeBinding;
      certificateRef: string;
      dmtCorrespondenceRef: string;
      validUntil: string;
    },
  ): Promise<void>;
  createCondition(
    credential: unknown,
    input: {
      aggregateId: string;
      masterplanId: string;
      projectId: string;
      conditionNumber: number;
      scope: ScopeBinding;
    },
  ): Promise<void>;
  createBaselineChangeRequest(
    credential: unknown,
    input: {
      aggregateId: string;
      projectId: string;
      scope: ScopeBinding;
    },
  ): Promise<void>;
  transitionMasterplan(
    credential: unknown,
    input: {
      aggregateId: string;
      transitionId: string;
      scope: ScopeBinding;
      payload: Record<string, JsonValue>;
      approvals?: readonly ApprovalFact[];
    },
  ): Promise<CommandResult>;
  transitionCondition(
    credential: unknown,
    input: {
      aggregateId: string;
      transitionId: string;
      scope: ScopeBinding;
      payload: Record<string, JsonValue>;
      approvals?: readonly ApprovalFact[];
    },
  ): Promise<CommandResult>;
  transitionBaselineChange(
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
    commandName: string;
    scope: ScopeBinding;
    payload: Record<string, JsonValue>;
  }): Promise<{ commandHash: string; scopeHash: string; dependencyEpoch: number }>;
  seedAcceptedConditionsForTest(masterplanId: string, count: number): Promise<void>;
  getProjectEpoch(projectId: string): Promise<number>;
}

const { version: CONTRACT_VERSION, transitions: ALL_TRANSITIONS } = loadMachineDefinitions();
const DOMAIN_TRANSITIONS = ALL_TRANSITIONS.filter((t) =>
  ["SM_1_masterplan", "SM_1_condition", "SM_11_baseline_change"].includes(t.machineId),
);
const RULE_BY_ID = new Map(DOMAIN_TRANSITIONS.map((r) => [r.id, r] as const));

const asRecord = (payload: JsonValue): Record<string, JsonValue> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

export function createMasterplanService(options: MasterplanServiceOptions): MasterplanServicePort {
  const { connectionString, schema, authorization, clock } = options;
  const pool = new Pool({ connectionString, max: 6 });
  let pendingApprovals: readonly ApprovalFact[] | undefined;
  let activeAggregateId = "";
  let retryNonce = 0;

  const guards: Record<
    string,
    (input: { payload: JsonValue; transaction: import("pg").PoolClient; now: Date }) => unknown | Promise<unknown>
  > = {
    // SM_1_masterplan guards
    submission_package_complete: ({ payload }) => asRecord(payload).submissionPackageComplete === true,
    dmt_receipt_captured: ({ payload }) => asRecord(payload).dmtReceiptCaptured === true,
    dmt_correspondence_matches_4886: ({ payload }) =>
      asRecord(payload).dmtCorrespondenceRef === "DMT/MD/OUT/2026/4886",
    conditions_parsed_count_24: ({ payload }) => asRecord(payload).conditionsParsedCount === 24,
    dmt_letter_captured: ({ payload }) => asRecord(payload).dmtLetterCaptured === true,
    all_conditions_accepted: async ({ transaction }) => {
      const res = await transaction.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM "${schema}".masterplan_conditions
         WHERE masterplan_id = $1 AND state IN ('ACCEPTED', 'WAIVED')`,
        [activeAggregateId],
      );
      return Number(res.rows[0]?.cnt ?? 0) === 24;
    },
    no_open_amendment: ({ payload }) => asRecord(payload).noOpenAmendment === true,
    executive_approval_recorded: ({ payload }) => asRecord(payload).executiveApprovalRecorded === true,
    evidence_complete_for_all_conditions: async ({ transaction }) => {
      const res = await transaction.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM "${schema}".masterplan_conditions
         WHERE masterplan_id = $1 AND state IN ('ACCEPTED', 'WAIVED') AND evidence_complete = true`,
        [activeAggregateId],
      );
      return Number(res.rows[0]?.cnt ?? 0) === 24;
    },
    noc_conflict_evidence_present: ({ payload }) => asRecord(payload).nocConflictEvidencePresent === true,
    amended_package_complete: ({ payload }) => asRecord(payload).amendedPackageComplete === true,
    impact_assessment_complete: ({ payload }) => asRecord(payload).impactAssessmentComplete === true,
    baseline_change_status_applied: ({ payload }) => asRecord(payload).baselineChangeStatusApplied === true,
    today_after_valid_until: ({ payload, now }) => {
      const vu = asRecord(payload).validUntil;
      return typeof vu === "string" && Number.isFinite(Date.parse(vu)) && Date.parse(vu) < now.getTime();
    },
    no_renewal_recorded: ({ payload }) => asRecord(payload).noRenewalRecorded === true,
    renewal_certificate_captured: ({ payload }) => asRecord(payload).renewalCertificateCaptured === true,
    new_validity_window_recorded: ({ payload, now }) => {
      const nw = asRecord(payload).newValidityWindowRecorded;
      return typeof nw === "string" && Number.isFinite(Date.parse(nw)) && Date.parse(nw) > now.getTime();
    },

    // SM_1_condition guards
    evidence_uploaded: ({ payload }) => asRecord(payload).evidenceUploaded === true,
    evidence_type_matches_condition: ({ payload }) => asRecord(payload).evidenceTypeMatchesCondition === true,
    reviewer_assigned: ({ payload }) => asRecord(payload).reviewerAssigned === true,
    acceptance_evidence_recorded: ({ payload }) => asRecord(payload).acceptanceEvidenceRecorded === true,
    rejection_reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).rejectionReasonRecorded),
    new_evidence_uploaded: ({ payload }) => asRecord(payload).newEvidenceUploaded === true,
    authority_written_confirmation: ({ payload }) => asRecord(payload).authorityWrittenConfirmation === true,
    review_date_recorded: ({ payload }) => {
      const rd = asRecord(payload).reviewDateRecorded;
      return typeof rd === "string" && rd.trim().length > 0 && Number.isFinite(Date.parse(rd));
    },
    reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).reasonRecorded),

    // SM_11_baseline_change guards
    change_description_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).changeDescriptionRecorded),
    affected_parcels_listed: ({ payload }) => {
      const arr = asRecord(payload).affectedParcelsListed;
      return Array.isArray(arr) && arr.length > 0;
    },
    affected_cases_listed: ({ payload }) => {
      const arr = asRecord(payload).affectedCasesListed;
      return Array.isArray(arr) && arr.length > 0;
    },
    revision_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).revisionRecorded),
    impact_actions_started: ({ payload }) => asRecord(payload).impactActionsStarted === true,
    new_baseline_version_created: ({ payload }) => asRecord(payload).newBaselineVersionCreated === true,
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

  async function ensureSeededAggregate(
    credential: unknown,
    machineId: string,
    initialState: string,
    aggregateId: string,
    projectId: string,
    scope: ScopeBinding,
  ) {
    const principal = await authorization.resolve(credential, clock());
    if (!principal) throw new Error("UNAUTHENTICATED");
    const normScope = normalizeScope(scope);
    const scopeHash = canonicalHash(normScope);
    await pool.query(
      `INSERT INTO "${schema}".projects (tenant_id, project_id, dependency_epoch)
       VALUES ($1, $2, 0)
       ON CONFLICT (tenant_id, project_id) DO NOTHING`,
      [principal.tenantId, projectId],
    );
    const projRes = await pool.query<{ dependency_epoch: number }>(
      `SELECT dependency_epoch FROM "${schema}".projects WHERE tenant_id = $1 AND project_id = $2`,
      [principal.tenantId, projectId],
    );
    const epoch = projRes.rows[0]?.dependency_epoch ?? 0;
    await pool.query(
      `INSERT INTO "${schema}".aggregates (
        tenant_id, aggregate_id, project_id, machine_id, contract_version, scope, scope_hash, state, version, dependency_epoch
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 0, $9)`,
      [
        principal.tenantId,
        aggregateId,
        projectId,
        machineId,
        CONTRACT_VERSION,
        JSON.stringify(normScope),
        scopeHash,
        initialState,
        epoch,
      ],
    );
  }

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
    if (!rule) throw new Error(`Unknown transition ${input.transitionId}`);
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

  async function executeDomainTransition(
    credential: unknown,
    input: {
      aggregateId: string;
      transitionId: string;
      scope: ScopeBinding;
      payload: Record<string, JsonValue>;
      approvals?: readonly ApprovalFact[];
    },
  ): Promise<CommandResult> {
    const envelope = await buildEnvelope(input);
    pendingApprovals = input.approvals;
    activeAggregateId = input.aggregateId;
    try {
      const result = await engine.execute(credential, envelope);
      if (!result.ok) {
        retryNonce += 1;
      } else {
        retryNonce = 0;
        // Mirror condition state if this aggregate is in masterplan_conditions
        await pool.query(
          `UPDATE "${schema}".masterplan_conditions
           SET state = $1,
               evidence_complete = CASE WHEN $1 IN ('ACCEPTED', 'WAIVED') THEN true ELSE evidence_complete END
           WHERE aggregate_id = $2`,
          [result.state, input.aggregateId],
        );
      }
      return result;
    } finally {
      pendingApprovals = undefined;
    }
  }

  return {
    async initialize() {
      await engine.initialize();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "${schema}".masterplan_conditions (
          masterplan_id uuid NOT NULL,
          condition_number integer NOT NULL CHECK (condition_number BETWEEN 1 AND 24),
          aggregate_id uuid NOT NULL UNIQUE,
          state text NOT NULL,
          evidence_complete boolean NOT NULL DEFAULT false,
          PRIMARY KEY (masterplan_id, condition_number)
        );
      `);
    },

    async close() {
      await engine.close();
      await pool.end();
    },

    async createMasterplan(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_1_masterplan",
        "CMP_APPROVED",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async createCondition(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_1_condition",
        "OPEN",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
      await pool.query(
        `INSERT INTO "${schema}".masterplan_conditions (masterplan_id, condition_number, aggregate_id, state, evidence_complete)
         VALUES ($1, $2, $3, 'OPEN', false)
         ON CONFLICT (masterplan_id, condition_number) DO UPDATE
           SET aggregate_id = EXCLUDED.aggregate_id, state = 'OPEN', evidence_complete = false`,
        [input.masterplanId, input.conditionNumber, input.aggregateId],
      );
    },

    async createBaselineChangeRequest(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_11_baseline_change",
        "DRAFT",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    transitionMasterplan: executeDomainTransition,
    transitionCondition: executeDomainTransition,
    transitionBaselineChange: executeDomainTransition,

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

    async seedAcceptedConditionsForTest(masterplanId, count) {
      for (let i = 1; i <= count; i++) {
        await pool.query(
          `INSERT INTO "${schema}".masterplan_conditions (masterplan_id, condition_number, aggregate_id, state, evidence_complete)
           VALUES ($1, $2, $3, 'ACCEPTED', true)
           ON CONFLICT (masterplan_id, condition_number) DO UPDATE
             SET state = 'ACCEPTED', evidence_complete = true`,
          [masterplanId, i, randomUUID()],
        );
      }
    },

    async getProjectEpoch(projectId) {
      const res = await pool.query<{ dependency_epoch: number }>(
        `SELECT dependency_epoch FROM "${schema}".projects WHERE project_id = $1 LIMIT 1`,
        [projectId],
      );
      return res.rows[0]?.dependency_epoch ?? 0;
    },
  };
}
