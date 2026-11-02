import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import YAML from "yaml";
import type {
  ApprovalFact,
  AuthorizationPort,
  EvidenceAuthorizationFact,
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

export interface SiteClearanceEntitySeed {
  readonly id: string;
  readonly alias?: string;
  readonly refs: readonly string[];
  readonly seedStatus: string;
  readonly critical: boolean;
  readonly required: boolean;
  readonly note?: string;
}

function loadSiteClearanceSeed(): readonly SiteClearanceEntitySeed[] {
  const raw = YAML.parse(readFileSync(resolve(process.cwd(), "docs/state-machines.yaml"), "utf8")) as {
    machines: {
      SM_2B_entity: {
        config: {
          entities: {
            id: string;
            alias?: string;
            refs: string[];
            seed_status: string;
            critical: boolean;
            note?: string;
          }[];
          required_entities: string[];
        };
      };
    };
  };
  const cfg = raw.machines.SM_2B_entity.config;
  const reqSet = new Set(cfg.required_entities);
  return Object.freeze(
    cfg.entities.map((e) =>
      Object.freeze({
        id: e.id,
        alias: e.alias,
        refs: Object.freeze([...e.refs]),
        seedStatus: e.seed_status,
        critical: e.critical,
        required: reqSet.has(e.id),
        note: e.note,
      }),
    ),
  );
}

export const SITE_CLEARANCE_ENTITIES_SEED: readonly SiteClearanceEntitySeed[] = loadSiteClearanceSeed();

export interface MepsServiceOptions {
  connectionString: string;
  schema: string;
  authorization: AuthorizationPort;
  clock: () => Date;
}

export interface MepsServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createRegistration(
    credential: unknown,
    input: { aggregateId: string; projectId: string; scope: ScopeBinding },
  ): Promise<void>;
  createClearanceEntity(
    credential: unknown,
    input: {
      aggregateId: string;
      caseId: string;
      projectId: string;
      entityCode: string;
      required: boolean;
      scope: ScopeBinding;
    },
  ): Promise<void>;
  createClearanceCase(
    credential: unknown,
    input: { aggregateId: string; projectId: string; scope: ScopeBinding },
  ): Promise<void>;
  createSoilWorkPermit(
    credential: unknown,
    input: { aggregateId: string; projectId: string; scope: ScopeBinding },
  ): Promise<void>;
  createSoilReport(
    credential: unknown,
    input: { aggregateId: string; projectId: string; scope: ScopeBinding },
  ): Promise<void>;
  transitionMeps(
    credential: unknown,
    input: {
      aggregateId: string;
      transitionId: string;
      scope: ScopeBinding;
      payload: Record<string, JsonValue>;
      approvals?: readonly ApprovalFact[];
      evidenceFact?: EvidenceAuthorizationFact;
    },
  ): Promise<CommandResult>;
  computeDualControlBinding(input: {
    aggregateId: string;
    transitionId: string;
    scope: ScopeBinding;
    payload: Record<string, JsonValue>;
  }): Promise<{ commandHash: string; scopeHash: string; dependencyEpoch: number }>;
  getProjectEpoch(projectId: string): Promise<number>;
}

const { version: CONTRACT_VERSION, transitions: ALL_TRANSITIONS } = loadMachineDefinitions();
const DOMAIN_MACHINES = new Set([
  "SM_2A_registration",
  "SM_2B_entity",
  "SM_2B_case",
  "SM_2C_soil_work",
  "SM_2D_soil_report",
]);
const DOMAIN_TRANSITIONS = ALL_TRANSITIONS.filter((t) => DOMAIN_MACHINES.has(t.machineId));
const RULE_BY_ID = new Map(DOMAIN_TRANSITIONS.map((r) => [r.id, r] as const));

const asRecord = (payload: JsonValue): Record<string, JsonValue> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const validDateStr = (v: unknown): boolean =>
  typeof v === "string" && v.trim().length > 0 && Number.isFinite(Date.parse(v));

