import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import type { AuthorizationContext, Principal, Role, RoleAssignment, ScopeBinding, TransitionRule, VerifiedSessionRecord } from "../../../src/contracts/foundation";
import { createAuthorizationService } from "../../../src/auth/authorization";

const now = new Date("2026-11-02T12:00:00.000Z");
const roles: Role[] = ["SYSTEM_ADMIN", "STAKEHOLDER_MANAGER", "AOR_LEAD", "THIRD_PARTY_INSPECTOR", "CLIENT_EXECUTIVE", "DISCIPLINE_LEAD", "CONTRACTOR"];
const scope: ScopeBinding = { kind: "PACKAGE_GATE", projectId: "p", packageId: "pkg", plotIds: ["plot"], scopeVersion: 1, designRevision: "d1", requirementSnapshotId: "r1", evidenceVersionIds: ["e1"] };
const assignment = (role: Role, patch: Partial<RoleAssignment> = {}): RoleAssignment => ({ id: `a-${role}`, actorId: "u", version: 1, role, tenantId: "t", scope: { kind: "PACKAGE", projectId: "p", packageId: "pkg", plotIds: ["plot"] }, verified: true, active: true, validFrom: "2026-01-01T00:00:00Z", validUntil: null, credentialVerified: true, ...patch });
const session = (actorId: string, assignments: RoleAssignment[], extra: Partial<VerifiedSessionRecord> = {}): VerifiedSessionRecord => ({ actorId, tenantId: "t", kind: "HUMAN", expiresAt: "2027-01-01T00:00:00Z", assignments: assignments.map(a => ({ ...a, actorId })), ...extra });
const rule: TransitionRule = { id: "T1", machineId: "m", event: "go", from: ["A"], to: "B", roles, guards: [], effects: [], operation: "TRANSITION" };
const svc = (record: VerifiedSessionRecord | null) => createAuthorizationService({ verifySession: async () => record, rules: [rule] });
const resolvePrincipal = async (s: ReturnType<typeof svc>, credential: unknown = "synthetic") => s.resolve(credential, now);
// Deliberately accepts unknown at the negative-test boundary; runtime service must reject forgeries.
const authorize = (s: ReturnType<typeof svc>, principal: unknown, transitionId = "T1", requestScope: ScopeBinding = scope, context?: unknown, mode?: "EXECUTE" | "REPLAY") => s.authorize(principal as Principal, { transitionId, scope: requestScope, context: context as AuthorizationContext | undefined, mode }, now);

