import type {
  ApprovalFact,
  AuthorizationPort,
  EvidenceAuthorizationFact,
  RoleAssignment,
  ScopeBinding,
} from "../../contracts/foundation";
import type { Pool } from "pg";
import {
  EVIDENCE_TRANSITION_RULES,
  SM10_TRANSITION_RULES,
  createEvidenceService,
} from "./vault";

export type EvidenceClass = EvidenceAuthorizationFact["class"];

export type DocumentLifecycleState =
  | "UPLOADED"
  | "SCANNING"
  | "QUARANTINED"
  | "EXTRACTED"
  | "VALIDATED"
  | "ACTIVE"
  | "EXPIRING"
  | "EXPIRED"
  | "REJECTED"
  | "SUPERSEDED";

export type RelianceStatus = "PENDING" | "VERIFIED" | "SCOPE_MISMATCH" | "EXPIRED";

export interface StorageAdapter {
  putObject(input: {
    objectKey: string;
    content: Uint8Array;
    mediaType: string;
  }): Promise<{ objectKey: string; contentHash: string; byteSize: number }>;
}

export interface ScanAdapter {
  scanObject(input: {
    objectKey: string;
    contentHash: string;
    mediaType: string;
    byteSize: number;
  }): Promise<{ status: "CLEAN" | "THREAT"; engine: string; details?: string }>;
}

export interface EvidenceVersionRecord {
  readonly evidenceId: string;
  readonly version: number;
  readonly tenantId: string;
  readonly projectId: string;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly evidenceClass: EvidenceClass;
  readonly documentType: string | null;
  readonly authorityRef: string | null;
  readonly uploaderId: string;
  readonly recorderId: string;
  readonly signerId: string | null;
  readonly issuerId: string | null;
  readonly source: string;
  readonly provenance: string;
  readonly createdAt: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly scanStatus: "PENDING" | "CLEAN" | "THREAT";
  readonly documentState: DocumentLifecycleState;
}

export interface RelianceEvaluationRecord {
  readonly evaluationId: string;
  readonly evidenceId: string;
  readonly evidenceVersion: number;
  readonly status: RelianceStatus;
  readonly quarantined: boolean;
  readonly conflictDetected: boolean;
  readonly validatorId: string;
  readonly scopeHash: string;
  readonly dependencyEpoch: number;
  readonly reason: string;
  readonly evaluatedAt: string;
}

export interface AuthorityAssertionRecord {
  readonly assertionId: string;
  readonly projectId: string;
  readonly entityCode: string;
  readonly reportedStatus: string;
  readonly authorityRef: string;
  readonly evidenceId: string;
  readonly evidenceVersion: number;
  readonly actorId: string;
  readonly quarantined: boolean;
  readonly conflictDetected: boolean;
  readonly supersedesAssertionId: string | null;
  readonly independentApprovalVerified: boolean;
  readonly reason: string;
  readonly evidenceLinks: readonly string[];
  readonly createdAt: string;
}

export interface GateSnapshotRecord {
  readonly snapshotId: string;
  readonly gateName: string;
  readonly projectId: string;
  readonly packageId: string;
  readonly plotIds: readonly string[];
  readonly scopeVersion: number;
  readonly designRevision: string;
  readonly requirementSnapshotId: string;
  readonly evidenceVersionIds: readonly string[];
  readonly dependencyEpoch: number;
  readonly status: "READY" | "BLOCKED";
  readonly createdAt: string;
}

export interface EvidenceServiceOptions {
  database: Pool | { pool: Pool; schema?: string };
  clock: () => Date;
  storage: StorageAdapter;
  scan: ScanAdapter;
  authorization: AuthorizationPort;
}

