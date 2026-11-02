import type { AuthorizationDecision, AuthorizationPort, AuthorizationRequest, IdentityVerifier, Principal, Role, RoleAssignment, ScopeBinding, TransitionRule, VerifiedSessionRecord } from "../contracts/foundation";

interface Options { verifySession: IdentityVerifier; rules: readonly TransitionRule[] }
const HUMAN_ROLES: readonly Role[] = ["SYSTEM_ADMIN", "STAKEHOLDER_MANAGER", "AOR_LEAD", "THIRD_PARTY_INSPECTOR", "CLIENT_EXECUTIVE", "DISCIPLINE_LEAD", "CONTRACTOR"];
const ALL_ROLES: readonly Role[] = [...HUMAN_ROLES, "SYSTEM"];
const EVIDENCE_CLASSES = ["METADATA", "AUTHORITY_APPROVAL", "NOC", "STAMPED_TECHNICAL_DOCUMENT", "LEGAL_AUTHORIZATION", "EXEMPTION", "WAIVER"];
const deny = (code: "UNAUTHENTICATED" | "FORBIDDEN" | "APPROVAL_INVALID", reason: string): AuthorizationDecision => ({ allowed: false, code, reason });
const validDate = (value: unknown): number | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const uniqueTextArray = (value: unknown, nonempty = true): value is string[] => Array.isArray(value) && (!nonempty || value.length > 0) && value.every(text) && new Set(value).size === value.length;
const cloneFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) throw new TypeError("Cyclic trusted input");
  seen.add(value as object);
  let result: unknown;
  if (Array.isArray(value)) result = Object.freeze(value.map(item => cloneFreeze(item, seen)));
  else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("Non-plain trusted input");
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value as object)) out[key] = cloneFreeze(child, seen);
    result = Object.freeze(out);
  }
  seen.delete(value as object);
  return result as T;
};
const validAssignmentShape = (a: unknown): a is RoleAssignment => {
  if (!a || typeof a !== "object") return false;
  const x = a as RoleAssignment;
  if (!text(x.id) || !text(x.actorId) || !positive(x.version) || !ALL_ROLES.includes(x.role) || !text(x.tenantId) || typeof x.verified !== "boolean" || typeof x.active !== "boolean" || validDate(x.validFrom) === null || !(x.validUntil === null || validDate(x.validUntil) !== null) || (x.credentialVerified !== undefined && typeof x.credentialVerified !== "boolean")) return false;
  const s = x.scope;
  if (!s || typeof s !== "object") return false;
  if (s.kind === "PROJECT") return text(s.projectId) && typeof s.allPackages === "boolean";
  if (s.kind === "PACKAGE") return text(s.projectId) && text(s.packageId) && uniqueTextArray(s.plotIds);
  if (s.kind === "PROVISIONAL") return text(s.provisionalCaseId) && uniqueTextArray(s.plotIds);
  return false;
};
const validScope = (s: unknown): s is ScopeBinding => {
  if (!s || typeof s !== "object") return false;
  const x = s as ScopeBinding;
  if (x.kind === "PACKAGE_GATE") return text(x.projectId) && text(x.packageId) && uniqueTextArray(x.plotIds) && positive(x.scopeVersion) && text(x.designRevision) && text(x.requirementSnapshotId) && uniqueTextArray(x.evidenceVersionIds, false);
  if (x.kind === "PROJECT_SCOPE") return text(x.projectId) && positive(x.scopeVersion) && uniqueTextArray(x.evidenceVersionIds, false);
  if (x.kind === "PROVISIONAL_PLOT_SCOPE") return text(x.provisionalCaseId) && uniqueTextArray(x.plotIds) && positive(x.intakeVersion) && text(x.initiatorAssignmentId) && uniqueTextArray(x.sourceAssertionIds);
  return false;
};
const validRule = (r: TransitionRule): boolean => !!r && text(r.id) && text(r.machineId) && text(r.event) && Array.isArray(r.from) && r.from.length > 0 && r.from.every(text) && text(r.to) && Array.isArray(r.roles) && r.roles.length > 0 && r.roles.every(role => ALL_ROLES.includes(role)) && Array.isArray(r.guards) && r.guards.every(text) && Array.isArray(r.effects) && r.effects.every(text) && ["TRANSITION", "VALIDATE_EVIDENCE", "RECORD_STAMP"].includes(r.operation) && (r.dualControlPairs === undefined || (Array.isArray(r.dualControlPairs) && r.dualControlPairs.length > 0 && r.dualControlPairs.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(role => ALL_ROLES.includes(role)))));
const covers = (a: RoleAssignment, s: ScopeBinding): boolean => {
  if (s.kind === "PROVISIONAL_PLOT_SCOPE") return a.scope.kind === "PROVISIONAL" && a.scope.provisionalCaseId === s.provisionalCaseId && s.plotIds.every(x => a.scope.kind === "PROVISIONAL" && a.scope.plotIds.includes(x));
  if (a.scope.kind === "PROVISIONAL") return false;
  if (a.scope.kind === "PROJECT") return a.scope.projectId === s.projectId && (s.kind !== "PACKAGE_GATE" || a.scope.allPackages);
  return s.kind === "PACKAGE_GATE" && a.scope.projectId === s.projectId && a.scope.packageId === s.packageId && s.plotIds.every(x => a.scope.kind === "PACKAGE" && a.scope.plotIds.includes(x));
};
const current = (a: RoleAssignment, tenant: string, now: number, scope: ScopeBinding, role?: Role): boolean => a.actorId.length > 0 && a.tenantId === tenant && a.verified && a.active && (validDate(a.validFrom) ?? Infinity) <= now && (a.validUntil === null || (validDate(a.validUntil) ?? -Infinity) > now) && covers(a, scope) && (!role || a.role === role);

