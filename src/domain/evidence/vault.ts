import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import canonicalize from "canonicalize";
import type { Pool, PoolClient } from "pg";
import YAML from "yaml";
import type {
  AuthorizationContext,
  Principal,
  Role,
  ScopeBinding,
  TransitionRule,
} from "../../contracts/foundation";
import type {
  AuthorityAssertionRecord,
  DocumentLifecycleState,
  EvidenceClass,
  EvidenceServiceOptions,
  EvidenceServicePort,
  EvidenceVersionRecord,
  GateSnapshotRecord,
  RelianceEvaluationRecord,
  RelianceStatus,
} from "./index";

const ALLOWED_MEDIA_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
]);
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024; // 50 MiB local synthetic cap
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const REGULATED_CLASSES = new Set<EvidenceClass>([
  "AUTHORITY_APPROVAL",
  "NOC",
  "STAMPED_TECHNICAL_DOCUMENT",
  "LEGAL_AUTHORIZATION",
  "EXEMPTION",
  "WAIVER",
]);
const MATERIAL_CHANGE_KINDS = new Set([
  "expiry",
  "revocation",
  "suspension",
  "scope_change",
  "design_revision_change",
  "requirement_change",
  "evidence_supersession",
  "exemption_revocation",
]);

const ALL_HUMAN_ROLES: Role[] = [
  "SYSTEM_ADMIN",
  "STAKEHOLDER_MANAGER",
  "AOR_LEAD",
  "THIRD_PARTY_INSPECTOR",
  "CLIENT_EXECUTIVE",
  "DISCIPLINE_LEAD",
  "CONTRACTOR",
];

function loadEvidenceTransitionRules(): {
  sm10Rules: readonly TransitionRule[];
  allEvidenceRules: readonly TransitionRule[];
} {
  const raw = YAML.parse(readFileSync(resolve(process.cwd(), "docs/state-machines.yaml"), "utf8")) as {
    behavioral_contract: {
      evidence_validation: { dual_control_role_pairs: Record<string, [Role, Role][]> };
    };
    machines: Record<
      string,
      {
        transitions: {
          id: string;
          from: string | string[];
          event: string;
          to: string;
          guards?: string[];
          effects?: string[];
          roles: Role[];
        }[];
      }
    >;
  };

  const dualPairs = raw.behavioral_contract.evidence_validation.dual_control_role_pairs;
  const sm10Source = raw.machines.SM_10_document?.transitions ?? [];
  const sm10Mapped: TransitionRule[] = sm10Source.map((t) => ({
    id: t.id,
    machineId: "SM_10_document",
    event: t.event,
    from: Array.isArray(t.from) ? t.from : [t.from],
    to: t.to,
    roles: t.roles,
    guards: t.guards ?? [],
    effects: t.effects ?? [],
    operation: t.id === "S10-T04" ? "VALIDATE_EVIDENCE" : "TRANSITION",
    dualControlPairs: dualPairs[t.id],
  }));

  const vaultOperationRules: TransitionRule[] = [
    {
      id: "EV-UPLOAD",
      machineId: "SM_10_document",
      event: "UPLOAD",
      from: ["NONE"],
      to: "UPLOADED",
      roles: ALL_HUMAN_ROLES,
      guards: ["hash_computed"],
      effects: ["store_version"],
      operation: "TRANSITION",
    },
    {
      id: "EV-RECORD-FACT",
      machineId: "SM_10_document",
      event: "RECORD_FACT",
      from: ["UPLOADED", "SCANNING", "EXTRACTED", "VALIDATED", "ACTIVE"],
      to: "RECORDED",
      roles: ["AOR_LEAD", "STAKEHOLDER_MANAGER", "DISCIPLINE_LEAD", "CONTRACTOR"],
      guards: ["authority_reference_present"],
      effects: ["append_assertion"],
      operation: "TRANSITION",
    },
    {
      id: "EV-EVAL-RELIANCE",
      machineId: "SM_10_document",
      event: "EVALUATE_RELIANCE",
      from: ["UPLOADED", "SCANNING", "QUARANTINED", "EXTRACTED", "VALIDATED", "ACTIVE", "EXPIRING", "EXPIRED", "REJECTED", "SUPERSEDED"],
      to: "EVALUATED",
      roles: ["AOR_LEAD", "STAKEHOLDER_MANAGER", "THIRD_PARTY_INSPECTOR", "CLIENT_EXECUTIVE", "SYSTEM"],
      guards: [],
      effects: ["append_reliance_evaluation"],
      operation: "TRANSITION",
    },
    {
      id: "EV-REGISTER-COVERAGE",
      machineId: "SM_10_document",
      event: "REGISTER_COVERAGE",
      from: ["VALIDATED", "ACTIVE"],
      to: "ACTIVE",
      roles: ["STAKEHOLDER_MANAGER", "THIRD_PARTY_INSPECTOR"],
      guards: ["explicit_scope_verified"],
      effects: ["append_scope_coverage"],
      operation: "TRANSITION",
    },
    {
      id: "EV-CREATE-GATE-SNAPSHOT",
      machineId: "SM_10_document",
      event: "CREATE_GATE_SNAPSHOT",
      from: ["ACTIVE"],
      to: "ACTIVE",
      roles: ["AOR_LEAD", "STAKEHOLDER_MANAGER", "SYSTEM"],
      guards: ["all_evidence_verified"],
      effects: ["append_gate_snapshot"],
      operation: "TRANSITION",
    },
    {
      id: "EV-EVAL-GATE",
      machineId: "SM_10_document",
      event: "EVALUATE_GATE",
      from: ["ACTIVE"],
      to: "ACTIVE",
      roles: [...ALL_HUMAN_ROLES, "SYSTEM"],
      guards: [],
      effects: [],
      operation: "TRANSITION",
    },
    {
      id: "EV-INVALIDATE-DEP",
      machineId: "SM_10_document",
      event: "INVALIDATE_DEPENDENCY",
      from: ["ACTIVE"],
      to: "ACTIVE",
      roles: ["AOR_LEAD", "STAKEHOLDER_MANAGER", "CLIENT_EXECUTIVE", "SYSTEM_ADMIN", "SYSTEM"],
      guards: [],
      effects: ["increment_dependency_epoch"],
      operation: "TRANSITION",
    },
    {
      id: "EV-RELIANCE-INVALIDATED-EVENT",
      machineId: "SM_10_document",
      event: "RELIANCE_INVALIDATED_EVENT",
      from: ["ACTIVE"],
      to: "ACTIVE",
      roles: ["SYSTEM", "STAKEHOLDER_MANAGER"],
      guards: [],
      effects: ["project_revalidation_required"],
      operation: "TRANSITION",
    },
    {
      id: "EV-RECOVER-REVALIDATION",
      machineId: "SM_10_document",
      event: "RECOVER_REVALIDATION",
      from: ["ACTIVE"],
      to: "ACTIVE",
      roles: ["STAKEHOLDER_MANAGER", "AOR_LEAD"],
      guards: ["fresh_gate_verified"],
      effects: ["clear_revalidation"],
      operation: "TRANSITION",
    },
    {
      id: "EV-ADMIN-CORRECTION",
      machineId: "SM_10_document",
      event: "ADMIN_CORRECTION",
      from: ["ACTIVE"],
      to: "ACTIVE",
      roles: ["SYSTEM_ADMIN"],
      guards: ["reason_and_links_present"],
      effects: ["append_superseding_assertion"],
      operation: "TRANSITION",
    },
    {
      id: "EV-ADMIN-CORRECTION-DUAL",
      machineId: "SM_10_document",
      event: "ADMIN_CORRECTION_DUAL",
      from: ["ACTIVE"],
      to: "ACTIVE",
      roles: ["SYSTEM_ADMIN"],
      guards: ["reason_and_links_present"],
      effects: ["append_superseding_assertion"],
      operation: "TRANSITION",
      dualControlPairs: [
        ["SYSTEM_ADMIN", "STAKEHOLDER_MANAGER"],
        ["SYSTEM_ADMIN", "CLIENT_EXECUTIVE"],
        ["STAKEHOLDER_MANAGER", "CLIENT_EXECUTIVE"],
      ],
    },
    {
      id: "S2DS-T03",
      machineId: "SM_2D_soil_report",
      event: "STAMP",
      from: ["PENDING_THIRD_PARTY_STAMP"],
      to: "STAMPED_BY_THIRD_PARTY",
      roles: ["THIRD_PARTY_INSPECTOR", "AOR_LEAD"],
      guards: [
        "third_party_authorization_active",
        "authorized_scope_covers_structural_inspection",
        "stamped_report_uploaded",
        "stamp_valid",
        "signer_assigned_and_credentialed",
        "independent_structural_validation_recorded",
        "authorization_version_current_at_commit",
      ],
      effects: ["record_stamp"],
      operation: "RECORD_STAMP",
    },
  ];

  const dualControlRules: TransitionRule[] = Object.entries(dualPairs).map(([id, pairs]) => {
    const roles = Array.from(new Set(pairs.flat())) as Role[];
    return {
      id,
      machineId: "DUAL_CONTROL",
      event: `DUAL_${id}`,
      from: ["EXTRACTED", "VALIDATED", "ACTIVE", "APPROVED"],
      to: "VALIDATED",
      roles,
      guards: [],
      effects: [],
      operation: "VALIDATE_EVIDENCE",
      dualControlPairs: pairs,
    };
  });

  const combined = [...sm10Mapped, ...vaultOperationRules, ...dualControlRules];
  const frozen = Object.freeze(combined.map((r) => Object.freeze({ ...r })));
  return { sm10Rules: frozen, allEvidenceRules: frozen };
}

const LOADED_RULES = loadEvidenceTransitionRules();
export const SM10_TRANSITION_RULES: readonly TransitionRule[] = LOADED_RULES.sm10Rules;
export const EVIDENCE_TRANSITION_RULES: readonly TransitionRule[] = LOADED_RULES.allEvidenceRules;

const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function normalizeScopeForHash(scope: ScopeBinding, includeEvidenceIds = true): unknown {
  if (scope.kind === "PACKAGE_GATE") {
    return {
      kind: scope.kind,
      projectId: scope.projectId,
      packageId: scope.packageId,
      plotIds: [...scope.plotIds].sort(),
      scopeVersion: scope.scopeVersion,
      designRevision: scope.designRevision,
      requirementSnapshotId: scope.requirementSnapshotId,
      ...(includeEvidenceIds ? { evidenceVersionIds: [...scope.evidenceVersionIds].sort() } : {}),
    };
  }
  if (scope.kind === "PROJECT_SCOPE") {
    return {
      kind: scope.kind,
      projectId: scope.projectId,
      scopeVersion: scope.scopeVersion,
      ...(includeEvidenceIds ? { evidenceVersionIds: [...scope.evidenceVersionIds].sort() } : {}),
    };
  }
  return {
    kind: scope.kind,
    provisionalCaseId: scope.provisionalCaseId,
    plotIds: [...scope.plotIds].sort(),
    intakeVersion: scope.intakeVersion,
    initiatorAssignmentId: scope.initiatorAssignmentId,
    sourceAssertionIds: [...scope.sourceAssertionIds].sort(),
  };
}

