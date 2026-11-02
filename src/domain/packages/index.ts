import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import YAML from "yaml";
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

function loadWorkstreamCatalogue() {
  const raw = YAML.parse(readFileSync(resolve(process.cwd(), "docs/state-machines.yaml"), "utf8")) as {
    machines: {
      SM_2D_workstream: {
        config: {
          step03a_current_requirements: string[];
          step03b_separate_submission_planned: boolean;
          items: {
            id: string;
            track: string;
            seed_status: string;
            cross_links?: string[];
          }[];
        };
      };
    };
  };
  const cfg = raw.machines.SM_2D_workstream.config;
  return Object.freeze({
    step03aCurrentRequirements: Object.freeze([...cfg.step03a_current_requirements]),
    step03bSeparateSubmission: cfg.step03b_separate_submission_planned,
    catalogue: Object.freeze(
      cfg.items.map((item) =>
        Object.freeze({
          id: item.id,
          track: item.track,
          seed: item.seed_status,
          links: item.cross_links ? Object.freeze([...item.cross_links]) : undefined,
        }),
      ),
    ),
  });
}

export const WORKSTREAM_CATALOGUE = loadWorkstreamCatalogue();

export interface PackagesServiceOptions {
  connectionString: string;
  schema: string;
  authorization: AuthorizationPort;
  clock: () => Date;
}