export function createAuthorizationService({ verifySession, rules }: Options): AuthorizationPort {
  if (typeof verifySession !== "function" || !Array.isArray(rules)) throw new TypeError("Trusted verifier and reviewed rules are required");
  const issued = new WeakSet<object>(); const registry = new Map<string, TransitionRule>();
  for (const rule of rules) {
    if (!validRule(rule) || registry.has(rule.id)) throw new TypeError("Invalid or duplicate transition rule");
    try { registry.set(rule.id, cloneFreeze(rule)); } catch { throw new TypeError("Invalid cyclic transition rule"); }
  }
  const port: AuthorizationPort = {
    async resolve(credential, now, transaction) {
      try {
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
        const record: VerifiedSessionRecord | null = await verifySession(credential, transaction);
        if (!record || !text(record.actorId) || !text(record.tenantId) || !["HUMAN", "SERVICE"].includes(record.kind) || !Array.isArray(record.assignments)) return null;
        const expires = validDate(record.expiresAt); if (expires === null || expires <= now.getTime()) return null;
        if (record.assignments.some(a => !validAssignmentShape(a) || a.actorId !== record.actorId)) return null;
        if (record.kind === "SERVICE" && (!Array.isArray(record.serviceCapabilities) || !record.serviceCapabilities.every(text))) return null;
        const principal = cloneFreeze({ ...record, assignments: record.assignments, issuedAt: now.toISOString() }) as Principal;
        issued.add(principal); return principal;
      } catch { return null; }
    },
    authorize(principal, request: AuthorizationRequest, now) {
      try {
        if (!principal || typeof principal !== "object" || !issued.has(principal as object)) return deny("UNAUTHENTICATED", "Principal was not issued by this service");
        const time = now instanceof Date ? now.getTime() : NaN;
        if (!Number.isFinite(time) || (validDate(principal.expiresAt) ?? -Infinity) <= time) return deny("UNAUTHENTICATED", "Session is invalid or expired");
        const rule = request && registry.get(request.transitionId); if (!rule) return deny("FORBIDDEN", "Unknown transition");
        if (!validScope(request.scope)) return deny("FORBIDDEN", "Malformed scope");
        if (request.mode !== undefined && request.mode !== "EXECUTE" && request.mode !== "REPLAY") return deny("FORBIDDEN", "Unknown authorization mode");
        const assignments = principal.assignments.filter(a => validAssignmentShape(a) && a.actorId === principal.actorId && current(a, principal.tenantId, time, request.scope));
        const human = principal.kind === "HUMAN";
        const allowedRole = human ? assignments.some(a => rule.roles.includes(a.role) && a.role !== "SYSTEM") : assignments.some(a => a.role === "SYSTEM") && (principal.serviceCapabilities ?? []).includes(`transition:${rule.id}`) && rule.roles.includes("SYSTEM");
        if (!allowedRole) return deny("FORBIDDEN", "No current assignment and registry role covers this scope");
        if (!human && (rule.operation !== "TRANSITION" || rule.dualControlPairs)) return deny("FORBIDDEN", "Human technical validation and dual control cannot be performed by a service");
        if (request.mode !== "REPLAY") {
          const context = request.context;
          if (rule.operation === "VALIDATE_EVIDENCE") {
            const e = context?.evidence;
            if (!e || !EVIDENCE_CLASSES.includes(e.class) || !text(e.uploaderId)) return deny("FORBIDDEN", "Known evidence class and uploader are required");
            if (e.class !== "METADATA") {
              if (e.uploaderId === principal.actorId) return deny("FORBIDDEN", "Uploader cannot validate own regulated evidence");
              const validatorRole: Role = e.class === "STAMPED_TECHNICAL_DOCUMENT" ? "THIRD_PARTY_INSPECTOR" : "STAKEHOLDER_MANAGER";
              const eligible = assignments.some(a => a.role === validatorRole && (validatorRole !== "THIRD_PARTY_INSPECTOR" || a.credentialVerified === true && e.authorizationState === "INSPECTION_ACTIVE" && e.authorizationVersionCurrent === true));
              if (!eligible) return deny("FORBIDDEN", "No current class-eligible validator assignment");
            }
          }
          if (rule.operation === "RECORD_STAMP") {
            const e = context?.evidence;
            if (!e || e.class !== "STAMPED_TECHNICAL_DOCUMENT" || !text(e.uploaderId) || !text(e.signerId) || !e.signerAssignment || !validAssignmentShape(e.signerAssignment) || e.signerAssignment.role !== "THIRD_PARTY_INSPECTOR" || e.signerAssignment.actorId !== e.signerId || e.signerAssignment.credentialVerified !== true || e.authorizationState !== "INSPECTION_ACTIVE" || e.authorizationVersionCurrent !== true || e.independentValidationVerified !== true || !current(e.signerAssignment, principal.tenantId, time, request.scope)) return deny("FORBIDDEN", "Current independently validated assigned inspector stamp is required");
            if (e.signerId === principal.actorId && !assignments.some(a => a.id === e.signerAssignment!.id && a.version === e.signerAssignment!.version && a.actorId === e.signerId && a.role === "THIRD_PARTY_INSPECTOR" && a.credentialVerified === true)) return deny("FORBIDDEN", "Recorder cannot impersonate the assigned signer");
          }
          if (rule.dualControlPairs) {
            const c = context;
            if (!c || !text(c.commandHash) || !text(c.scopeHash) || !Number.isSafeInteger(c.dependencyEpoch) || c.dependencyEpoch < 0 || !Array.isArray(c.approvals)) return deny("APPROVAL_INVALID", "Server-loaded approval context is required");
            const approvals = c.approvals.filter(f => {
              if (!f || f.actorKind !== "HUMAN" || f.verified !== true || !validAssignmentShape(f.assignment) || f.actorId !== f.assignment.actorId || f.approvedAssignmentVersion !== f.assignment.version || f.commandHash !== c.commandHash || f.scopeHash !== c.scopeHash || f.dependencyEpoch !== c.dependencyEpoch || (validDate(f.expiresAt) ?? -Infinity) <= time || f.assignment.role === "SYSTEM") return false;
              return current(f.assignment, principal.tenantId, time, request.scope);
            });
            const identities = new Set<string>();
            for (const pair of rule.dualControlPairs) {
              for (const first of approvals.filter(f => f.assignment.role === pair[0])) for (const second of approvals.filter(f => f.assignment.role === pair[1])) {
                const personKey1 = `${first.actorId}\u0000${first.assignment.id}`, personKey2 = `${second.actorId}\u0000${second.assignment.id}`;
                if (first.actorId !== second.actorId && first.assignment.id !== second.assignment.id && personKey1 !== personKey2) identities.add(`${personKey1}|${personKey2}`);
              }
            }
            if (identities.size === 0) return deny("APPROVAL_INVALID", "Distinct current human approvals for an allowed role pair are required");
          }
        }
        return { allowed: true };
      } catch { return deny("FORBIDDEN", "Malformed authorization input"); }
    }
  };
  return Object.freeze(port);
}