export function createMepsService(options: MepsServiceOptions): MepsServicePort {
  const { connectionString, schema, authorization, clock } = options;
  const pool = new Pool({ connectionString, max: 6 });
  let pendingApprovals: readonly ApprovalFact[] | undefined;
  let pendingEvidenceFact: EvidenceAuthorizationFact | undefined;
  let retryNonce = 0;

  const guards: Record<string, (input: { payload: JsonValue }) => unknown> = {
    // SM_2A_registration guards
    affection_plan_valid: ({ payload }) => asRecord(payload).affectionPlanValid === true,
    client_appointment_letter_valid: ({ payload }) => asRecord(payload).clientAppointmentLetterValid === true,
    plot_baseline_present: ({ payload }) => asRecord(payload).plotBaselinePresent === true,
    dmt_approval_recorded_or_not_applicable: ({ payload }) =>
      asRecord(payload).dmtApprovalRecordedOrNotApplicable === true,
    meps_template_package_complete: ({ payload }) => asRecord(payload).mepsTemplatePackageComplete === true,
    approval_evidence_captured: ({ payload }) => asRecord(payload).approvalEvidenceCaptured === true,
    return_reason_captured: ({ payload }) => nonEmptyStr(asRecord(payload).returnReasonCaptured),
    corrections_recorded: ({ payload }) => asRecord(payload).correctionsRecorded === true,
    reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).reasonRecorded),

    // SM_2B_entity guards
    owner_assigned: ({ payload }) => asRecord(payload).ownerAssigned === true,
    requirement_list_generated: ({ payload }) => asRecord(payload).requirementListGenerated === true,
    required_documents_present: ({ payload }) => asRecord(payload).requiredDocumentsPresent === true,
    signed_undertaking_present_if_required: ({ payload }) =>
      asRecord(payload).signedUndertakingPresentIfRequired === true,
    authority_receipt_captured: ({ payload }) => asRecord(payload).authorityReceiptCaptured === true,
    valid_noc_evidence: ({ payload }) => asRecord(payload).validNocEvidence === true,
    evidence_not_expired: ({ payload }) => asRecord(payload).evidenceNotExpired === true,
    reliance_verified: ({ payload }) => asRecord(payload).relianceVerified === true,
    authority_request_captured: ({ payload }) => asRecord(payload).authorityRequestCaptured === true,
    all_requested_documents_uploaded: ({ payload }) => asRecord(payload).allRequestedDocumentsUploaded === true,
    documents_validated: ({ payload }) => asRecord(payload).documentsValidated === true,
    comment_letter_captured: ({ payload }) => asRecord(payload).commentLetterCaptured === true,
    comments_linked: ({ payload }) => asRecord(payload).commentsLinked === true,
    revised_drawings_uploaded: ({ payload }) => asRecord(payload).revisedDrawingsUploaded === true,
    response_bundle_complete: ({ payload }) => asRecord(payload).responseBundleComplete === true,
    authority_letter_confirms_unavailable_service: ({ payload }) =>
      asRecord(payload).authorityLetterConfirmsUnavailableService === true,
    authority_written_confirmation: ({ payload }) => asRecord(payload).authorityWrittenConfirmation === true,
    executive_approval_recorded: ({ payload }) => asRecord(payload).executiveApprovalRecorded === true,
    review_date_recorded: ({ payload }) => validDateStr(asRecord(payload).reviewDateRecorded),
    evidence_expiry_passed: ({ payload }) => asRecord(payload).evidenceExpiryPassed === true,
    renewed_evidence_uploaded: ({ payload }) => asRecord(payload).renewedEvidenceUploaded === true,
    authority_confirms_not_applicable: ({ payload }) => asRecord(payload).authorityConfirmsNotApplicable === true,
    justification_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).justificationRecorded),
    validator_approval_recorded: ({ payload }) => asRecord(payload).validatorApprovalRecorded === true,

    // SM_2B_case guards
    step01_approved_or_project_linked: ({ payload }) => asRecord(payload).step01ApprovedOrProjectLinked === true,
    all_required_entities_initialized: ({ payload }) => asRecord(payload).allRequiredEntitiesInitialized === true,
    site_clearance_pre_project_allowed: ({ payload }) => asRecord(payload).siteClearancePreProjectAllowed === true,
    plot_identified: ({ payload }) => asRecord(payload).plotIdentified === true,
    initiator_is_consultant_or_contractor: ({ payload }) =>
      asRecord(payload).initiatorIsConsultantOrContractor === true,
    meps_project_registered: ({ payload }) => asRecord(payload).mepsProjectRegistered === true,
    project_link_recorded: ({ payload }) => asRecord(payload).projectLinkRecorded === true,
    at_least_one_entity_submitted: ({ payload }) => asRecord(payload).atLeastOneEntitySubmitted === true,
    authority_receipts_captured: ({ payload }) => asRecord(payload).authorityReceiptsCaptured === true,
    at_least_one_entity_approved: ({ payload }) => asRecord(payload).atLeastOneEntityApproved === true,
    not_all_entities_approved: ({ payload }) => asRecord(payload).notAllEntitiesApproved === true,
    all_required_entities_approved_waived_or_not_required: ({ payload }) =>
      asRecord(payload).allRequiredEntitiesApprovedWaivedOrNotRequired === true,
    all_approved_entities_reliance_verified: ({ payload }) =>
      asRecord(payload).allApprovedEntitiesRelianceVerified === true,
    no_unwaived_unavailable_infrastructure: ({ payload }) =>
      asRecord(payload).noUnwaivedUnavailableInfrastructure === true,
    any_required_entity_in_modification_or_pending_documents: ({ payload }) =>
      asRecord(payload).anyRequiredEntityInModificationOrPendingDocuments === true,
    all_required_entities_resubmitted: ({ payload }) => asRecord(payload).allRequiredEntitiesResubmitted === true,
    entity_expired_or_revoked: ({ payload }) => asRecord(payload).entityExpiredOrRevoked === true,
    replacement_entity_submitted: ({ payload }) => asRecord(payload).replacementEntitySubmitted === true,
    all_entities_rejected_or_unavailable: ({ payload }) =>
      asRecord(payload).allEntitiesRejectedOrUnavailable === true,
    executive_notification_recorded: ({ payload }) => asRecord(payload).executiveNotificationRecorded === true,
    government_owned_project_confirmed: ({ payload }) => asRecord(payload).governmentOwnedProjectConfirmed === true,
    dmt_masterplan_approval_evidence: ({ payload }) => asRecord(payload).dmtMasterplanApprovalEvidence === true,
    adm_meps_exemption_confirmation: ({ payload }) => asRecord(payload).admMepsExemptionConfirmation === true,
    exemption_no_longer_valid: ({ payload }) => asRecord(payload).exemptionNoLongerValid === true,

    // SM_2C_soil_work guards
    site_clearance_all_approved_or_government_exempt: ({ payload }) =>
      asRecord(payload).siteClearanceAllApprovedOrGovernmentExempt === true,
    soil_work_package_complete: ({ payload }) => asRecord(payload).soilWorkPackageComplete === true,
    rejection_reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).rejectionReasonRecorded),

    // SM_2D_soil_report guards
    geotechnical_scope_defined: ({ payload }) => asRecord(payload).geotechnicalScopeDefined === true,
    draft_report_complete: ({ payload }) => asRecord(payload).draftReportComplete === true,
    third_party_authorization_active: ({ payload }) => asRecord(payload).thirdPartyAuthorizationActive === true,
    authorized_scope_covers_structural_inspection: ({ payload }) =>
      asRecord(payload).authorizedScopeCoversStructuralInspection === true,
    stamped_report_uploaded: ({ payload }) => asRecord(payload).stampedReportUploaded === true,
    stamp_valid: ({ payload }) => asRecord(payload).stampValid === true,
    signer_assigned_and_credentialed: ({ payload }) => asRecord(payload).signerAssignedAndCredentialed === true,
    independent_structural_validation_recorded: ({ payload }) =>
      asRecord(payload).independentStructuralValidationRecorded === true,
    authorization_version_current_at_commit: ({ payload }) =>
      asRecord(payload).authorizationVersionCurrentAtCommit === true,
    submission_receipt_captured: ({ payload }) => asRecord(payload).submissionReceiptCaptured === true,
    acceptance_evidence_captured: ({ payload }) => asRecord(payload).acceptanceEvidenceCaptured === true,
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
    loadAuthorizationFacts: async () => {
      if (!pendingApprovals && !pendingEvidenceFact) return undefined;
      return {
        ...(pendingApprovals ? { approvals: pendingApprovals } : {}),
        ...(pendingEvidenceFact ? { evidence: pendingEvidenceFact } : {}),
      };
    },
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
    if (!rule) throw new Error(`Unknown MEPS transition ${input.transitionId}`);
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

    async createRegistration(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_2A_registration",
        "NOT_STARTED",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async createClearanceEntity(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_2B_entity",
        "NOT_STARTED",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async createClearanceCase(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_2B_case",
        "NOT_STARTED",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async createSoilWorkPermit(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_2C_soil_work",
        "LOCKED",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async createSoilReport(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_2D_soil_report",
        "NOT_STARTED",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async transitionMeps(credential, input) {
      const envelope = await buildEnvelope(input);
      pendingApprovals = input.approvals;
      pendingEvidenceFact = input.evidenceFact;
      try {
        const result = await engine.execute(credential, envelope);
        if (!result.ok) retryNonce += 1;
        else retryNonce = 0;
        return result;
      } finally {
        pendingApprovals = undefined;
        pendingEvidenceFact = undefined;
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

    async getProjectEpoch(projectId) {
      const res = await pool.query<{ dependency_epoch: number }>(
        `SELECT dependency_epoch FROM "${schema}".projects WHERE project_id = $1 LIMIT 1`,
        [projectId],
      );
      return res.rows[0]?.dependency_epoch ?? 0;
    },
  };
}
