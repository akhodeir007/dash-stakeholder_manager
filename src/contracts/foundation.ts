/** Server-side foundation ports. These types do not authenticate caller JSON. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type HumanRole = "SYSTEM_ADMIN" | "STAKEHOLDER_MANAGER" | "AOR_LEAD" |
  "THIRD_PARTY_INSPECTOR" | "CLIENT_EXECUTIVE" | "DISCIPLINE_LEAD" | "CONTRACTOR";
export type Role = HumanRole | "SYSTEM";

export type ScopeBinding =
  | { kind: "PROJECT_SCOPE"; projectId: string; scopeVersion: number; evidenceVersionIds: readonly string[] }
  | { kind: "PACKAGE_GATE"; projectId: string; packageId: string; plotIds: readonly string[];
      scopeVersion: number; designRevision: string; requirementSnapshotId: string; evidenceVersionIds: readonly string[] }
  | { kind: "PROVISIONAL_PLOT_SCOPE"; provisionalCaseId: string; plotIds: readonly string[];
      intakeVersion: number; initiatorAssignmentId: string; sourceAssertionIds: readonly string[] };

export type AssignmentScope =
  | { kind: "PROJECT"; projectId: string; allPackages: boolean }
  | { kind: "PACKAGE"; projectId: string; packageId: string; plotIds: readonly string[] }
  | { kind: "PROVISIONAL"; provisionalCaseId: string; plotIds: readonly string[] };

export interface RoleAssignment {
  readonly id: string;
  readonly actorId: string;
  readonly version: number;
  readonly role: Role;
  readonly tenantId: string;
  readonly scope: AssignmentScope;
  readonly verified: boolean;
  readonly active: boolean;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly credentialVerified?: boolean;
}

/** Only a trusted identity verifier may produce this record; never use request claims directly. */
export interface VerifiedSessionRecord {
  readonly actorId: string;
  readonly tenantId: string;
  readonly kind: "HUMAN" | "SERVICE";
  readonly expiresAt: string;
  readonly assignments: readonly RoleAssignment[];
  readonly serviceCapabilities?: readonly string[];
}

/** Runtime trust must be enforced by the issuing authorization service, not this structural type. */
export interface Principal extends VerifiedSessionRecord { readonly issuedAt: string }

export interface TransitionRule {
  readonly id: string;
  readonly machineId: string;
  readonly event: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly roles: readonly Role[];
  readonly guards: readonly string[];
  readonly effects: readonly string[];
  readonly operation: "TRANSITION" | "VALIDATE_EVIDENCE" | "RECORD_STAMP";
  readonly dualControlPairs?: readonly (readonly [Role, Role])[];
  readonly invalidatesDependencies?: boolean;
}

export interface ApprovalFact {
  readonly actorId: string;
  readonly actorKind: "HUMAN" | "SERVICE";
  readonly assignment: RoleAssignment;
  readonly approvedAssignmentVersion: number;
  readonly commandHash: string;
  readonly scopeHash: string;
  readonly dependencyEpoch: number;
  readonly verified: boolean;
  readonly expiresAt: string;
}

export interface EvidenceAuthorizationFact {
  readonly class: "METADATA" | "AUTHORITY_APPROVAL" | "NOC" | "STAMPED_TECHNICAL_DOCUMENT" |
    "LEGAL_AUTHORIZATION" | "EXEMPTION" | "WAIVER";
  readonly uploaderId: string;
  readonly signerId?: string;
  readonly signerAssignment?: RoleAssignment;
  readonly authorizationState?: string;
  readonly authorizationVersionCurrent?: boolean;
  readonly independentValidationVerified?: boolean;
}

/** Loaded by server-owned code within the command transaction, never copied from command payload. */
export interface AuthorizationContext {
  readonly commandHash: string;
  readonly scopeHash: string;
  readonly dependencyEpoch: number;
  readonly approvals?: readonly ApprovalFact[];
  readonly evidence?: EvidenceAuthorizationFact;
}

export interface AuthorizationRequest {
  readonly transitionId: string;
  readonly scope: ScopeBinding;
  readonly context?: AuthorizationContext;
  readonly mode?: "EXECUTE" | "REPLAY";
}

export type AuthorizationDecision = { readonly allowed: true } |
  { readonly allowed: false; readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "APPROVAL_INVALID"; readonly reason: string };

export interface AuthorizationPort {
  resolve(credential: unknown, now: Date, transaction?: unknown): Promise<Principal | null>;
  authorize(principal: Principal, request: AuthorizationRequest, now: Date): AuthorizationDecision;
}

export type IdentityVerifier = (credential: unknown, transaction?: unknown) => Promise<VerifiedSessionRecord | null>;