export interface PackagesServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createWorkstream(
    credential: unknown,
    input: { aggregateId: string; projectId: string; workstreamCode: string; scope: ScopeBinding },
  ): Promise<void>;
  createFullPermit(
    credential: unknown,
    input: { aggregateId: string; projectId: string; packageId: string; scope: ScopeBinding },
  ): Promise<void>;
  createAppointments(
    credential: unknown,
    input: { aggregateId: string; projectId: string; scope: ScopeBinding },
  ): Promise<void>;
  transitionPackageAggregate(
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
const DOMAIN_MACHINES = new Set(["SM_2D_workstream", "SM_2E_full_permit", "SM_2F_appointments"]);
const DOMAIN_TRANSITIONS = ALL_TRANSITIONS.filter((t) => DOMAIN_MACHINES.has(t.machineId));
const RULE_BY_ID = new Map(DOMAIN_TRANSITIONS.map((r) => [r.id, r] as const));

const asRecord = (payload: JsonValue): Record<string, JsonValue> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

export function createPackagesService(options: PackagesServiceOptions): PackagesServicePort {
  const { connectionString, schema, authorization, clock } = options;
  const pool = new Pool({ connectionString, max: 6 });
  let pendingApprovals: readonly ApprovalFact[] | undefined;
  let retryNonce = 0;

  const guards: Record<string, (input: { payload: JsonValue }) => unknown> = {
    // SM_2D_workstream guards
    owner_assigned: ({ payload }) => asRecord(payload).ownerAssigned === true,
    workstream_package_complete: ({ payload }) => asRecord(payload).workstreamPackageComplete === true,
    valid_evidence_captured: ({ payload }) => asRecord(payload).validEvidenceCaptured === true,
    alignment_required_for_item: ({ payload }) => asRecord(payload).alignmentRequiredForItem === true,
    gis_alignment_validated: ({ payload }) => asRecord(payload).gisAlignmentValidated === true,
    rejection_reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).rejectionReasonRecorded),
    corrections_recorded: ({ payload }) => asRecord(payload).correctionsRecorded === true,
    item_is_conditional: ({ payload }) => asRecord(payload).itemIsConditional === true,
    trigger_condition_met: ({ payload }) => asRecord(payload).triggerConditionMet === true,
    justification_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).justificationRecorded),
    validator_approval_recorded: ({ payload }) => asRecord(payload).validatorApprovalRecorded === true,

    // SM_2E_full_permit guards
    site_clearance_all_approved_or_government_exempt: ({ payload }) =>
      asRecord(payload).siteClearanceAllApprovedOrGovernmentExempt === true,
    soil_report_stamped: ({ payload }) => asRecord(payload).soilReportStamped === true,
    readiness_gate_closed: ({ payload }) => asRecord(payload).readinessGateClosed === true,
    packages_complete: ({ payload }) => asRecord(payload).packagesComplete === true,
    package_scope_confirmed: ({ payload }) => asRecord(payload).packageScopeConfirmed === true,
    supporting_approvals_valid_or_not_required: ({ payload }) =>
      asRecord(payload).supportingApprovalsValidOrNotRequired === true,
    enoc_stage_approval_supports_taqa_super_plot_if_applicable: ({ payload }) =>
      asRecord(payload).enocStageApprovalSupportsTaqaSuperPlotIfApplicable === true,
    all_approved_evidence_reliance_verified: ({ payload }) =>
      asRecord(payload).allApprovedEvidenceRelianceVerified === true,
    third_party_plan_review_active_if_required: ({ payload }) =>
      asRecord(payload).thirdPartyPlanReviewActiveIfRequired === true,
    structural_plan_review_evidence_verified_if_required: ({ payload }) =>
      asRecord(payload).structuralPlanReviewEvidenceVerifiedIfRequired === true,
    masterplan_not_in_amendment: ({ payload }) => asRecord(payload).masterplanNotInAmendment === true,
    fallback_adm_direction_if_standalone: ({ payload }) => {
      const rec = asRecord(payload);
      // Global behavioral_contract.fallback.placeholder_guard_semantics: false_for_any_standalone_full_permit_command
      if (rec.standaloneModeRequested === true) return false;
      return true;
    },
    bundle_validated: ({ payload }) => asRecord(payload).bundleValidated === true,
    bundle_hash_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).bundleHashRecorded),
    authorized_signatory: ({ payload }) => asRecord(payload).authorizedSignatory === true,
    package_matches_approved_scope: ({ payload }) => asRecord(payload).packageMatchesApprovedScope === true,
    authority_receipt_captured: ({ payload }) => asRecord(payload).authorityReceiptCaptured === true,
    approval_evidence_captured: ({ payload }) => asRecord(payload).approvalEvidenceCaptured === true,
    comment_letter_captured: ({ payload }) => asRecord(payload).commentLetterCaptured === true,
    all_comments_resolved: ({ payload }) => asRecord(payload).allCommentsResolved === true,
    new_bundle_hash_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).newBundleHashRecorded),
    permit_expiry_passed: ({ payload }) => asRecord(payload).permitExpiryPassed === true,
    reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).reasonRecorded),

    // SM_2F_appointments guards
    step04_approved: ({ payload }) => asRecord(payload).step04Approved === true,
    contractor_trade_license_valid: ({ payload }) => asRecord(payload).contractorTradeLicenseValid === true,
    supervision_consultant_license_valid: ({ payload }) =>
      asRecord(payload).supervisionConsultantLicenseValid === true,
    construction_contract_signed_with_cost_and_duration: ({ payload }) =>
      asRecord(payload).constructionContractSignedWithCostAndDuration === true,
    contractor_assigned_in_meps: ({ payload }) => asRecord(payload).contractorAssignedInMeps === true,
    appointment_package_complete: ({ payload }) => asRecord(payload).appointmentPackageComplete === true,
    appointment_approval_captured: ({ payload }) => asRecord(payload).appointmentApprovalCaptured === true,
    permit_number_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).permitNumberRecorded),
    permit_document_uploaded: ({ payload }) => asRecord(payload).permitDocumentUploaded === true,
    contractor_is_issuing_party: ({ payload }) => asRecord(payload).contractorIsIssuingParty === true,
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
    if (!rule) throw new Error(`Unknown package transition ${input.transitionId}`);
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

    async createWorkstream(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_2D_workstream",
        "NOT_AVAILABLE",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async createFullPermit(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_2E_full_permit",
        "LOCKED",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async createAppointments(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_2F_appointments",
        "BLOCKED",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async transitionPackageAggregate(credential, input) {
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