function computeScopeBindingHash(scope: ScopeBinding, includeEvidenceIds = false): string {
  const canonical = canonicalize(normalizeScopeForHash(scope, includeEvidenceIds));
  if (!canonical) throw new TypeError("Failed to canonicalize scope");
  return sha256Hex(canonical);
}

function computeCommandBindingHash(payload: Record<string, unknown>): string {
  const canonical = canonicalize(payload);
  if (!canonical) throw new TypeError("Failed to canonicalize command payload");
  return sha256Hex(canonical);
}

function validIsoDate(value: string | null): number | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function createEvidenceService(options: EvidenceServiceOptions): EvidenceServicePort {
  if (!options || typeof options !== "object") {
    throw new TypeError("EvidenceServiceOptions are required");
  }
  const { database, clock, storage, scan, authorization } = options;
  const pool: Pool | undefined =
    database && typeof (database as Pool).connect === "function"
      ? (database as Pool)
      : (database as { pool?: Pool })?.pool;
  const rawSchema =
    database && typeof (database as Pool).connect === "function"
      ? "public"
      : ((database as { schema?: string })?.schema ?? "public");

  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("Valid PostgreSQL Pool is required");
  }
  const dbPool: Pool = pool;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawSchema)) {
    throw new TypeError("Invalid PostgreSQL schema identifier");
  }
  if (typeof clock !== "function") {
    throw new TypeError("Injected clock function is required");
  }
  if (!storage || typeof storage.putObject !== "function") {
    throw new TypeError("Injected storage adapter is required");
  }
  if (!scan || typeof scan.scanObject !== "function") {
    throw new TypeError("Injected scan adapter is required");
  }
  if (
    !authorization ||
    typeof authorization.resolve !== "function" ||
    typeof authorization.authorize !== "function"
  ) {
    throw new TypeError("Shared AuthorizationPort is required");
  }

  const schema = rawSchema;
  let activeTxCount = 0;

  async function withTransaction<T>(fn: (client: PoolClient, now: Date) => Promise<T>): Promise<T> {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError("Injected clock returned an invalid Date");
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const client = await dbPool.connect();
      let txOpen = false;
      try {
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        txOpen = true;
        activeTxCount += 1;
        const result = await fn(client, now);
        await client.query("COMMIT");
        txOpen = false;
        activeTxCount -= 1;
        return result;
      } catch (err) {
        if (txOpen) {
          activeTxCount -= 1;
          try {
            await client.query("ROLLBACK");
          } catch {
            // ignore rollback error
          }
        }
        const pgCode = (err as { code?: string })?.code;
        if ((pgCode === "40001" || pgCode === "40P01") && attempt < 3) {
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
    throw new Error("SERIALIZABLE_RETRY_EXHAUSTED");
  }

  async function ensureProjectRow(client: PoolClient, tenantId: string, projectId: string, nowIso: string) {
    await client.query(
      `INSERT INTO projects (tenant_id, project_id, dependency_epoch, revalidation_status, updated_at)
       VALUES ($1, $2, 0, 'CLEAR', $3)
       ON CONFLICT (tenant_id, project_id) DO NOTHING`,
      [tenantId, projectId, nowIso],
    );
    const res = await client.query<{ dependency_epoch: number; revalidation_status: "CLEAR" | "REQUIRED" }>(
      `SELECT dependency_epoch, revalidation_status FROM projects WHERE tenant_id = $1 AND project_id = $2 FOR UPDATE`,
      [tenantId, projectId],
    );
    return res.rows[0];
  }

  async function resolveAndAuthorize(
    client: PoolClient,
    credential: unknown,
    now: Date,
    transitionId: string,
    scope: ScopeBinding,
    context?: AuthorizationContext,
  ): Promise<{ ok: true; principal: Principal } | { ok: false; code: string; reason: string }> {
    const principal = await authorization.resolve(credential, now, client);
    if (!principal) {
      return { ok: false, code: "UNAUTHENTICATED", reason: "Session could not be verified" };
    }
    const decision = authorization.authorize(
      principal,
      { transitionId, scope, context, mode: "EXECUTE" },
      now,
    );
    if (!decision.allowed) {
      return { ok: false, code: decision.code, reason: decision.reason };
    }
    return { ok: true, principal };
  }

  const port: EvidenceServicePort = {
    isInTransaction() {
      return activeTxCount > 0;
    },

    async initialize() {
      const client = await dbPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        await client.query(`
          CREATE OR REPLACE FUNCTION reject_immutable_mutation() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'IMMUTABLE_TABLE_MUTATION_FORBIDDEN: %', TG_TABLE_NAME USING ERRCODE = '55000';
          END;
          $$ LANGUAGE plpgsql;

          CREATE TABLE IF NOT EXISTS projects (
            tenant_id text NOT NULL,
            project_id text NOT NULL,
            dependency_epoch integer NOT NULL DEFAULT 0 CHECK (dependency_epoch >= 0),
            revalidation_status text NOT NULL DEFAULT 'CLEAR' CHECK (revalidation_status IN ('CLEAR', 'REQUIRED')),
            updated_at timestamptz NOT NULL,
            PRIMARY KEY (tenant_id, project_id)
          );

          CREATE TABLE IF NOT EXISTS evidence_versions (
            tenant_id text NOT NULL,
            evidence_id text NOT NULL,
            version integer NOT NULL CHECK (version > 0),
            project_id text NOT NULL,
            object_key text NOT NULL,
            content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
            media_type text NOT NULL,
            byte_size integer NOT NULL CHECK (byte_size >= 0),
            evidence_class text NOT NULL,
            document_type text,
            authority_ref text,
            uploader_id text NOT NULL,
            recorder_id text NOT NULL,
            signer_id text,
            issuer_id text,
            source text NOT NULL,
            provenance text NOT NULL,
            initial_scope_hash text NOT NULL,
            initial_scope_json jsonb NOT NULL,
            created_at timestamptz NOT NULL,
            valid_from timestamptz,
            valid_until timestamptz,
            PRIMARY KEY (tenant_id, evidence_id, version)
          );

          CREATE TABLE IF NOT EXISTS document_lifecycle (
            tenant_id text NOT NULL,
            evidence_id text NOT NULL,
            version integer NOT NULL,
            scan_status text NOT NULL CHECK (scan_status IN ('PENDING', 'CLEAN', 'THREAT')),
            document_state text NOT NULL,
            valid_until timestamptz,
            rejection_reason text,
            superseded_by_version integer,
            updated_at timestamptz NOT NULL,
            PRIMARY KEY (tenant_id, evidence_id, version),
            FOREIGN KEY (tenant_id, evidence_id, version)
              REFERENCES evidence_versions (tenant_id, evidence_id, version)
          );

          CREATE TABLE IF NOT EXISTS document_transitions (
            transition_row_id text PRIMARY KEY,
            tenant_id text NOT NULL,
            evidence_id text NOT NULL,
            version integer NOT NULL,
            transition_id text NOT NULL,
            from_state text NOT NULL,
            to_state text NOT NULL,
            actor_id text NOT NULL,
            occurred_at timestamptz NOT NULL,
            details jsonb NOT NULL
          );

          CREATE TABLE IF NOT EXISTS evidence_validations (
            validation_id text PRIMARY KEY,
            seq bigserial NOT NULL,
            tenant_id text NOT NULL,
            project_id text NOT NULL,
            evidence_id text NOT NULL,
            evidence_version integer NOT NULL,
            content_hash text NOT NULL,
            evidence_class text NOT NULL,
            verdict text NOT NULL CHECK (verdict IN ('VALID', 'INVALID')),
            validator_id text NOT NULL,
            assignment_id text NOT NULL,
            assignment_version integer NOT NULL,
            scope_hash text NOT NULL,
            scope_json jsonb NOT NULL,
            dependency_epoch integer NOT NULL,
            authorization_state text,
            authorization_version_current boolean,
            reason text NOT NULL,
            validated_at timestamptz NOT NULL
          );

          CREATE TABLE IF NOT EXISTS verified_scope_coverages (
            coverage_id text PRIMARY KEY,
            tenant_id text NOT NULL,
            evidence_id text NOT NULL,
            evidence_version integer NOT NULL,
            scope_hash text NOT NULL,
            scope_json jsonb NOT NULL,
            validator_id text NOT NULL,
            reason text NOT NULL,
            created_at timestamptz NOT NULL,
            UNIQUE (tenant_id, evidence_id, evidence_version, scope_hash)
          );

          CREATE TABLE IF NOT EXISTS technical_stamps (
            stamp_id text PRIMARY KEY,
            tenant_id text NOT NULL,
            evidence_id text NOT NULL,
            evidence_version integer NOT NULL,
            uploader_id text NOT NULL,
            signer_id text NOT NULL,
            signer_assignment_id text NOT NULL,
            signer_assignment_version integer NOT NULL,
            validator_id text NOT NULL,
            recorder_id text NOT NULL,
            scope_hash text NOT NULL,
            recorded_at timestamptz NOT NULL
          );

          CREATE TABLE IF NOT EXISTS assertion_records (
            assertion_id text PRIMARY KEY,
            seq bigserial NOT NULL,
            tenant_id text NOT NULL,
            project_id text NOT NULL,
            entity_code text NOT NULL,
            reported_status text NOT NULL,
            authority_ref text NOT NULL,
            evidence_id text NOT NULL,
            evidence_version integer NOT NULL,
            actor_id text NOT NULL,
            quarantined boolean NOT NULL,
            conflict_detected boolean NOT NULL,
            supersedes_assertion_id text,
            independent_approval_verified boolean NOT NULL,
            reason text NOT NULL,
            evidence_links jsonb NOT NULL,
            scope_hash text NOT NULL,
            created_at timestamptz NOT NULL
          );

          CREATE TABLE IF NOT EXISTS reliance_evaluations (
            evaluation_id text PRIMARY KEY,
            seq bigserial NOT NULL,
            tenant_id text NOT NULL,
            project_id text NOT NULL,
            evidence_id text NOT NULL,
            evidence_version integer NOT NULL,
            status text NOT NULL CHECK (status IN ('PENDING', 'VERIFIED', 'SCOPE_MISMATCH', 'EXPIRED')),
            quarantined boolean NOT NULL,
            conflict_detected boolean NOT NULL,
            validator_id text NOT NULL,
            scope_hash text NOT NULL,
            dependency_epoch integer NOT NULL,
            reason text NOT NULL,
            evaluated_at timestamptz NOT NULL
          );

          CREATE TABLE IF NOT EXISTS gate_snapshots (
            snapshot_id text PRIMARY KEY,
            tenant_id text NOT NULL,
            gate_name text NOT NULL,
            project_id text NOT NULL,
            package_id text NOT NULL,
            plot_ids jsonb NOT NULL,
            scope_version integer NOT NULL,
            design_revision text NOT NULL,
            requirement_snapshot_id text NOT NULL,
            evidence_version_ids jsonb NOT NULL,
            scope_hash text NOT NULL,
            dependency_epoch integer NOT NULL,
            status text NOT NULL CHECK (status IN ('READY', 'BLOCKED')),
            created_at timestamptz NOT NULL
          );

          CREATE TABLE IF NOT EXISTS event_handler_receipts (
            tenant_id text NOT NULL,
            handler_name text NOT NULL,
            event_id text NOT NULL,
            dependency_epoch integer NOT NULL,
            revalidation_status text NOT NULL,
            processed_at timestamptz NOT NULL,
            PRIMARY KEY (tenant_id, handler_name, event_id)
          );

          DROP TRIGGER IF EXISTS immutable_evidence_versions ON evidence_versions;
          CREATE TRIGGER immutable_evidence_versions BEFORE UPDATE OR DELETE ON evidence_versions
            FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

          DROP TRIGGER IF EXISTS immutable_document_transitions ON document_transitions;
          CREATE TRIGGER immutable_document_transitions BEFORE UPDATE OR DELETE ON document_transitions
            FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

          DROP TRIGGER IF EXISTS immutable_evidence_validations ON evidence_validations;
          CREATE TRIGGER immutable_evidence_validations BEFORE UPDATE OR DELETE ON evidence_validations
            FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

          DROP TRIGGER IF EXISTS immutable_verified_scope_coverages ON verified_scope_coverages;
          CREATE TRIGGER immutable_verified_scope_coverages BEFORE UPDATE OR DELETE ON verified_scope_coverages
            FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

          DROP TRIGGER IF EXISTS immutable_technical_stamps ON technical_stamps;
          CREATE TRIGGER immutable_technical_stamps BEFORE UPDATE OR DELETE ON technical_stamps
            FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

          DROP TRIGGER IF EXISTS immutable_assertion_records ON assertion_records;
          CREATE TRIGGER immutable_assertion_records BEFORE UPDATE OR DELETE ON assertion_records
            FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

          DROP TRIGGER IF EXISTS immutable_reliance_evaluations ON reliance_evaluations;
          CREATE TRIGGER immutable_reliance_evaluations BEFORE UPDATE OR DELETE ON reliance_evaluations
            FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

          DROP TRIGGER IF EXISTS immutable_gate_snapshots ON gate_snapshots;
          CREATE TRIGGER immutable_gate_snapshots BEFORE UPDATE OR DELETE ON gate_snapshots
            FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

          DROP TRIGGER IF EXISTS immutable_event_handler_receipts ON event_handler_receipts;
          CREATE TRIGGER immutable_event_handler_receipts BEFORE UPDATE OR DELETE ON event_handler_receipts
            FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
        `);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async close() {
      await dbPool.end();
    },

    async uploadEvidenceVersion(credential, input) {
      const now = clock();
      const principal = await authorization.resolve(credential, now);
      if (!principal) {
        return { ok: false, code: "UNAUTHENTICATED", reason: "Invalid session" };
      }
      const auth = authorization.authorize(
        principal,
        { transitionId: "EV-UPLOAD", scope: input.scope, mode: "EXECUTE" },
        now,
      );
      if (!auth.allowed) {
        return { ok: false, code: auth.code, reason: auth.reason };
      }
      if (
        !input.evidenceId?.trim() ||
        !Number.isSafeInteger(input.version) ||
        input.version <= 0 ||
        !input.projectId?.trim() ||
        !(input.content instanceof Uint8Array) ||
        input.content.byteLength === 0 ||
        !input.mediaType?.trim() ||
        !input.source?.trim() ||
        !input.provenance?.trim()
      ) {
        return { ok: false, code: "INVALID_INPUT", reason: "Missing required evidence version fields" };
      }
      const validFromMs = validIsoDate(input.validFrom);
      const validUntilMs = validIsoDate(input.validUntil);
      if (Number.isNaN(validFromMs) || Number.isNaN(validUntilMs)) {
        return { ok: false, code: "INVALID_INPUT", reason: "Malformed validity interval timestamps" };
      }
      if (validFromMs !== null && validUntilMs !== null && validUntilMs <= validFromMs) {
        return { ok: false, code: "INVALID_INPUT", reason: "validUntil must be after validFrom" };
      }

      const computedHash = sha256Hex(input.content);
      if (input.expectedContentHash !== undefined && input.expectedContentHash !== computedHash) {
        return { ok: false, code: "HASH_MISMATCH", reason: "Content SHA-256 does not match expectedContentHash" };
      }

      const objectKey = `${principal.tenantId}/${input.evidenceId}/v${input.version}/${computedHash}`;
      // External storage adapter call happens strictly outside the database transaction
      const stored = await storage.putObject({
        objectKey,
        content: input.content,
        mediaType: input.mediaType,
      });

      const initialScopeHash = computeScopeBindingHash(input.scope, false);

      return withTransaction(async (client, txNow) => {
        const reAuthed = await resolveAndAuthorize(client, credential, txNow, "EV-UPLOAD", input.scope);
        if (!reAuthed.ok) return reAuthed;

        const nowIso = txNow.toISOString();
        await ensureProjectRow(client, reAuthed.principal.tenantId, input.projectId, nowIso);

        const existing = await client.query<{ max_ver: number | null }>(
          `SELECT MAX(version) AS max_ver FROM evidence_versions WHERE tenant_id = $1 AND evidence_id = $2`,
          [reAuthed.principal.tenantId, input.evidenceId],
        );
        const maxVer = existing.rows[0]?.max_ver ?? 0;
        if (input.version !== maxVer + 1) {
          return {
            ok: false,
            code: "VERSION_CONFLICT",
            reason: `Expected sequential version ${maxVer + 1}, received ${input.version}`,
          };
        }

        await client.query(
          `INSERT INTO evidence_versions (
            tenant_id, evidence_id, version, project_id, object_key, content_hash, media_type, byte_size,
            evidence_class, document_type, authority_ref, uploader_id, recorder_id, signer_id, issuer_id,
            source, provenance, initial_scope_hash, initial_scope_json, created_at, valid_from, valid_until
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22)`,
          [
            reAuthed.principal.tenantId,
            input.evidenceId,
            input.version,
            input.projectId,
            stored.objectKey,
            computedHash,
            input.mediaType,
            input.content.byteLength,
            input.evidenceClass,
            input.documentType,
            input.authorityRef,
            reAuthed.principal.actorId,
            reAuthed.principal.actorId,
            input.signerId,
            input.issuerId,
            input.source,
            input.provenance,
            initialScopeHash,
            JSON.stringify(normalizeScopeForHash(input.scope, false)),
            nowIso,
            input.validFrom,
            input.validUntil,
          ],
        );

        await client.query(
          `INSERT INTO document_lifecycle (
            tenant_id, evidence_id, version, scan_status, document_state, valid_until, updated_at
          ) VALUES ($1,$2,$3,'PENDING','UPLOADED',$4,$5)`,
          [reAuthed.principal.tenantId, input.evidenceId, input.version, input.validUntil, nowIso],
        );

        const record: EvidenceVersionRecord = Object.freeze({
          evidenceId: input.evidenceId,
          version: input.version,
          tenantId: reAuthed.principal.tenantId,
          projectId: input.projectId,
          objectKey: stored.objectKey,
          contentHash: computedHash,
          mediaType: input.mediaType,
          byteSize: input.content.byteLength,
          evidenceClass: input.evidenceClass,
          documentType: input.documentType,
          authorityRef: input.authorityRef,
          uploaderId: reAuthed.principal.actorId,
          recorderId: reAuthed.principal.actorId,
          signerId: input.signerId,
          issuerId: input.issuerId,
          source: input.source,
          provenance: input.provenance,
          createdAt: nowIso,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
          scanStatus: "PENDING",
          documentState: "UPLOADED",
        });
        return { ok: true, record };
      });
    },

    async transitionDocument(credential, input) {
      const rule = SM10_TRANSITION_RULES.find(
        (r) => r.machineId === "SM_10_document" && r.id === input.transitionId,
      );
      if (!rule) {
        return { ok: false, code: "UNKNOWN_TRANSITION", reason: `Unknown SM_10 transition ${input.transitionId}` };
      }

      if (input.transitionId === "S10-T04") {
        return {
          ok: false,
          code: "USE_VALIDATE_EVIDENCE",
          reason: "S10-T04 must be executed via validateEvidence command",
        };
      }

      // Phase 1: check and transition inside transaction
      let scanRequest: {
        tenantId: string;
        objectKey: string;
        contentHash: string;
        mediaType: string;
        byteSize: number;
      } | null = null;

      const txResult = await withTransaction(async (client, txNow) => {
        const auth = await resolveAndAuthorize(client, credential, txNow, input.transitionId, input.scope);
        if (!auth.ok) return auth;

        const rowRes = await client.query<{
          project_id: string;
          object_key: string;
          content_hash: string;
          media_type: string;
          byte_size: number;
          evidence_class: EvidenceClass;
          document_type: string | null;
          authority_ref: string | null;
          scan_status: "PENDING" | "CLEAN" | "THREAT";
          document_state: DocumentLifecycleState;
          valid_until: Date | null;
        }>(
          `SELECT v.project_id, v.object_key, v.content_hash, v.media_type, v.byte_size,
                  v.evidence_class, v.document_type, v.authority_ref,
                  l.scan_status, l.document_state, l.valid_until
           FROM evidence_versions v
           JOIN document_lifecycle l
             ON l.tenant_id = v.tenant_id AND l.evidence_id = v.evidence_id AND l.version = v.version
           WHERE v.tenant_id = $1 AND v.evidence_id = $2 AND v.version = $3
           FOR UPDATE OF l`,
          [auth.principal.tenantId, input.evidenceId, input.version],
        );

        if (rowRes.rowCount === 0) {
          return { ok: false as const, code: "NOT_FOUND", reason: "Evidence version not found" };
        }
        const doc = rowRes.rows[0];
        if (!rule.from.includes(doc.document_state)) {
          return {
            ok: false as const,
            code: "INVALID_STATE",
            reason: `Cannot execute ${rule.id} from state ${doc.document_state}`,
          };
        }

        const nowMs = txNow.getTime();
        const nowIso = txNow.toISOString();
        const validUntilMs = doc.valid_until ? doc.valid_until.getTime() : null;

        // Evaluate SM_10_document local guards strictly fail-closed
        if (rule.id === "S10-T01") {
          const hashComputed = /^[0-9a-f]{64}$/.test(doc.content_hash);
          const fileTypeAllowed = ALLOWED_MEDIA_TYPES.has(doc.media_type);
          const sizeWithinLimit = doc.byte_size > 0 && doc.byte_size <= MAX_DOCUMENT_BYTES;
          if (!hashComputed || !fileTypeAllowed || !sizeWithinLimit) {
            return { ok: false as const, code: "GUARD_FAILED", reason: "S10-T01 scan prerequisite guards failed" };
          }
          scanRequest = {
            tenantId: auth.principal.tenantId,
            objectKey: doc.object_key,
            contentHash: doc.content_hash,
            mediaType: doc.media_type,
            byteSize: doc.byte_size,
          };
        } else if (rule.id === "S10-T02") {
          if (doc.scan_status !== "CLEAN") {
            return { ok: false as const, code: "GUARD_FAILED", reason: "Guard scan_clean failed" };
          }
        } else if (rule.id === "S10-T03") {
          if (doc.scan_status !== "THREAT") {
            return { ok: false as const, code: "GUARD_FAILED", reason: "Guard scan_threat_detected failed" };
          }
        } else if (rule.id === "S10-T05") {
          const needsExpiry = REGULATED_CLASSES.has(doc.evidence_class);
          const expiryPresent = !needsExpiry || validUntilMs !== null;
          const scanClean = doc.scan_status === "CLEAN";
          const notExpired = validUntilMs === null || validUntilMs > nowMs;
          let validationCurrent = true;
          if (REGULATED_CLASSES.has(doc.evidence_class)) {
            const proj = await ensureProjectRow(client, auth.principal.tenantId, doc.project_id, nowIso);
            const valRes = await client.query<{ verdict: string; dependency_epoch: number }>(
              `SELECT verdict, dependency_epoch FROM evidence_validations
               WHERE tenant_id = $1 AND evidence_id = $2 AND evidence_version = $3
               ORDER BY seq DESC LIMIT 1`,
              [auth.principal.tenantId, input.evidenceId, input.version],
            );
            validationCurrent =
              valRes.rowCount !== null &&
              valRes.rowCount > 0 &&
              valRes.rows[0].verdict === "VALID" &&
              valRes.rows[0].dependency_epoch === proj.dependency_epoch;
          }
          if (!expiryPresent || !scanClean || !notExpired || !validationCurrent) {
            return { ok: false as const, code: "GUARD_FAILED", reason: "S10-T05 activation guards failed" };
          }
        } else if (rule.id === "S10-T06") {
          if (validUntilMs === null || validUntilMs <= nowMs || validUntilMs - nowMs > NINETY_DAYS_MS) {
            return { ok: false as const, code: "GUARD_FAILED", reason: "Guard expiry_within_90_days failed" };
          }
        } else if (rule.id === "S10-T07") {
          if (validUntilMs === null || validUntilMs > nowMs) {
            return { ok: false as const, code: "GUARD_FAILED", reason: "Guard expiry_date_passed failed" };
          }
          await ensureProjectRow(client, auth.principal.tenantId, doc.project_id, nowIso);
          await client.query(
            `UPDATE projects
             SET dependency_epoch = dependency_epoch + 1,
                 revalidation_status = 'REQUIRED',
                 updated_at = $3
             WHERE tenant_id = $1 AND project_id = $2`,
            [auth.principal.tenantId, doc.project_id, nowIso],
          );
        } else if (rule.id === "S10-T08") {
          const renewedMs = validIsoDate(input.renewedValidUntil ?? null);
          if (
            input.renewedDocumentValidated !== true ||
            renewedMs === null ||
            Number.isNaN(renewedMs) ||
            renewedMs <= nowMs
          ) {
            return { ok: false as const, code: "GUARD_FAILED", reason: "Guard renewed_document_validated failed" };
          }
          await client.query(
            `UPDATE document_lifecycle SET valid_until = $4 WHERE tenant_id = $1 AND evidence_id = $2 AND version = $3`,
            [auth.principal.tenantId, input.evidenceId, input.version, input.renewedValidUntil],
          );
        } else if (rule.id === "S10-T09") {
          if (typeof input.rejectionReason !== "string" || input.rejectionReason.trim().length === 0) {
            return { ok: false as const, code: "GUARD_FAILED", reason: "Guard rejection_reason_recorded failed" };
          }
          await client.query(
            `UPDATE document_lifecycle SET rejection_reason = $4 WHERE tenant_id = $1 AND evidence_id = $2 AND version = $3`,
            [auth.principal.tenantId, input.evidenceId, input.version, input.rejectionReason.trim()],
          );
        } else if (rule.id === "S10-T10") {
          if (
            !Number.isSafeInteger(input.replacementVersion) ||
            (input.replacementVersion as number) <= input.version
          ) {
            return { ok: false as const, code: "GUARD_FAILED", reason: "Guard replacement_document_active failed" };
          }
          const repRes = await client.query<{ document_state: string }>(
            `SELECT document_state FROM document_lifecycle
             WHERE tenant_id = $1 AND evidence_id = $2 AND version = $3`,
            [auth.principal.tenantId, input.evidenceId, input.replacementVersion],
          );
          if (repRes.rowCount === 0 || repRes.rows[0].document_state !== "ACTIVE") {
            return { ok: false as const, code: "GUARD_FAILED", reason: "Guard replacement_document_active failed" };
          }
          await client.query(
            `UPDATE document_lifecycle SET superseded_by_version = $4 WHERE tenant_id = $1 AND evidence_id = $2 AND version = $3`,
            [auth.principal.tenantId, input.evidenceId, input.version, input.replacementVersion],
          );
          await ensureProjectRow(client, auth.principal.tenantId, doc.project_id, nowIso);
          await client.query(
            `UPDATE projects
             SET dependency_epoch = dependency_epoch + 1,
                 revalidation_status = 'REQUIRED',
                 updated_at = $3
             WHERE tenant_id = $1 AND project_id = $2`,
            [auth.principal.tenantId, doc.project_id, nowIso],
          );
        }

        const nextState = rule.to as DocumentLifecycleState;
        await client.query(
          `UPDATE document_lifecycle
           SET document_state = $4, updated_at = $5
           WHERE tenant_id = $1 AND evidence_id = $2 AND version = $3`,
          [auth.principal.tenantId, input.evidenceId, input.version, nextState, nowIso],
        );

        await client.query(
          `INSERT INTO document_transitions (
            transition_row_id, tenant_id, evidence_id, version, transition_id,
            from_state, to_state, actor_id, occurred_at, details
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [
            randomUUID(),
            auth.principal.tenantId,
            input.evidenceId,
            input.version,
            rule.id,
            doc.document_state,
            nextState,
            auth.principal.actorId,
            nowIso,
            JSON.stringify({
              effects: rule.effects,
              drexMode: rule.id === "S10-T02" ? "OFF" : undefined,
              rejectionReason: input.rejectionReason ?? null,
              replacementVersion: input.replacementVersion ?? null,
            }),
          ],
        );

        return {
          ok: true as const,
          state: nextState,
          ...(rule.id === "S10-T02" ? { drexMode: "OFF" as const, hostedExtractionCalled: false } : {}),
        };
      });

      // If S10-T01 succeeded, run the external scan adapter outside the DB transaction and persist scan_status
      if (txResult.ok && input.transitionId === "S10-T01" && scanRequest !== null) {
        const req = scanRequest as {
          tenantId: string;
          objectKey: string;
          contentHash: string;
          mediaType: string;
          byteSize: number;
        };
        const scanOutcome = await scan.scanObject({
          objectKey: req.objectKey,
          contentHash: req.contentHash,
          mediaType: req.mediaType,
          byteSize: req.byteSize,
        });
        await withTransaction(async (client, txNow) => {
          await client.query(
            `UPDATE document_lifecycle
             SET scan_status = $4, updated_at = $5
             WHERE tenant_id = $1 AND evidence_id = $2 AND version = $3`,
            [
              req.tenantId,
              input.evidenceId,
              input.version,
              scanOutcome.status === "CLEAN" ? "CLEAN" : "THREAT",
              txNow.toISOString(),
            ],
          );
        });
      }

      return txResult;
    },

    async validateEvidence(credential, input) {
      if (!input.reason || input.reason.trim().length === 0) {
        return { ok: false, code: "INVALID_INPUT", reason: "Validation reason is required" };
      }
      return withTransaction(async (client, txNow) => {
        const principal = await authorization.resolve(credential, txNow, client);
        if (!principal) {
          return { ok: false, code: "UNAUTHENTICATED", reason: "Invalid session" };
        }

        const rowRes = await client.query<{
          project_id: string;
          content_hash: string;
          evidence_class: EvidenceClass;
          document_type: string | null;
          authority_ref: string | null;
          uploader_id: string;
          scan_status: "PENDING" | "CLEAN" | "THREAT";
          document_state: DocumentLifecycleState;
        }>(
          `SELECT v.project_id, v.content_hash, v.evidence_class, v.document_type, v.authority_ref, v.uploader_id,
                  l.scan_status, l.document_state
           FROM evidence_versions v
           JOIN document_lifecycle l
             ON l.tenant_id = v.tenant_id AND l.evidence_id = v.evidence_id AND l.version = v.version
           WHERE v.tenant_id = $1 AND v.evidence_id = $2 AND v.version = $3
           FOR UPDATE OF l`,
          [principal.tenantId, input.evidenceId, input.version],
        );

        if (rowRes.rowCount === 0) {
          return { ok: false, code: "NOT_FOUND", reason: "Evidence version not found" };
        }
        const doc = rowRes.rows[0];
        if (doc.document_state !== "EXTRACTED" && doc.document_state !== "VALIDATED") {
          return {
            ok: false,
            code: "INVALID_STATE",
            reason: `Evidence cannot be validated from state ${doc.document_state}`,
          };
        }

        const nowIso = txNow.toISOString();
        const proj = await ensureProjectRow(client, principal.tenantId, doc.project_id, nowIso);
        const scopeHash = computeScopeBindingHash(input.scope, false);
        const transitionId = input.dualControlTransitionId ?? "S10-T04";
        const commandHash = computeCommandBindingHash({
          transitionId,
          evidenceId: input.evidenceId,
          version: input.version,
          scopeHash,
        });

        const authContext: AuthorizationContext = {
          commandHash,
          scopeHash,
          dependencyEpoch: proj.dependency_epoch,
          evidence: {
            class: doc.evidence_class,
            uploaderId: doc.uploader_id,
            authorizationState: input.authorizationState,
            authorizationVersionCurrent: input.authorizationVersionCurrent,
          },
          approvals: input.approvals,
        };

        // Always authorize S10-T04 for evidence-class / self-validation policy, and also dualControlTransitionId if specified
        const decisionS10 = authorization.authorize(
          principal,
          { transitionId: "S10-T04", scope: input.scope, context: authContext, mode: "EXECUTE" },
          txNow,
        );
        if (!decisionS10.allowed) {
          return { ok: false, code: decisionS10.code, reason: decisionS10.reason };
        }
        if (input.dualControlTransitionId) {
          const decisionDual = authorization.authorize(
            principal,
            {
              transitionId: input.dualControlTransitionId,
              scope: input.scope,
              context: authContext,
              mode: "EXECUTE",
            },
            txNow,
          );
          if (!decisionDual.allowed) {
            return { ok: false, code: decisionDual.code, reason: decisionDual.reason };
          }
        }

        // Check S10-T04 local guards: document_type_identified, authority_reference_present_if_required, hash_verified
        const docTypeOk = typeof doc.document_type === "string" && doc.document_type.trim().length > 0;
        const needsAuthRef =
          doc.evidence_class === "AUTHORITY_APPROVAL" ||
          doc.evidence_class === "NOC" ||
          doc.evidence_class === "EXEMPTION" ||
          doc.evidence_class === "WAIVER";
        const authRefOk =
          !needsAuthRef || (typeof doc.authority_ref === "string" && doc.authority_ref.trim().length > 0);
        const hashOk = /^[0-9a-f]{64}$/.test(doc.content_hash) && doc.scan_status === "CLEAN";
        if (!docTypeOk || !authRefOk || !hashOk) {
          return { ok: false, code: "GUARD_FAILED", reason: "S10-T04 validation guards failed" };
        }

        const matchedAssignment = principal.assignments.find((a) => a.active && a.verified) ?? principal.assignments[0];
        const validationId = randomUUID();

        await client.query(
          `INSERT INTO evidence_validations (
            validation_id, tenant_id, project_id, evidence_id, evidence_version, content_hash,
            evidence_class, verdict, validator_id, assignment_id, assignment_version,
            scope_hash, scope_json, dependency_epoch, authorization_state,
            authorization_version_current, reason, validated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)`,
          [
            validationId,
            principal.tenantId,
            doc.project_id,
            input.evidenceId,
            input.version,
            doc.content_hash,
            doc.evidence_class,
            input.verdict,
            principal.actorId,
            matchedAssignment.id,
            matchedAssignment.version,
            scopeHash,
            JSON.stringify(normalizeScopeForHash(input.scope, false)),
            proj.dependency_epoch,
            input.authorizationState ?? null,
            input.authorizationVersionCurrent ?? null,
            input.reason.trim(),
            nowIso,
          ],
        );

        if (input.verdict === "VALID") {
          await client.query(
            `INSERT INTO verified_scope_coverages (
              coverage_id, tenant_id, evidence_id, evidence_version, scope_hash, scope_json,
              validator_id, reason, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
            ON CONFLICT (tenant_id, evidence_id, evidence_version, scope_hash) DO NOTHING`,
            [
              randomUUID(),
              principal.tenantId,
              input.evidenceId,
              input.version,
              scopeHash,
              JSON.stringify(normalizeScopeForHash(input.scope, false)),
              principal.actorId,
              input.reason.trim(),
              nowIso,
            ],
          );
        }

        const nextState: DocumentLifecycleState = input.verdict === "VALID" ? "VALIDATED" : doc.document_state;
        if (doc.document_state !== nextState) {
          await client.query(
            `UPDATE document_lifecycle
             SET document_state = $4, updated_at = $5
             WHERE tenant_id = $1 AND evidence_id = $2 AND version = $3`,
            [principal.tenantId, input.evidenceId, input.version, nextState, nowIso],
          );
          await client.query(
            `INSERT INTO document_transitions (
              transition_row_id, tenant_id, evidence_id, version, transition_id,
              from_state, to_state, actor_id, occurred_at, details
            ) VALUES ($1,$2,$3,$4,'S10-T04',$5,$6,$7,$8,$9::jsonb)`,
            [
              randomUUID(),
              principal.tenantId,
              input.evidenceId,
              input.version,
              doc.document_state,
              nextState,
              principal.actorId,
              nowIso,
              JSON.stringify({ validationId, verdict: input.verdict }),
            ],
          );
        }

        return { ok: true, validationId, documentState: nextState };
      });
    },

    async recordTechnicalStamp(credential, input) {
      return withTransaction(async (client, txNow) => {
        const principal = await authorization.resolve(credential, txNow, client);
        if (!principal) {
          return { ok: false, code: "UNAUTHENTICATED", reason: "Invalid session" };
        }

        const docRes = await client.query<{
          project_id: string;
          evidence_class: EvidenceClass;
          uploader_id: string;
          signer_id: string | null;
        }>(
          `SELECT project_id, evidence_class, uploader_id, signer_id
           FROM evidence_versions
           WHERE tenant_id = $1 AND evidence_id = $2 AND version = $3`,
          [principal.tenantId, input.evidenceId, input.version],
        );
        if (docRes.rowCount === 0) {
          return { ok: false, code: "NOT_FOUND", reason: "Evidence version not found" };
        }
        const doc = docRes.rows[0];

        const valRes = await client.query<{
          verdict: string;
          validator_id: string;
          authorization_state: string | null;
          authorization_version_current: boolean | null;
        }>(
          `SELECT verdict, validator_id, authorization_state, authorization_version_current
           FROM evidence_validations
           WHERE tenant_id = $1 AND evidence_id = $2 AND evidence_version = $3
           ORDER BY seq DESC LIMIT 1`,
          [principal.tenantId, input.evidenceId, input.version],
        );

        const latestVal = valRes.rows[0];
        const independentValidationVerified =
          !!latestVal &&
          latestVal.verdict === "VALID" &&
          latestVal.validator_id !== doc.uploader_id &&
          latestVal.authorization_state === "INSPECTION_ACTIVE" &&
          latestVal.authorization_version_current === true;

        const proj = await ensureProjectRow(
          client,
          principal.tenantId,
          doc.project_id,
          txNow.toISOString(),
        );
        const scopeHash = computeScopeBindingHash(input.scope, false);
        const commandHash = computeCommandBindingHash({
          transitionId: "S2DS-T03",
          evidenceId: input.evidenceId,
          version: input.version,
          scopeHash,
        });

        const decision = authorization.authorize(
          principal,
          {
            transitionId: "S2DS-T03",
            scope: input.scope,
            mode: "EXECUTE",
            context: {
              commandHash,
              scopeHash,
              dependencyEpoch: proj.dependency_epoch,
              evidence: {
                class: doc.evidence_class,
                uploaderId: doc.uploader_id,
                signerId: input.signerId,
                signerAssignment: input.signerAssignment,
                authorizationState: input.authorizationState,
                authorizationVersionCurrent: input.authorizationVersionCurrent,
                independentValidationVerified,
              },
            },
          },
          txNow,
        );
        if (!decision.allowed) {
          return { ok: false, code: decision.code, reason: decision.reason };
        }

        const stampId = randomUUID();
        await client.query(
          `INSERT INTO technical_stamps (
            stamp_id, tenant_id, evidence_id, evidence_version, uploader_id,
            signer_id, signer_assignment_id, signer_assignment_version,
            validator_id, recorder_id, scope_hash, recorded_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            stampId,
            principal.tenantId,
            input.evidenceId,
            input.version,
            doc.uploader_id,
            input.signerId,
            input.signerAssignment.id,
            input.signerAssignment.version,
            latestVal.validator_id,
            principal.actorId,
            scopeHash,
            txNow.toISOString(),
          ],
        );

        return {
          ok: true,
          stamp: {
            stampId,
            evidenceId: input.evidenceId,
            evidenceVersion: input.version,
            uploaderId: doc.uploader_id,
            signerId: input.signerId,
            validatorId: latestVal.validator_id,
            recorderId: principal.actorId,
          },
        };
      });
    },

    async recordAuthorityFact(credential, input) {
      return withTransaction(async (client, txNow) => {
        const auth = await resolveAndAuthorize(client, credential, txNow, "EV-RECORD-FACT", input.scope);
        if (!auth.ok) return auth;

        const nowIso = txNow.toISOString();
        await ensureProjectRow(client, auth.principal.tenantId, input.projectId, nowIso);

        // Recording an authority fact does NOT validate regulated evidence; check if already independently validated
        const valRes = await client.query<{ verdict: string }>(
          `SELECT verdict FROM evidence_validations
           WHERE tenant_id = $1 AND evidence_id = $2 AND evidence_version = $3 AND verdict = 'VALID'
           ORDER BY seq DESC LIMIT 1`,
          [auth.principal.tenantId, input.evidenceId, input.evidenceVersion],
        );
        const isValidated = (valRes.rowCount ?? 0) > 0;
        const quarantined = !isValidated || input.conflictDetected;
        const scopeHash = computeScopeBindingHash(input.scope, false);
        const evidenceLink = `${input.evidenceId}:${input.evidenceVersion}`;

        await client.query(
          `INSERT INTO assertion_records (
            assertion_id, tenant_id, project_id, entity_code, reported_status, authority_ref,
            evidence_id, evidence_version, actor_id, quarantined, conflict_detected,
            supersedes_assertion_id, independent_approval_verified, reason, evidence_links,
            scope_hash, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,false,$12,$13::jsonb,$14,$15)`,
          [
            input.assertionId,
            auth.principal.tenantId,
            input.projectId,
            input.entityCode,
            input.reportedStatus,
            input.authorityRef,
            input.evidenceId,
            input.evidenceVersion,
            auth.principal.actorId,
            quarantined,
            input.conflictDetected,
            input.notes,
            JSON.stringify([evidenceLink]),
            scopeHash,
            nowIso,
          ],
        );

        const assertion: AuthorityAssertionRecord = Object.freeze({
          assertionId: input.assertionId,
          projectId: input.projectId,
          entityCode: input.entityCode,
          reportedStatus: input.reportedStatus,
          authorityRef: input.authorityRef,
          evidenceId: input.evidenceId,
          evidenceVersion: input.evidenceVersion,
          actorId: auth.principal.actorId,
          quarantined,
          conflictDetected: input.conflictDetected,
          supersedesAssertionId: null,
          independentApprovalVerified: false,
          reason: input.notes,
          evidenceLinks: Object.freeze([evidenceLink]),
          createdAt: nowIso,
        });
        return { ok: true, assertion };
      });
    },

    async evaluateReliance(credential, input) {
      return withTransaction(async (client, txNow) => {
        const auth = await resolveAndAuthorize(client, credential, txNow, "EV-EVAL-RELIANCE", input.scope);
        if (!auth.ok) return auth;

        const docRes = await client.query<{
          project_id: string;
          evidence_class: EvidenceClass;
          scan_status: "PENDING" | "CLEAN" | "THREAT";
          document_state: DocumentLifecycleState;
          valid_until: Date | null;
        }>(
          `SELECT v.project_id, v.evidence_class, l.scan_status, l.document_state, l.valid_until
           FROM evidence_versions v
           JOIN document_lifecycle l
             ON l.tenant_id = v.tenant_id AND l.evidence_id = v.evidence_id AND l.version = v.version
           WHERE v.tenant_id = $1 AND v.evidence_id = $2 AND v.version = $3`,
          [auth.principal.tenantId, input.evidenceId, input.version],
        );
        if (docRes.rowCount === 0) {
          return { ok: false, code: "NOT_FOUND", reason: "Evidence version not found" };
        }
        const doc = docRes.rows[0];
        const nowIso = txNow.toISOString();
        const nowMs = txNow.getTime();
        const proj = await ensureProjectRow(client, auth.principal.tenantId, doc.project_id, nowIso);
        const scopeHash = computeScopeBindingHash(input.scope, false);

        const valRes = await client.query<{ verdict: string }>(
          `SELECT verdict FROM evidence_validations
           WHERE tenant_id = $1 AND evidence_id = $2 AND evidence_version = $3
           ORDER BY seq DESC LIMIT 1`,
          [auth.principal.tenantId, input.evidenceId, input.version],
        );
        const hasValidVerdict = (valRes.rowCount ?? 0) > 0 && valRes.rows[0].verdict === "VALID";

        const covRes = await client.query(
          `SELECT 1 FROM verified_scope_coverages
           WHERE tenant_id = $1 AND evidence_id = $2 AND evidence_version = $3 AND scope_hash = $4`,
          [auth.principal.tenantId, input.evidenceId, input.version, scopeHash],
        );
        const hasScopeCoverage = (covRes.rowCount ?? 0) > 0;

        const assertRes = await client.query<{ conflict_detected: boolean; quarantined: boolean }>(
          `SELECT conflict_detected, quarantined FROM assertion_records
           WHERE tenant_id = $1 AND evidence_id = $2 AND evidence_version = $3
           ORDER BY seq DESC LIMIT 1`,
          [auth.principal.tenantId, input.evidenceId, input.version],
        );
        const conflictDetected = assertRes.rows[0]?.conflict_detected === true;
        const validUntilMs = doc.valid_until ? doc.valid_until.getTime() : null;
        const isExpired =
          doc.document_state === "EXPIRED" || (validUntilMs !== null && validUntilMs <= nowMs);

        let status: RelianceStatus;
        let quarantined = false;
        if (isExpired) {
          status = "EXPIRED";
          quarantined = true;
        } else if (
          !hasValidVerdict ||
          doc.document_state !== "ACTIVE" ||
          doc.scan_status !== "CLEAN" ||
          conflictDetected ||
          input.scope.kind !== "PACKAGE_GATE"
        ) {
          status = "PENDING";
          quarantined = true;
        } else if (!hasScopeCoverage) {
          status = "SCOPE_MISMATCH";
          quarantined = true;
        } else {
          status = "VERIFIED";
          quarantined = false;
        }

        const evaluationId = randomUUID();
        await client.query(
          `INSERT INTO reliance_evaluations (
            evaluation_id, tenant_id, project_id, evidence_id, evidence_version,
            status, quarantined, conflict_detected, validator_id, scope_hash,
            dependency_epoch, reason, evaluated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            evaluationId,
            auth.principal.tenantId,
            doc.project_id,
            input.evidenceId,
            input.version,
            status,
            quarantined,
            conflictDetected,
            auth.principal.actorId,
            scopeHash,
            proj.dependency_epoch,
            input.reason,
            nowIso,
          ],
        );

        const evaluation: RelianceEvaluationRecord = Object.freeze({
          evaluationId,
          evidenceId: input.evidenceId,
          evidenceVersion: input.version,
          status,
          quarantined,
          conflictDetected,
          validatorId: auth.principal.actorId,
          scopeHash,
          dependencyEpoch: proj.dependency_epoch,
          reason: input.reason,
          evaluatedAt: nowIso,
        });
        return { ok: true, evaluation };
      });
    },

    async getCurrentReliance(evidenceId, version, scope) {
      const scopeHash = computeScopeBindingHash(scope, false);
      const now = clock();
      const res = await dbPool.query<{
        evaluation_id: string;
        status: RelianceStatus;
        quarantined: boolean;
        conflict_detected: boolean;
        validator_id: string;
        dependency_epoch: number;
        reason: string;
        evaluated_at: Date;
        current_epoch: number;
        valid_until: Date | null;
        document_state: DocumentLifecycleState;
      }>(
        `SELECT r.evaluation_id, r.status, r.quarantined, r.conflict_detected, r.validator_id,
                r.dependency_epoch, r.reason, r.evaluated_at,
                p.dependency_epoch AS current_epoch,
                l.valid_until, l.document_state
         FROM "${schema}".reliance_evaluations r
         JOIN "${schema}".projects p ON p.tenant_id = r.tenant_id AND p.project_id = r.project_id
         JOIN "${schema}".document_lifecycle l
           ON l.tenant_id = r.tenant_id AND l.evidence_id = r.evidence_id AND l.version = r.evidence_version
         WHERE r.evidence_id = $1 AND r.evidence_version = $2 AND r.scope_hash = $3
         ORDER BY r.seq DESC LIMIT 1`,
        [evidenceId, version, scopeHash],
      );

      if (res.rowCount === 0) {
        return {
          evaluationId: "unindexed",
          evidenceId,
          evidenceVersion: version,
          status: "PENDING",
          quarantined: true,
          conflictDetected: false,
          validatorId: "",
          scopeHash,
          dependencyEpoch: 0,
          reason: "No reliance evaluation recorded for this version and scope",
          evaluatedAt: now.toISOString(),
        };
      }
      const row = res.rows[0];
      const expiredNow =
        row.document_state === "EXPIRED" ||
        (row.valid_until !== null && row.valid_until.getTime() <= now.getTime());
      const staleOrSuperseded =
        row.dependency_epoch !== row.current_epoch ||
        row.document_state === "SUPERSEDED" ||
        row.document_state === "REJECTED";

      const projectedStatus: RelianceStatus = expiredNow
        ? "EXPIRED"
        : staleOrSuperseded && row.status === "VERIFIED"
          ? "PENDING"
          : row.status;

      return {
        evaluationId: row.evaluation_id,
        evidenceId,
        evidenceVersion: version,
        status: projectedStatus,
        quarantined: projectedStatus !== "VERIFIED" || row.quarantined,
        conflictDetected: row.conflict_detected,
        validatorId: row.validator_id,
        scopeHash,
        dependencyEpoch: row.dependency_epoch,
        reason: row.reason,
        evaluatedAt: row.evaluated_at.toISOString(),
      };
    },

    async registerVerifiedScopeCoverage(credential, input) {
      if (input.scope.kind !== "PACKAGE_GATE") {
        return { ok: false, code: "INVALID_SCOPE", reason: "Only PACKAGE_GATE scope can register package coverage" };
      }
      return withTransaction(async (client, txNow) => {
        const auth = await resolveAndAuthorize(client, credential, txNow, "EV-REGISTER-COVERAGE", input.scope);
        if (!auth.ok) return auth;

        const valRes = await client.query<{ verdict: string }>(
          `SELECT verdict FROM evidence_validations
           WHERE tenant_id = $1 AND evidence_id = $2 AND evidence_version = $3 AND verdict = 'VALID'
           ORDER BY seq DESC LIMIT 1`,
          [auth.principal.tenantId, input.evidenceId, input.version],
        );
        if (valRes.rowCount === 0) {
          return {
            ok: false,
            code: "UNVALIDATED_EVIDENCE",
            reason: "Cannot register scope coverage for unvalidated evidence",
          };
        }

        const coverageId = randomUUID();
        const scopeHash = computeScopeBindingHash(input.scope, false);
        await client.query(
          `INSERT INTO verified_scope_coverages (
            coverage_id, tenant_id, evidence_id, evidence_version, scope_hash, scope_json,
            validator_id, reason, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
          ON CONFLICT (tenant_id, evidence_id, evidence_version, scope_hash) DO NOTHING`,
          [
            coverageId,
            auth.principal.tenantId,
            input.evidenceId,
            input.version,
            scopeHash,
            JSON.stringify(normalizeScopeForHash(input.scope, false)),
            auth.principal.actorId,
            input.reason,
            txNow.toISOString(),
          ],
        );
        return { ok: true, coverageId };
      });
    },

    async createGateSnapshot(credential, input) {
      if (input.scope.kind !== "PACKAGE_GATE") {
        return {
          ok: false,
          code: "PROVISIONAL_OR_PROJECT_SCOPE_FORBIDDEN",
          reason: "Only complete PACKAGE_GATE bindings can create or satisfy a package gate snapshot",
        };
      }
      if (input.scope.evidenceVersionIds.length === 0) {
        return {
          ok: false,
          code: "EMPTY_EVIDENCE_BINDING",
          reason: "Gate snapshot requires at least one verified evidence version",
        };
      }
      const gateScope = input.scope;
      return withTransaction(async (client, txNow) => {
        const auth = await resolveAndAuthorize(client, credential, txNow, "EV-CREATE-GATE-SNAPSHOT", gateScope);
        if (!auth.ok) return auth;

        const nowIso = txNow.toISOString();
        const nowMs = txNow.getTime();
        const proj = await ensureProjectRow(client, auth.principal.tenantId, gateScope.projectId, nowIso);
        const scopeHash = computeScopeBindingHash(gateScope, false);

        for (const evRef of gateScope.evidenceVersionIds) {
          const [evId, verStr] = evRef.split(":");
          const ver = Number(verStr);
          if (!evId || !Number.isSafeInteger(ver) || ver <= 0) {
            return { ok: false, code: "INVALID_EVIDENCE_REF", reason: `Invalid evidenceVersionId ${evRef}` };
          }
          const relRes = await client.query<{
            status: RelianceStatus;
            quarantined: boolean;
            conflict_detected: boolean;
            dependency_epoch: number;
            valid_until: Date | null;
            document_state: DocumentLifecycleState;
          }>(
            `SELECT r.status, r.quarantined, r.conflict_detected, r.dependency_epoch,
                    l.valid_until, l.document_state
             FROM reliance_evaluations r
             JOIN document_lifecycle l
               ON l.tenant_id = r.tenant_id AND l.evidence_id = r.evidence_id AND l.version = r.evidence_version
             WHERE r.tenant_id = $1 AND r.evidence_id = $2 AND r.evidence_version = $3 AND r.scope_hash = $4
             ORDER BY r.seq DESC LIMIT 1`,
            [auth.principal.tenantId, evId, ver, scopeHash],
          );
          if (relRes.rowCount === 0) {
            return { ok: false, code: "RELIANCE_NOT_VERIFIED", reason: `Missing reliance for ${evRef}` };
          }
          const rel = relRes.rows[0];
          const expired =
            rel.document_state === "EXPIRED" ||
            (rel.valid_until !== null && rel.valid_until.getTime() <= nowMs);
          if (
            expired ||
            rel.status !== "VERIFIED" ||
            rel.quarantined ||
            rel.conflict_detected ||
            rel.dependency_epoch !== proj.dependency_epoch ||
            rel.document_state !== "ACTIVE"
          ) {
            return {
              ok: false,
              code: "RELIANCE_NOT_VERIFIED",
              reason: `Evidence ${evRef} is not currently VERIFIED for this scope and epoch`,
            };
          }
        }

        await client.query(
          `INSERT INTO gate_snapshots (
            snapshot_id, tenant_id, gate_name, project_id, package_id, plot_ids,
            scope_version, design_revision, requirement_snapshot_id, evidence_version_ids,
            scope_hash, dependency_epoch, status, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12,'READY',$13)`,
          [
            input.snapshotId,
            auth.principal.tenantId,
            input.gateName,
            gateScope.projectId,
            gateScope.packageId,
            JSON.stringify([...gateScope.plotIds]),
            gateScope.scopeVersion,
            gateScope.designRevision,
            gateScope.requirementSnapshotId,
            JSON.stringify([...gateScope.evidenceVersionIds]),
            scopeHash,
            proj.dependency_epoch,
            nowIso,
          ],
        );

        const snapshot: GateSnapshotRecord = Object.freeze({
          snapshotId: input.snapshotId,
          gateName: input.gateName,
          projectId: gateScope.projectId,
          packageId: gateScope.packageId,
          plotIds: Object.freeze([...gateScope.plotIds]),
          scopeVersion: gateScope.scopeVersion,
          designRevision: gateScope.designRevision,
          requirementSnapshotId: gateScope.requirementSnapshotId,
          evidenceVersionIds: Object.freeze([...gateScope.evidenceVersionIds]),
          dependencyEpoch: proj.dependency_epoch,
          status: "READY",
          createdAt: nowIso,
        });
        return { ok: true, snapshot };
      });
    },

    async evaluateGateEligibility(credential, input) {
      if (input.targetScope.kind !== "PACKAGE_GATE") {
        return { eligible: false, code: "INVALID_SCOPE", reason: "Package gate requires PACKAGE_GATE scope" };
      }
      return withTransaction(async (client, txNow) => {
        const auth = await resolveAndAuthorize(client, credential, txNow, "EV-EVAL-GATE", input.targetScope);
        if (!auth.ok) {
          return { eligible: false, code: auth.code, reason: auth.reason };
        }

        const snapRes = await client.query<{
          project_id: string;
          scope_hash: string;
          dependency_epoch: number;
          evidence_version_ids: string[];
          status: string;
        }>(
          `SELECT project_id, scope_hash, dependency_epoch, evidence_version_ids, status
           FROM gate_snapshots
           WHERE tenant_id = $1 AND snapshot_id = $2`,
          [auth.principal.tenantId, input.snapshotId],
        );
        if (snapRes.rowCount === 0) {
          return { eligible: false, code: "SNAPSHOT_NOT_FOUND", reason: "Gate snapshot not found" };
        }
        const snap = snapRes.rows[0];
        const targetScopeHash = computeScopeBindingHash(input.targetScope, false);
        if (snap.scope_hash !== targetScopeHash) {
          return { eligible: false, code: "SCOPE_MISMATCH", reason: "Target scope does not match gate snapshot" };
        }

        const proj = await ensureProjectRow(
          client,
          auth.principal.tenantId,
          snap.project_id,
          txNow.toISOString(),
        );
        if (
          snap.status !== "READY" ||
          snap.dependency_epoch !== proj.dependency_epoch ||
          proj.revalidation_status !== "CLEAR"
        ) {
          return {
            eligible: false,
            code: "STALE_SNAPSHOT",
            reason: "Gate snapshot epoch is stale or project requires revalidation",
          };
        }

        const nowMs = txNow.getTime();
        for (const evRef of snap.evidence_version_ids) {
          const [evId, verStr] = evRef.split(":");
          const ver = Number(verStr);
          const docRes = await client.query<{
            document_state: DocumentLifecycleState;
            valid_until: Date | null;
            scan_status: string;
          }>(
            `SELECT document_state, valid_until, scan_status
             FROM document_lifecycle
             WHERE tenant_id = $1 AND evidence_id = $2 AND version = $3`,
            [auth.principal.tenantId, evId, ver],
          );
          if (docRes.rowCount === 0) {
            return { eligible: false, code: "EVIDENCE_MISSING", reason: `Evidence ${evRef} missing` };
          }
          const d = docRes.rows[0];
          if (d.document_state === "EXPIRED" || (d.valid_until !== null && d.valid_until.getTime() <= nowMs)) {
            return {
              eligible: false,
              code: "EVIDENCE_EXPIRED",
              reason: `Evidence ${evRef} expired at injected clock`,
            };
          }
          if (d.document_state !== "ACTIVE" || d.scan_status !== "CLEAN") {
            return {
              eligible: false,
              code: "EVIDENCE_INACTIVE",
              reason: `Evidence ${evRef} is in state ${d.document_state}`,
            };
          }
        }

        return { eligible: true };
      });
    },

    async invalidateDependency(credential, input) {
      if (!MATERIAL_CHANGE_KINDS.has(input.changeKind) || !input.reason?.trim()) {
        return { ok: false, code: "INVALID_INPUT", reason: "Known material changeKind and reason are required" };
      }
      return withTransaction(async (client, txNow) => {
        const auth = await resolveAndAuthorize(client, credential, txNow, "EV-INVALIDATE-DEP", input.scope);
        if (!auth.ok) return auth;

        const nowIso = txNow.toISOString();
        await ensureProjectRow(client, auth.principal.tenantId, input.projectId, nowIso);
        const updated = await client.query<{ dependency_epoch: number }>(
          `UPDATE projects
           SET dependency_epoch = dependency_epoch + 1,
               revalidation_status = 'REQUIRED',
               updated_at = $3
           WHERE tenant_id = $1 AND project_id = $2
           RETURNING dependency_epoch`,
          [auth.principal.tenantId, input.projectId, nowIso],
        );

        return {
          ok: true,
          dependencyEpoch: updated.rows[0].dependency_epoch,
          revalidationStatus: "REQUIRED",
        };
      });
    },

    async processRelianceInvalidatedEvent(credential, input) {
      if (!input.eventId?.trim() || !input.handlerName?.trim() || !MATERIAL_CHANGE_KINDS.has(input.changeKind)) {
        return { ok: false, code: "INVALID_INPUT", reason: "Invalid reliance.invalidated event envelope" };
      }
      return withTransaction(async (client, txNow) => {
        const auth = await resolveAndAuthorize(
          client,
          credential,
          txNow,
          "EV-RELIANCE-INVALIDATED-EVENT",
          input.scope,
        );
        if (!auth.ok) return auth;

        const nowIso = txNow.toISOString();
        const proj = await ensureProjectRow(client, auth.principal.tenantId, input.projectId, nowIso);

        const existingReceipt = await client.query<{
          dependency_epoch: number;
          revalidation_status: "REQUIRED";
        }>(
          `SELECT dependency_epoch, revalidation_status
           FROM event_handler_receipts
           WHERE tenant_id = $1 AND handler_name = $2 AND event_id = $3`,
          [auth.principal.tenantId, input.handlerName, input.eventId],
        );

        const latestAssertion = await client.query<{ reported_status: string }>(
          `SELECT reported_status FROM assertion_records
           WHERE tenant_id = $1 AND project_id = $2
           ORDER BY seq DESC LIMIT 1`,
          [auth.principal.tenantId, input.projectId],
        );
        const preservedStatus = latestAssertion.rows[0]?.reported_status ?? null;

        if ((existingReceipt.rowCount ?? 0) > 0) {
          return {
            ok: true,
            deduped: true,
            dependencyEpoch: proj.dependency_epoch,
            revalidationStatus: "REQUIRED",
            authorityReportedStatusPreserved: preservedStatus,
          };
        }

        const updated = await client.query<{ dependency_epoch: number }>(
          `UPDATE projects
           SET dependency_epoch = dependency_epoch + 1,
               revalidation_status = 'REQUIRED',
               updated_at = $3
           WHERE tenant_id = $1 AND project_id = $2
           RETURNING dependency_epoch`,
          [auth.principal.tenantId, input.projectId, nowIso],
        );
        const newEpoch = updated.rows[0].dependency_epoch;

        await client.query(
          `INSERT INTO event_handler_receipts (
            tenant_id, handler_name, event_id, dependency_epoch, revalidation_status, processed_at
          ) VALUES ($1,$2,$3,$4,'REQUIRED',$5)`,
          [auth.principal.tenantId, input.handlerName, input.eventId, newEpoch, nowIso],
        );

        return {
          ok: true,
          deduped: false,
          dependencyEpoch: newEpoch,
          revalidationStatus: "REQUIRED",
          authorityReportedStatusPreserved: preservedStatus,
        };
      });
    },

    async recoverRevalidation(credential, input) {
      if (input.scope.kind !== "PACKAGE_GATE") {
        return { ok: false, code: "INVALID_SCOPE", reason: "Revalidation recovery requires PACKAGE_GATE scope" };
      }
      return withTransaction(async (client, txNow) => {
        const auth = await resolveAndAuthorize(client, credential, txNow, "EV-RECOVER-REVALIDATION", input.scope);
        if (!auth.ok) return auth;

        const nowIso = txNow.toISOString();
        const proj = await ensureProjectRow(client, auth.principal.tenantId, input.projectId, nowIso);
        const snapRes = await client.query<{
          dependency_epoch: number;
          status: string;
          scope_hash: string;
        }>(
          `SELECT dependency_epoch, status, scope_hash
           FROM gate_snapshots
           WHERE tenant_id = $1 AND snapshot_id = $2 AND project_id = $3`,
          [auth.principal.tenantId, input.snapshotId, input.projectId],
        );

        const targetScopeHash = computeScopeBindingHash(input.scope, false);
        if (
          snapRes.rowCount === 0 ||
          snapRes.rows[0].status !== "READY" ||
          snapRes.rows[0].dependency_epoch !== proj.dependency_epoch ||
          snapRes.rows[0].scope_hash !== targetScopeHash
        ) {
          return {
            ok: false,
            code: "FRESH_GATE_SNAPSHOT_REQUIRED",
            reason: "Recovery requires a fresh READY gate snapshot evaluated at the current dependency epoch",
          };
        }

        await client.query(
          `UPDATE projects SET revalidation_status = 'CLEAR', updated_at = $3
           WHERE tenant_id = $1 AND project_id = $2`,
          [auth.principal.tenantId, input.projectId, nowIso],
        );
        return { ok: true, revalidationStatus: "CLEAR" };
      });
    },

    async appendAdminCorrection(credential, input) {
      if (
        !input.correctionId?.trim() ||
        !input.sourceAssertionId?.trim() ||
        !input.reason?.trim() ||
        !Array.isArray(input.evidenceLinks) ||
        input.evidenceLinks.length === 0
      ) {
        return {
          ok: false,
          code: "INVALID_INPUT",
          reason: "Admin correction requires reason, sourceAssertionId, replacementAssertion, and evidenceLinks",
        };
      }
      return withTransaction(async (client, txNow) => {
        const principal = await authorization.resolve(credential, txNow, client);
        if (!principal) {
          return { ok: false, code: "UNAUTHENTICATED", reason: "Invalid session" };
        }

        const decisionAdmin = authorization.authorize(
          principal,
          { transitionId: "EV-ADMIN-CORRECTION", scope: input.scope, mode: "EXECUTE" },
          txNow,
        );
        if (!decisionAdmin.allowed) {
          return { ok: false, code: decisionAdmin.code, reason: decisionAdmin.reason };
        }

        const sourceRes = await client.query<{
          evidence_id: string;
          evidence_version: number;
          conflict_detected: boolean;
        }>(
          `SELECT evidence_id, evidence_version, conflict_detected
           FROM assertion_records
           WHERE tenant_id = $1 AND assertion_id = $2 AND project_id = $3`,
          [principal.tenantId, input.sourceAssertionId, input.projectId],
        );
        if (sourceRes.rowCount === 0) {
          return { ok: false, code: "SOURCE_ASSERTION_NOT_FOUND", reason: "Source assertion not found" };
        }
        const src = sourceRes.rows[0];
        const nowIso = txNow.toISOString();
        const proj = await ensureProjectRow(client, principal.tenantId, input.projectId, nowIso);
        const scopeHash = computeScopeBindingHash(input.scope, false);

        let independentApprovalVerified = false;
        if (input.regulated && input.dualControlTransitionId && input.approvals) {
          const commandHash = computeCommandBindingHash({
            transitionId: input.dualControlTransitionId,
            evidenceId: src.evidence_id,
            version: src.evidence_version,
            scopeHash,
          });
          const dualDecision = authorization.authorize(
            principal,
            {
              transitionId: "EV-ADMIN-CORRECTION-DUAL",
              scope: input.scope,
              mode: "EXECUTE",
              context: {
                commandHash,
                scopeHash,
                dependencyEpoch: proj.dependency_epoch,
                approvals: input.approvals,
              },
            },
            txNow,
          );
          if (!dualDecision.allowed) {
            return { ok: false, code: dualDecision.code, reason: dualDecision.reason };
          }
          independentApprovalVerified = true;
        }

        // Regulated corrections remain quarantined for reliance until ordinary independent evidence validation + gate recompute
        const valRes = await client.query<{ verdict: string }>(
          `SELECT verdict FROM evidence_validations
           WHERE tenant_id = $1 AND evidence_id = $2 AND evidence_version = $3 AND verdict = 'VALID'
           ORDER BY seq DESC LIMIT 1`,
          [principal.tenantId, src.evidence_id, src.evidence_version],
        );
        const hasOrdinaryValidation = (valRes.rowCount ?? 0) > 0;
        const quarantined = input.regulated ? !(independentApprovalVerified && hasOrdinaryValidation) : false;

        await client.query(
          `INSERT INTO assertion_records (
            assertion_id, tenant_id, project_id, entity_code, reported_status, authority_ref,
            evidence_id, evidence_version, actor_id, quarantined, conflict_detected,
            supersedes_assertion_id, independent_approval_verified, reason, evidence_links,
            scope_hash, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)`,
          [
            input.correctionId,
            principal.tenantId,
            input.projectId,
            input.replacementAssertion.entityCode,
            input.replacementAssertion.reportedStatus,
            input.replacementAssertion.authorityRef,
            src.evidence_id,
            src.evidence_version,
            principal.actorId,
            quarantined,
            src.conflict_detected,
            input.sourceAssertionId,
            independentApprovalVerified,
            input.reason.trim(),
            JSON.stringify([...input.evidenceLinks]),
            scopeHash,
            nowIso,
          ],
        );

        const correction: AuthorityAssertionRecord = Object.freeze({
          assertionId: input.correctionId,
          projectId: input.projectId,
          entityCode: input.replacementAssertion.entityCode,
          reportedStatus: input.replacementAssertion.reportedStatus,
          authorityRef: input.replacementAssertion.authorityRef,
          evidenceId: src.evidence_id,
          evidenceVersion: src.evidence_version,
          actorId: principal.actorId,
          quarantined,
          conflictDetected: src.conflict_detected,
          supersedesAssertionId: input.sourceAssertionId,
          independentApprovalVerified,
          reason: input.reason.trim(),
          evidenceLinks: Object.freeze([...input.evidenceLinks]),
          createdAt: nowIso,
        });
        return { ok: true, correction };
      });
    },

    async attemptDirectStateEdit(_credential, input) {
      return {
        ok: false,
        code: "DIRECT_STATE_EDIT_FORBIDDEN",
        reason: `Direct state write to ${input.targetId} (${input.desiredState}) is prohibited by behavioral_contract.correction.direct_state_write=false`,
      };
    },

    async computeDualControlBinding(input) {
      const scopeHash = computeScopeBindingHash(input.scope, false);
      const commandHash = computeCommandBindingHash({
        transitionId: input.transitionId,
        evidenceId: input.evidenceId,
        version: input.version,
        scopeHash,
      });
      const projectId =
        input.scope.kind === "PROVISIONAL_PLOT_SCOPE" ? input.scope.provisionalCaseId : input.scope.projectId;
      const proj = await this.getProjectState(projectId);
      return {
        commandHash,
        scopeHash,
        dependencyEpoch: proj.dependencyEpoch,
      };
    },

    async getEvidenceVersion(evidenceId, version) {
      const res = await dbPool.query<{
        evidence_id: string;
        version: number;
        tenant_id: string;
        project_id: string;
        object_key: string;
        content_hash: string;
        media_type: string;
        byte_size: number;
        evidence_class: EvidenceClass;
        document_type: string | null;
        authority_ref: string | null;
        uploader_id: string;
        recorder_id: string;
        signer_id: string | null;
        issuer_id: string | null;
        source: string;
        provenance: string;
        created_at: Date;
        valid_from: Date | null;
        valid_until: Date | null;
        scan_status: "PENDING" | "CLEAN" | "THREAT";
        document_state: DocumentLifecycleState;
      }>(
        `SELECT v.evidence_id, v.version, v.tenant_id, v.project_id, v.object_key, v.content_hash,
                v.media_type, v.byte_size, v.evidence_class, v.document_type, v.authority_ref,
                v.uploader_id, v.recorder_id, v.signer_id, v.issuer_id, v.source, v.provenance,
                v.created_at, v.valid_from, l.valid_until, l.scan_status, l.document_state
         FROM "${schema}".evidence_versions v
         JOIN "${schema}".document_lifecycle l
           ON l.tenant_id = v.tenant_id AND l.evidence_id = v.evidence_id AND l.version = v.version
         WHERE v.evidence_id = $1 AND v.version = $2`,
        [evidenceId, version],
      );
      if (res.rowCount === 0) return null;
      const r = res.rows[0];
      return Object.freeze({
        evidenceId: r.evidence_id,
        version: r.version,
        tenantId: r.tenant_id,
        projectId: r.project_id,
        objectKey: r.object_key,
        contentHash: r.content_hash,
        mediaType: r.media_type,
        byteSize: r.byte_size,
        evidenceClass: r.evidence_class,
        documentType: r.document_type,
        authorityRef: r.authority_ref,
        uploaderId: r.uploader_id,
        recorderId: r.recorder_id,
        signerId: r.signer_id,
        issuerId: r.issuer_id,
        source: r.source,
        provenance: r.provenance,
        createdAt: r.created_at.toISOString(),
        validFrom: r.valid_from ? r.valid_from.toISOString() : null,
        validUntil: r.valid_until ? r.valid_until.toISOString() : null,
        scanStatus: r.scan_status,
        documentState: r.document_state,
      });
    },

    async getProjectState(projectId) {
      const res = await dbPool.query<{
        dependency_epoch: number;
        revalidation_status: "CLEAR" | "REQUIRED";
      }>(
        `SELECT dependency_epoch, revalidation_status
         FROM "${schema}".projects
         WHERE project_id = $1
         LIMIT 1`,
        [projectId],
      );
      if (res.rowCount === 0) {
        return { dependencyEpoch: 0, revalidationStatus: "CLEAR" };
      }
      return {
        dependencyEpoch: res.rows[0].dependency_epoch,
        revalidationStatus: res.rows[0].revalidation_status,
      };
    },

    async getAssertionHistory(projectId, entityCode) {
      const res = await dbPool.query<{
        assertion_id: string;
        project_id: string;
        entity_code: string;
        reported_status: string;
        authority_ref: string;
        evidence_id: string;
        evidence_version: number;
        actor_id: string;
        quarantined: boolean;
        conflict_detected: boolean;
        supersedes_assertion_id: string | null;
        independent_approval_verified: boolean;
        reason: string;
        evidence_links: string[];
        created_at: Date;
      }>(
        `SELECT assertion_id, project_id, entity_code, reported_status, authority_ref,
                evidence_id, evidence_version, actor_id, quarantined, conflict_detected,
                supersedes_assertion_id, independent_approval_verified, reason,
                evidence_links, created_at
         FROM "${schema}".assertion_records
         WHERE project_id = $1 AND entity_code = $2
         ORDER BY seq ASC`,
        [projectId, entityCode],
      );
      return Object.freeze(
        res.rows.map((r) =>
          Object.freeze({
            assertionId: r.assertion_id,
            projectId: r.project_id,
            entityCode: r.entity_code,
            reportedStatus: r.reported_status,
            authorityRef: r.authority_ref,
            evidenceId: r.evidence_id,
            evidenceVersion: r.evidence_version,
            actorId: r.actor_id,
            quarantined: r.quarantined,
            conflictDetected: r.conflict_detected,
            supersedesAssertionId: r.supersedes_assertion_id,
            independentApprovalVerified: r.independent_approval_verified,
            reason: r.reason,
            evidenceLinks: Object.freeze([...r.evidence_links]),
            createdAt: r.created_at.toISOString(),
          }),
        ),
      );
    },
  };

  return Object.freeze(port);
}