describe("server authorization", () => {
  it("has no default verifier and fails closed on verifier errors / invalid sessions", async () => {
    expect(() => createAuthorizationService({ rules: [rule] } as unknown as Parameters<typeof createAuthorizationService>[0])).toThrow();
    for (const record of [null, session("", []), session("x", [], { expiresAt: "bad" }), session("x", [], { expiresAt: "2026-11-02T11:00:00Z" })]) {
      const s = createAuthorizationService({ verifySession: async () => record, rules: [rule] }); expect(await s.resolve("x", now)).toBeNull();
    }
    const broken = createAuthorizationService({ verifySession: async () => { throw Error(); }, rules: [rule] }); expect(await broken.resolve("x", now)).toBeNull();
  });
  it("issues private immutable identity and rejects raw, cloned and cross-service principals", async () => {
    const a = svc(session("alice", [assignment("AOR_LEAD")])); const p = await resolvePrincipal(a); expect(p).not.toBeNull();
    expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p!.assignments[0])).toBe(true);
    expect(authorize(a, p).allowed).toBe(true); expect(authorize(a, { ...p }).allowed).toBe(false); expect(authorize(a, JSON.parse(JSON.stringify(p))).allowed).toBe(false);
    expect(authorize(svc(session("alice", [assignment("AOR_LEAD")])), p).allowed).toBe(false);
  });
  it("intersects local roles with active verified current assignments and exact scope", async () => {
    for (const role of roles) { const s = svc(session("u", [assignment(role)])); expect(authorize(s, await resolvePrincipal(s)).allowed).toBe(true); }
    for (const bad of [assignment("AOR_LEAD", { active: false }), assignment("AOR_LEAD", { verified: false }), assignment("AOR_LEAD", { tenantId: "other" }), assignment("AOR_LEAD", { validUntil: "2026-11-02T11:00:00Z" }), assignment("AOR_LEAD", { scope: { kind: "PACKAGE", projectId: "p", packageId: "pkg", plotIds: ["other"] } })]) {
      const s = svc(session("u", [bad])); expect(authorize(s, await resolvePrincipal(s)).allowed).toBe(false);
    }
    const unknown = svc(session("u", [assignment("AOR_LEAD")])); expect(authorize(unknown, await resolvePrincipal(unknown), "missing").allowed).toBe(false);
  });
  it("enforces project wildcard and disallows provisional assignments for package actions", async () => {
    for (const allPackages of [false, true]) { const s = svc(session("u", [assignment("AOR_LEAD", { scope: { kind: "PROJECT", projectId: "p", allPackages } })])); expect(authorize(s, await resolvePrincipal(s)).allowed).toBe(allPackages); }
    const s = svc(session("u", [assignment("AOR_LEAD", { scope: { kind: "PROVISIONAL", provisionalCaseId: "c", plotIds: ["plot"] } })])); expect(authorize(s, await resolvePrincipal(s)).allowed).toBe(false);
  });
  it("limits SYSTEM to exact verified service capability and denies human spoofing", async () => {
    const human = svc(session("h", [assignment("SYSTEM")])); expect(authorize(human, await resolvePrincipal(human)).allowed).toBe(false);
    const service = createAuthorizationService({ verifySession: async () => session("svc", [assignment("SYSTEM")], { kind: "SERVICE", serviceCapabilities: ["transition:T1"] }), rules: [{ ...rule, roles: ["SYSTEM"] }] }); expect(authorize(service, await resolvePrincipal(service)).allowed).toBe(true);
    const wrong = createAuthorizationService({ verifySession: async () => session("svc", [assignment("SYSTEM")], { kind: "SERVICE", serviceCapabilities: ["transition:T2"] }), rules: [{ ...rule, roles: ["SYSTEM"] }] }); expect(authorize(wrong, await resolvePrincipal(wrong)).allowed).toBe(false);
  });
  it("requires independent class-authorized validators and separates stamp recorder from signer", async () => {
    const regulated = ["AUTHORITY_APPROVAL", "NOC", "LEGAL_AUTHORIZATION", "EXEMPTION", "WAIVER"] as const;
    for (const cls of regulated) {
      const r = { ...rule, operation: "VALIDATE_EVIDENCE" as const, roles: ["STAKEHOLDER_MANAGER"] as Role[] }; const s = createAuthorizationService({ verifySession: async () => session("validator", [assignment("STAKEHOLDER_MANAGER")]), rules: [r] }); const p = await resolvePrincipal(s);
      expect(authorize(s, p, "T1", scope, { commandHash: "h", scopeHash: "s", dependencyEpoch: 1, evidence: { class: cls, uploaderId: "uploader" } }).allowed).toBe(true);
      expect(authorize(s, p, "T1", scope, { commandHash: "h", scopeHash: "s", dependencyEpoch: 1, evidence: { class: cls, uploaderId: "validator" } }).allowed).toBe(false);
    }
    const r = { ...rule, operation: "RECORD_STAMP" as const, roles: ["AOR_LEAD"] as Role[] }; const s = createAuthorizationService({ verifySession: async () => session("recorder", [assignment("AOR_LEAD")]), rules: [r] }); const p = await resolvePrincipal(s);
    const evidence = { class: "STAMPED_TECHNICAL_DOCUMENT" as const, uploaderId: "signer", signerId: "signer", signerAssignment: assignment("THIRD_PARTY_INSPECTOR", { actorId: "signer" }), authorizationState: "INSPECTION_ACTIVE", authorizationVersionCurrent: true, independentValidationVerified: true };
    expect(authorize(s, p, "T1", scope, { commandHash: "h", scopeHash: "s", dependencyEpoch: 1, evidence }).allowed).toBe(true);
    expect(authorize(s, p, "T1", scope, { commandHash: "h", scopeHash: "s", dependencyEpoch: 1, evidence: { ...evidence, signerId: "recorder" } }).allowed).toBe(false);
  });
  it("uses exact dual-control pairs, distinct identities and hash/scope/epoch/expiry binding", async () => {
    const yaml = YAML.parse(readFileSync(resolve(process.cwd(), "docs/state-machines.yaml"), "utf8")) as { behavioral_contract: { evidence_validation: { dual_control_role_pairs: Record<string, [Role, Role][]> } } }; const pairs = yaml.behavioral_contract.evidence_validation.dual_control_role_pairs;
    for (const [id, rawPairs] of Object.entries(pairs)) for (const pair of rawPairs) {
      const r = { ...rule, id, dualControlPairs: [pair] }; const s = createAuthorizationService({ verifySession: async () => session("one", [assignment(pair[0])]), rules: [r] }); const p = await resolvePrincipal(s);
      const fact = (actorId: string, role: Role, overrides: Record<string, unknown> = {}) => ({ actorId, actorKind: "HUMAN", assignment: assignment(role, { id: `${actorId}-${role}`, actorId }), approvedAssignmentVersion: 1, commandHash: "h", scopeHash: "s", dependencyEpoch: 1, verified: true, expiresAt: "2026-11-03T00:00:00Z", ...overrides });
      const context = (approvals: unknown[]) => ({ commandHash: "h", scopeHash: "s", dependencyEpoch: 1, approvals });
      expect(authorize(s, p, id, scope, context([fact("one", pair[0]), fact("two", pair[1])])).allowed).toBe(true);
      expect(authorize(s, p, id, scope, context([fact("one", pair[0]), fact("one", pair[1])])).allowed).toBe(false);
      expect(authorize(s, p, id, scope, context([fact("one", pair[0]), fact("two", pair[1], { commandHash: "changed" })])).allowed).toBe(false);
      expect(authorize(s, p, id, scope, context([fact("one", pair[0]), fact("two", pair[1], { dependencyEpoch: 2 })])).allowed).toBe(false);
    }
  });
  it("replay checks current assignments but does not grant execute validation", async () => {
    const r = { ...rule, roles: ["AOR_LEAD"] as Role[] }; let active = true; const s = createAuthorizationService({ verifySession: async () => session("a", [assignment("AOR_LEAD", { active })]), rules: [r] }); const p = await resolvePrincipal(s);
    expect(authorize(s, p, "T1", scope, undefined, "REPLAY").allowed).toBe(true); active = false;
    const revoked = await resolvePrincipal(s); expect(authorize(s, revoked, "T1", scope, undefined, "REPLAY").allowed).toBe(false);
  });

  it("fails closed on unknown/malformed evidence classes and malformed scopes without throwing", async () => {
    const r = { ...rule, operation: "VALIDATE_EVIDENCE" as const, roles: ["STAKEHOLDER_MANAGER"] as Role[] }; const s = createAuthorizationService({ verifySession: async () => session("u", [assignment("STAKEHOLDER_MANAGER")]), rules: [r] }); const p = await resolvePrincipal(s);
    for (const evidence of [{ uploaderId: "other" }, { class: "BOGUS", uploaderId: "other" }, { class: "NOC" }, { class: "NOC", uploaderId: 42 }]) expect(authorize(s, p, "T1", scope, { evidence }).allowed).toBe(false);
    const malformed = [ { ...scope, plotIds: [] }, { ...scope, plotIds: ["plot", "plot"] }, { ...scope, plotIds: [""] }, { ...scope, scopeVersion: -1 }, { ...scope, projectId: "" }, { ...scope, packageId: "" }, { ...scope, plotIds: undefined } ];
    for (const sc of malformed) expect(() => authorize(s, p, "T1", sc as unknown as ScopeBinding)).not.toThrow();
    for (const sc of malformed) expect(authorize(s, p, "T1", sc as unknown as ScopeBinding).allowed).toBe(false);
  });

  it("intersects every evidence operation with dual control", async () => {
    const r = { ...rule, operation: "VALIDATE_EVIDENCE" as const, roles: ["STAKEHOLDER_MANAGER"] as Role[], dualControlPairs: [["STAKEHOLDER_MANAGER", "CLIENT_EXECUTIVE"]] as [Role, Role][] };
    const s = createAuthorizationService({ verifySession: async () => session("validator", [assignment("STAKEHOLDER_MANAGER")]), rules: [r] }); const p = await resolvePrincipal(s);
    const context = { commandHash: "h", scopeHash: "s", dependencyEpoch: 1, evidence: { class: "METADATA", uploaderId: "validator" } };
    expect(authorize(s, p, "T1", scope, context).allowed).toBe(false);
    const approval = { actorId: "validator", actorKind: "HUMAN", assignment: assignment("STAKEHOLDER_MANAGER", { actorId: "validator" }), approvedAssignmentVersion: 1, commandHash: "h", scopeHash: "s", dependencyEpoch: 1, verified: true, expiresAt: "2026-11-03T00:00:00Z" };
    const executive = { ...approval, actorId: "exec", assignment: assignment("CLIENT_EXECUTIVE", { actorId: "exec" }) };
    expect(authorize(s, p, "T1", scope, { ...context, approvals: [approval, executive] }).allowed).toBe(true);
  });

  it("requires structural validation current inspection authorization and credentialed scope", async () => {
    const r = { ...rule, operation: "VALIDATE_EVIDENCE" as const, roles: ["THIRD_PARTY_INSPECTOR"] as Role[] }; const s = createAuthorizationService({ verifySession: async () => session("inspector", [assignment("THIRD_PARTY_INSPECTOR")]), rules: [r] }); const p = await resolvePrincipal(s);
    const evidence = { class: "STAMPED_TECHNICAL_DOCUMENT", uploaderId: "uploader", authorizationState: "INSPECTION_ACTIVE", authorizationVersionCurrent: true };
    expect(authorize(s, p, "T1", scope, { evidence }).allowed).toBe(true);
    for (const bad of [{ ...evidence, authorizationState: "SUSPENDED" }, { ...evidence, authorizationVersionCurrent: false }, { ...evidence, authorizationState: undefined }, { ...evidence, authorizationVersionCurrent: undefined }]) expect(authorize(s, p, "T1", scope, { evidence: bad }).allowed).toBe(false);
    const noCredential = createAuthorizationService({ verifySession: async () => session("inspector", [assignment("THIRD_PARTY_INSPECTOR", { credentialVerified: false })]), rules: [r] }); expect(authorize(noCredential, await resolvePrincipal(noCredential), "T1", scope, { evidence }).allowed).toBe(false);
  });

  it("binds assignments to principal/approval/signer identities and allows assigned inspector to record own act", async () => {
    const mismatchRecord = { ...session("u", [assignment("AOR_LEAD")]), assignments: [assignment("AOR_LEAD", { actorId: "somebody-else" })] }; const mismatch = svc(mismatchRecord); expect(await resolvePrincipal(mismatch)).toBeNull();
    const recorderRule = { ...rule, operation: "RECORD_STAMP" as const, roles: ["THIRD_PARTY_INSPECTOR"] as Role[] }; const inspectorSvc = createAuthorizationService({ verifySession: async () => session("inspector", [assignment("THIRD_PARTY_INSPECTOR", { actorId: "inspector" })]), rules: [recorderRule] }); const principal = await resolvePrincipal(inspectorSvc);
    const own = { class: "STAMPED_TECHNICAL_DOCUMENT", uploaderId: "inspector", signerId: "inspector", signerAssignment: assignment("THIRD_PARTY_INSPECTOR", { actorId: "inspector" }), authorizationState: "INSPECTION_ACTIVE", authorizationVersionCurrent: true, independentValidationVerified: true };
    expect(authorize(inspectorSvc, principal, "T1", scope, { commandHash: "h", scopeHash: "s", dependencyEpoch: 1, evidence: own }).allowed).toBe(true);
    expect(authorize(inspectorSvc, principal, "T1", scope, { commandHash: "h", scopeHash: "s", dependencyEpoch: 1, evidence: { ...own, signerAssignment: assignment("THIRD_PARTY_INSPECTOR", { actorId: "other" }) } }).allowed).toBe(false);
  });

  it("validates registry rules and cyclic input fail-closed", async () => {
    expect(() => createAuthorizationService({ verifySession: async () => null, rules: [{ ...rule, roles: [] }] })).toThrow();
    expect(() => createAuthorizationService({ verifySession: async () => null, rules: [{ ...rule, operation: "BOGUS" } as unknown as TransitionRule] })).toThrow();
    const cyclic: Record<string, unknown> = { ...session("u", []) }; cyclic.extra = cyclic;
    const s = createAuthorizationService({ verifySession: async () => cyclic as unknown as VerifiedSessionRecord, rules: [rule] }); expect(await s.resolve("x", now)).toBeNull();
  });

  it("exercises every source registry transition against all seven roles in local role/scope REPLAY matrix", async () => {
    const source = YAML.parse(readFileSync(resolve(process.cwd(), "docs/state-machines.yaml"), "utf8")) as { machines: Record<string, { transitions: { id: string; roles: Role[] }[] }> };
    const transitions = Object.values(source.machines).flatMap((machine) => machine.transitions);
    let assertions = 0;
    for (const transition of transitions) {
      const rolesForTransition = transition.roles as Role[]; const r = { ...rule, id: transition.id, roles: rolesForTransition, operation: "TRANSITION" as const };
      for (const candidate of roles) {
        const record = session("matrix-user", [assignment(candidate)]); const s = createAuthorizationService({ verifySession: async () => record, rules: [r] }); const p = await resolvePrincipal(s);
        expect(authorize(s, p, transition.id, scope, undefined, "REPLAY").allowed).toBe(rolesForTransition.includes(candidate)); assertions++;
      }
    }
    expect(assertions).toBe(transitions.length * roles.length);
  });

  it("rejects approval facts with stale assignment version, mismatched actor, or service identity", async () => {
    const r = { ...rule, dualControlPairs: [["AOR_LEAD", "CLIENT_EXECUTIVE"]] as [Role, Role][] }; const s = createAuthorizationService({ verifySession: async () => session("requester", [assignment("AOR_LEAD")]), rules: [r] }); const p = await resolvePrincipal(s);
    const fact = (actorId: string, role: Role, extra: Record<string, unknown> = {}) => ({ actorId, actorKind: "HUMAN", assignment: assignment(role, { id: `${actorId}-${role}`, actorId }), approvedAssignmentVersion: 1, commandHash: "h", scopeHash: "s", dependencyEpoch: 1, verified: true, expiresAt: "2026-11-03T00:00:00Z", ...extra });
    const ctx = (a: unknown, b: unknown) => ({ commandHash: "h", scopeHash: "s", dependencyEpoch: 1, approvals: [a, b] });
    expect(authorize(s, p, "T1", scope, ctx(fact("a", "AOR_LEAD", { approvedAssignmentVersion: 2 }), fact("b", "CLIENT_EXECUTIVE"))).allowed).toBe(false);
    expect(authorize(s, p, "T1", scope, ctx(fact("a", "AOR_LEAD", { actorId: "b" }), fact("b", "CLIENT_EXECUTIVE"))).allowed).toBe(false);
    expect(authorize(s, p, "T1", scope, ctx(fact("a", "AOR_LEAD", { actorKind: "SERVICE" }), fact("b", "CLIENT_EXECUTIVE"))).allowed).toBe(false);
  });

  it("requires approvals to bind the same scope hash, expiry and distinct assignment identities", async () => {
    const r = { ...rule, dualControlPairs: [["AOR_LEAD", "CLIENT_EXECUTIVE"]] as [Role, Role][] }; const s = createAuthorizationService({ verifySession: async () => session("requester", [assignment("AOR_LEAD")]), rules: [r] }); const p = await resolvePrincipal(s);
    const fact = (actorId: string, role: Role, extra: Record<string, unknown> = {}) => ({ actorId, actorKind: "HUMAN", assignment: assignment(role, { id: `${actorId}-${role}`, actorId }), approvedAssignmentVersion: 1, commandHash: "h", scopeHash: "s", dependencyEpoch: 1, verified: true, expiresAt: "2026-11-03T00:00:00Z", ...extra });
    const context = (a: unknown, b: unknown) => ({ commandHash: "h", scopeHash: "s", dependencyEpoch: 1, approvals: [a, b] });
    expect(authorize(s, p, "T1", scope, context(fact("a", "AOR_LEAD"), fact("b", "CLIENT_EXECUTIVE", { scopeHash: "other" }))).allowed).toBe(false);
    expect(authorize(s, p, "T1", scope, context(fact("a", "AOR_LEAD"), fact("b", "CLIENT_EXECUTIVE", { expiresAt: "2026-11-02T11:00:00Z" }))).allowed).toBe(false);
    expect(authorize(s, p, "T1", scope, context(fact("a", "AOR_LEAD"), fact("b", "CLIENT_EXECUTIVE", { assignment: assignment("CLIENT_EXECUTIVE", { actorId: "b", id: "a-AOR_LEAD" }) }))).allowed).toBe(false);
  });

  it("denies malformed approval containers and malformed approval records without exceptions", async () => {
    const r = { ...rule, dualControlPairs: [["AOR_LEAD", "CLIENT_EXECUTIVE"]] as [Role, Role][] }; const s = createAuthorizationService({ verifySession: async () => session("requester", [assignment("AOR_LEAD")]), rules: [r] }); const p = await resolvePrincipal(s);
    for (const context of [{ commandHash: "h", scopeHash: "s", dependencyEpoch: 1, approvals: [null] }, { commandHash: "h", scopeHash: "s", dependencyEpoch: -1, approvals: [] }, { commandHash: "h", scopeHash: "s", dependencyEpoch: 1, approvals: {} }]) {
      expect(() => authorize(s, p, "T1", scope, context)).not.toThrow(); expect(authorize(s, p, "T1", scope, context).allowed).toBe(false);
    }
  });

  it("checks tenant, package and all target plots for approval and signer assignments", async () => {
    const r = { ...rule, roles: ["AOR_LEAD"] as Role[], operation: "RECORD_STAMP" as const }; const s = createAuthorizationService({ verifySession: async () => session("recorder", [assignment("AOR_LEAD")]), rules: [r] }); const p = await resolvePrincipal(s);
    const signer = assignment("THIRD_PARTY_INSPECTOR", { actorId: "signer", scope: { kind: "PACKAGE", projectId: "p", packageId: "pkg", plotIds: ["plot"] } });
    const evidence = { class: "STAMPED_TECHNICAL_DOCUMENT", uploaderId: "uploader", signerId: "signer", signerAssignment: signer, authorizationState: "INSPECTION_ACTIVE", authorizationVersionCurrent: true, independentValidationVerified: true };
    expect(authorize(s, p, "T1", scope, { evidence }).allowed).toBe(true);
    expect(authorize(s, p, "T1", { ...scope, plotIds: ["plot", "plot-2"] }, { evidence }).allowed).toBe(false);
    expect(authorize(s, p, "T1", scope, { evidence: { ...evidence, signerAssignment: { ...signer, tenantId: "other" } } }).allowed).toBe(false);
    expect(authorize(s, p, "T1", scope, { evidence: { ...evidence, signerAssignment: { ...signer, scope: { kind: "PACKAGE", projectId: "p", packageId: "other", plotIds: ["plot"] } } } }).allowed).toBe(false);
  });

  it("denies unexpected role and assignment shapes while allowing an unrelated revoked assignment", async () => {
    const malformed = assignment("AOR_LEAD", { role: "OWNER" as Role }); const s = svc(session("u", [malformed, assignment("AOR_LEAD", { id: "revoked", active: false })])); expect(await resolvePrincipal(s)).toBeNull();
    const mixed = svc(session("u", [assignment("AOR_LEAD", { id: "revoked", active: false }), assignment("AOR_LEAD", { id: "good" })])); expect(authorize(mixed, await resolvePrincipal(mixed)).allowed).toBe(true);
  });

  it("requires exact current assignment for the inspector recording own signed act", async () => {
    const r = { ...rule, operation: "RECORD_STAMP" as const, roles: ["THIRD_PARTY_INSPECTOR"] as Role[] }; const s = createAuthorizationService({ verifySession: async () => session("inspector", [assignment("THIRD_PARTY_INSPECTOR")]), rules: [r] }); const p = await resolvePrincipal(s);
    const good = assignment("THIRD_PARTY_INSPECTOR", { actorId: "inspector" }); const evidence = { class: "STAMPED_TECHNICAL_DOCUMENT", uploaderId: "inspector", signerId: "inspector", signerAssignment: good, authorizationState: "INSPECTION_ACTIVE", authorizationVersionCurrent: true, independentValidationVerified: true };
    expect(authorize(s, p, "T1", scope, { evidence }).allowed).toBe(true);
    expect(authorize(s, p, "T1", scope, { evidence: { ...evidence, signerAssignment: { ...good, version: 2 } } }).allowed).toBe(false);
    expect(authorize(s, p, "T1", scope, { evidence: { ...evidence, signerAssignment: { ...good, actorId: "someone-else" } } }).allowed).toBe(false);
  });

  it("crosses every evidence class with all seven local roles and global validator policy", async () => {
    const classes = ["AUTHORITY_APPROVAL", "NOC", "LEGAL_AUTHORIZATION", "EXEMPTION", "WAIVER", "STAMPED_TECHNICAL_DOCUMENT"] as const;
    for (const cls of classes) for (const role of roles) {
      const localRule = { ...rule, operation: "VALIDATE_EVIDENCE" as const, roles: [role] };
      const s = createAuthorizationService({ verifySession: async () => session("actor", [assignment(role)]), rules: [localRule] }); const p = await resolvePrincipal(s);
      const validClassRole = cls === "STAMPED_TECHNICAL_DOCUMENT" ? role === "THIRD_PARTY_INSPECTOR" : role === "STAKEHOLDER_MANAGER";
      const evidence = { class: cls, uploaderId: "uploader", authorizationState: "INSPECTION_ACTIVE", authorizationVersionCurrent: true };
      expect(authorize(s, p, "T1", scope, { evidence }).allowed).toBe(validClassRole);
    }
  });
  it("allows a complete package binding with an explicitly empty evidence list for ordinary policy access", async () => {
    const s = svc(session("u", [assignment("AOR_LEAD")]));
    expect(authorize(s, await resolvePrincipal(s), "T1", { ...scope, evidenceVersionIds: [] }).allowed).toBe(true);
  });
  it("never lets a service principal perform human regulated validation", async () => {
    const r: TransitionRule = { ...rule, roles: ["SYSTEM"], operation: "VALIDATE_EVIDENCE" };
    const s = createAuthorizationService({ verifySession: async () => session("svc", [assignment("SYSTEM"), assignment("STAKEHOLDER_MANAGER")], { kind: "SERVICE", serviceCapabilities: ["transition:T1"] }), rules: [r] });
    expect(authorize(s, await resolvePrincipal(s), "T1", scope, { evidence: { class: "NOC", uploaderId: "other" } }).allowed).toBe(false);
  });
});
