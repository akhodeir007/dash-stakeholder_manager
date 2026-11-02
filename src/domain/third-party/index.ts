import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import YAML from "yaml";
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

function loadThirdPartyConfig() {
  const raw = YAML.parse(readFileSync(resolve(process.cwd(), "docs/state-machines.yaml"), "utf8")) as {
    machines: {
      SM_4_third_party: {
        config: {
          client_letter_ref: string;
          form_22_ref: string;
          dmt_letter_ref: string;
          consultant: string;
          authorized_scopes: string[];
          dmt_condition: string;
        };
      };
    };
  };
  const cfg = raw.machines.SM_4_third_party.config;
  return Object.freeze({
    clientLetterRef: cfg.client_letter_ref,
    form22Ref: cfg.form_22_ref,
    dmtLetterRef: cfg.dmt_letter_ref,
    consultant: cfg.consultant,
    authorizedScopes: Object.freeze([...cfg.authorized_scopes]),
    dmtCondition: cfg.dmt_condition,
  });
}

export const THIRD_PARTY_SOURCE_TRUTH = loadThirdPartyConfig();

export interface ThirdPartyServiceOptions {
  connectionString: string;
  schema: string;
  authorization: AuthorizationPort;
  clock: () => Date;
}

export interface ThirdPartyServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createThirdPartyAuthorization(
    credential: unknown,
    input: { aggregateId: string; projectId: string; scope: ScopeBinding },
  ): Promise<void>;
  transitionThirdParty(
    credential: unknown,
    input: {
      aggregateId: string;
      transitionId: string;
      scope: ScopeBinding;
      payload: Record<string, JsonValue>;
    },
  ): Promise<CommandResult>;
  isTechnicalWorkUnlocked(aggregateId: string): Promise<boolean>;
  getProjectEpoch(projectId: string): Promise<number>;
}

const { version: CONTRACT_VERSION, transitions: ALL_TRANSITIONS } = loadMachineDefinitions();
const DOMAIN_TRANSITIONS = ALL_TRANSITIONS.filter((t) => t.machineId === "SM_4_third_party");
const RULE_BY_ID = new Map(DOMAIN_TRANSITIONS.map((r) => [r.id, r] as const));

const asRecord = (payload: JsonValue): Record<string, JsonValue> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

export function createThirdPartyService(options: ThirdPartyServiceOptions): ThirdPartyServicePort {
  const { connectionString, schema, authorization, clock } = options;
  const pool = new Pool({ connectionString, max: 6 });
  let retryNonce = 0;

  const guards: Record<string, (input: { payload: JsonValue }) => unknown> = {
    signed_form_22_uploaded: ({ payload }) => asRecord(payload).signedForm22Uploaded === true,
    consultant_compliance_pledge_signed: ({ payload }) =>
      asRecord(payload).consultantCompliancePledgeSigned === true,
    meps_submission_receipt_captured: ({ payload }) => asRecord(payload).mepsSubmissionReceiptCaptured === true,
    dmt_letter_8415_captured: ({ payload }) => asRecord(payload).dmtLetter8415Captured === true,
    dmt_executive_director_approval_captured: ({ payload }) =>
      asRecord(payload).dmtExecutiveDirectorApprovalCaptured === true,
    authorized_scope_covers_required_work: ({ payload }) =>
      asRecord(payload).authorizedScopeCoversRequiredWork === true,
    inspection_scope_defined: ({ payload }) => asRecord(payload).inspectionScopeDefined === true,
    inspector_credentials_valid: ({ payload }) => asRecord(payload).inspectorCredentialsValid === true,
    assignment_recorded: ({ payload }) => asRecord(payload).assignmentRecorded === true,
    rejection_reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).rejectionReasonRecorded),
    suspension_reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).suspensionReasonRecorded),
    suspension_resolved: ({ payload }) => asRecord(payload).suspensionResolved === true,
    reinstatement_evidence_captured: ({ payload }) => asRecord(payload).reinstatementEvidenceCaptured === true,
    authorization_expiry_passed: ({ payload }) => asRecord(payload).authorizationExpiryPassed === true,
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

    async createThirdPartyAuthorization(credential, input) {
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
        ) VALUES ($1, $2, $3, 'SM_4_third_party', $4, $5::jsonb, $6, 'CLIENT_DELEGATION_SIGNED', 0, $7)`,
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

    async transitionThirdParty(credential, input) {
      const rule = RULE_BY_ID.get(input.transitionId);
      if (!rule) throw new Error(`Unknown SM_4_third_party transition ${input.transitionId}`);
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

    async isTechnicalWorkUnlocked(aggregateId) {
      const res = await pool.query<{ state: string }>(
        `SELECT state FROM "${schema}".aggregates WHERE aggregate_id = $1 LIMIT 1`,
        [aggregateId],
      );
      // Conservative software lock per YAML behavioral_contract.third_party:
      // licensing_approval_allows_technical_work = false; requires INSPECTION_ACTIVE
      return res.rows[0]?.state === "INSPECTION_ACTIVE";
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