export interface EvidenceServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  isInTransaction(): boolean;
  uploadEvidenceVersion(
    credential: unknown,
    input: {
      evidenceId: string;
      version: number;
      projectId: string;
      scope: ScopeBinding;
      content: Uint8Array;
      expectedContentHash?: string;
      mediaType: string;
      evidenceClass: EvidenceClass;
      documentType: string | null;
      authorityRef: string | null;
      signerId: string | null;
      issuerId: string | null;
      source: string;
      provenance: string;
      validFrom: string | null;
      validUntil: string | null;
    },
  ): Promise<{ ok: true; record: EvidenceVersionRecord } | { ok: false; code: string; reason: string }>;
  transitionDocument(
    credential: unknown,
    input: {
      evidenceId: string;
      version: number;
      transitionId: string;
      scope: ScopeBinding;
      rejectionReason?: string;
      replacementVersion?: number;
      renewedValidUntil?: string;
      renewedDocumentValidated?: boolean;
    },
  ): Promise<
    | { ok: true; state: DocumentLifecycleState; drexMode?: "OFF"; hostedExtractionCalled?: boolean }
    | { ok: false; code: string; reason: string }
  >;
  validateEvidence(
    credential: unknown,
    input: {
      evidenceId: string;
      version: number;
      scope: ScopeBinding;
      verdict: "VALID" | "INVALID";
      reason: string;
      authorizationState?: "INSPECTION_ACTIVE" | "DMT_LICENSING_APPROVED" | "SUSPENDED" | "EXPIRED" | "NONE";
      authorizationVersionCurrent?: boolean;
      dualControlTransitionId?: string;
      approvals?: readonly ApprovalFact[];
    },
  ): Promise<
    | { ok: true; validationId: string; documentState: DocumentLifecycleState }
    | { ok: false; code: string; reason: string }
  >;
  recordTechnicalStamp(
    credential: unknown,
    input: {
      evidenceId: string;
      version: number;
      scope: ScopeBinding;
      signerId: string;
      signerAssignment: RoleAssignment;
      authorizationState: "INSPECTION_ACTIVE" | "DMT_LICENSING_APPROVED" | "SUSPENDED" | "EXPIRED" | "NONE";
      authorizationVersionCurrent: boolean;
    },
  ): Promise<
    | {
        ok: true;
        stamp: {
          stampId: string;
          evidenceId: string;
          evidenceVersion: number;
          uploaderId: string;
          signerId: string;
          validatorId: string;
          recorderId: string;
        };
      }
    | { ok: false; code: string; reason: string }
  >;
  recordAuthorityFact(
    credential: unknown,
    input: {
      assertionId: string;
      projectId: string;
      scope: ScopeBinding;
      entityCode: string;
      reportedStatus: string;
      authorityRef: string;
      evidenceId: string;
      evidenceVersion: number;
      conflictDetected: boolean;
      notes: string;
    },
  ): Promise<{ ok: true; assertion: AuthorityAssertionRecord } | { ok: false; code: string; reason: string }>;
  evaluateReliance(
    credential: unknown,
    input: {
      evidenceId: string;
      version: number;
      scope: ScopeBinding;
      reason: string;
    },
  ): Promise<{ ok: true; evaluation: RelianceEvaluationRecord } | { ok: false; code: string; reason: string }>;
  getCurrentReliance(
    evidenceId: string,
    version: number,
    scope: ScopeBinding,
  ): Promise<RelianceEvaluationRecord>;
  registerVerifiedScopeCoverage(
    credential: unknown,
    input: {
      evidenceId: string;
      version: number;
      scope: ScopeBinding;
      reason: string;
    },
  ): Promise<{ ok: true; coverageId: string } | { ok: false; code: string; reason: string }>;
  createGateSnapshot(
    credential: unknown,
    input: {
      snapshotId: string;
      gateName: string;
      scope: ScopeBinding;
    },
  ): Promise<{ ok: true; snapshot: GateSnapshotRecord } | { ok: false; code: string; reason: string }>;
  evaluateGateEligibility(
    credential: unknown,
    input: {
      snapshotId: string;
      targetScope: ScopeBinding;
    },
  ): Promise<{ eligible: true } | { eligible: false; code: string; reason: string }>;
  invalidateDependency(
    credential: unknown,
    input: {
      projectId: string;
      scope: ScopeBinding;
      changeKind:
        | "expiry"
        | "revocation"
        | "suspension"
        | "scope_change"
        | "design_revision_change"
        | "requirement_change"
        | "evidence_supersession"
        | "exemption_revocation";
      reason: string;
    },
  ): Promise<{ ok: true; dependencyEpoch: number; revalidationStatus: "REQUIRED" } | { ok: false; code: string; reason: string }>;
  processRelianceInvalidatedEvent(
    credential: unknown,
    input: {
      eventId: string;
      handlerName: string;
      projectId: string;
      scope: ScopeBinding;
      changeKind:
        | "expiry"
        | "revocation"
        | "suspension"
        | "scope_change"
        | "design_revision_change"
        | "requirement_change"
        | "evidence_supersession"
        | "exemption_revocation";
      reason: string;
    },
  ): Promise<
    | {
        ok: true;
        deduped: boolean;
        dependencyEpoch: number;
        revalidationStatus: "REQUIRED";
        authorityReportedStatusPreserved: string | null;
      }
    | { ok: false; code: string; reason: string }
  >;
  recoverRevalidation(
    credential: unknown,
    input: {
      projectId: string;
      snapshotId: string;
      scope: ScopeBinding;
    },
  ): Promise<{ ok: true; revalidationStatus: "CLEAR" } | { ok: false; code: string; reason: string }>;
  appendAdminCorrection(
    credential: unknown,
    input: {
      correctionId: string;
      projectId: string;
      scope: ScopeBinding;
      sourceAssertionId: string;
      reason: string;
      replacementAssertion: {
        entityCode: string;
        reportedStatus: string;
        authorityRef: string;
      };
      evidenceLinks: readonly string[];
      regulated: boolean;
      dualControlTransitionId?: string;
      approvals?: readonly ApprovalFact[];
    },
  ): Promise<{ ok: true; correction: AuthorityAssertionRecord } | { ok: false; code: string; reason: string }>;
  attemptDirectStateEdit(
    credential: unknown,
    input: { targetId: string; desiredState: string },
  ): Promise<{ ok: false; code: "DIRECT_STATE_EDIT_FORBIDDEN"; reason: string }>;
  computeDualControlBinding(input: {
    evidenceId: string;
    version: number;
    scope: ScopeBinding;
    transitionId: string;
  }): Promise<{ commandHash: string; scopeHash: string; dependencyEpoch: number }>;
  getEvidenceVersion(evidenceId: string, version: number): Promise<EvidenceVersionRecord | null>;
  getProjectState(projectId: string): Promise<{ dependencyEpoch: number; revalidationStatus: "CLEAR" | "REQUIRED" }>;
  getAssertionHistory(projectId: string, entityCode: string): Promise<readonly AuthorityAssertionRecord[]>;
}

export { EVIDENCE_TRANSITION_RULES, SM10_TRANSITION_RULES, createEvidenceService };
