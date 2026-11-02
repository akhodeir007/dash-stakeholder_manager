import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthorizationService } from "../../../src/auth/authorization";
import type {
  ApprovalFact,
  Role,
  RoleAssignment,
  ScopeBinding,
  TransitionRule,
  VerifiedSessionRecord,
} from "../../../src/contracts/foundation";
import {
  EVIDENCE_TRANSITION_RULES,
  createEvidenceService,
  type EvidenceClass,
  type EvidenceServicePort,
} from "../../../src/domain/evidence";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("evidence reliance tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const PACKAGE_ID = "PACKAGE_I";
const PLOTS = ["plot-201"];

const makeScope = (evidenceVersionIds: string[] = []): ScopeBinding => ({
  kind: "PACKAGE_GATE",
  projectId: PROJECT_ID,
  packageId: PACKAGE_ID,
  plotIds: PLOTS,
  scopeVersion: 1,
  designRevision: "rev-1",
  requirementSnapshotId: "req-1",
  evidenceVersionIds,
});

const makeAssignment = (
  actorId: string,
  role: Role,
  overrides: Partial<RoleAssignment> = {},
): RoleAssignment => ({
  id: `assign-${actorId}-${role}`,
  actorId,
  version: 1,
  role,
  tenantId: TENANT,
  scope: { kind: "PACKAGE", projectId: PROJECT_ID, packageId: PACKAGE_ID, plotIds: PLOTS },
  verified: true,
  active: true,
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: null,
  credentialVerified: true,
  ...overrides,
});

describe("BUILD-004 reliance lifecycle, regulated classes, structural stamps & dual control", () => {
  let pool: Pool;
  let schema: string;
  let currentTime: Date;
  let sessions: Map<string, VerifiedSessionRecord>;
  let service: EvidenceServicePort;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 6 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    schema = `ev_rel_${randomUUID().replace(/-/g, "")}`;
    currentTime = new Date("2026-11-02T12:00:00.000Z");
    sessions = new Map<string, VerifiedSessionRecord>([
      [
        "sys",
        {
          actorId: "system-worker",
          tenantId: TENANT,
          kind: "SERVICE",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("system-worker", "SYSTEM")],
          serviceCapabilities: EVIDENCE_TRANSITION_RULES.filter((r) => r.roles.includes("SYSTEM")).map(
            (r) => `transition:${r.id}`,
          ),
        },
      ],
      [
        "aor",
        {
          actorId: "aor-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("aor-1", "AOR_LEAD")],
        },
      ],
      [
        "sm-1",
        {
          actorId: "sm-user-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("sm-user-1", "STAKEHOLDER_MANAGER")],
        },
      ],
      [
        "sm-2",
        {
          actorId: "sm-user-2",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("sm-user-2", "STAKEHOLDER_MANAGER")],
        },
      ],
      [
        "inspector-x",
        {
          actorId: "qualiconsult-x",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("qualiconsult-x", "THIRD_PARTY_INSPECTOR")],
        },
      ],
      [
        "inspector-y",
        {
          actorId: "qualiconsult-y",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("qualiconsult-y", "THIRD_PARTY_INSPECTOR")],
        },
      ],
      [
        "exec-1",
        {
          actorId: "exec-user-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("exec-user-1", "CLIENT_EXECUTIVE")],
        },
      ],
      [
        "admin-1",
        {
          actorId: "admin-user-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("admin-user-1", "SYSTEM_ADMIN")],
        },
      ],
    ]);

    const authorization = createAuthorizationService({
      verifySession: async (cred) => (typeof cred === "string" ? (sessions.get(cred) ?? null) : null),
      rules: EVIDENCE_TRANSITION_RULES as readonly TransitionRule[],
    });

    service = createEvidenceService({
      database: { pool, schema },
      clock: () => currentTime,
      storage: {
        async putObject(input) {
          return { objectKey: input.objectKey, contentHash: "a".repeat(64), byteSize: input.content.byteLength };
        },
      },
      scan: {
        async scanObject() {
          return { status: "CLEAN", engine: "synthetic-av" };
        },
      },
      authorization,
    });
    await service.initialize();
  });

  it("separates authority recording from regulated validation (CS-012, IE-014, GAP-04)", async () => {
    const evidenceId = randomUUID();
    const scope = makeScope([`${evidenceId}:1`]);

    await service.uploadEvidenceVersion("aor", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("%PDF-1.7 reported-approval"),
      mediaType: "application/pdf",
      evidenceClass: "AUTHORITY_APPROVAL",
      documentType: "CLEARANCE_APPROVAL",
      authorityRef: "B2-SC-A-2026-001625",
      signerId: null,
      issuerId: "ADM",
      source: "tracker_import",
      provenance: "sheet1:row5",
      validFrom: "2026-06-04T00:00:00.000Z",
      validUntil: "2028-06-04T00:00:00.000Z",
    });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T01", scope });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T02", scope });

    // AOR records the reported authority approval fact
    const recorded = await service.recordAuthorityFact("aor", {
      assertionId: randomUUID(),
      projectId: PROJECT_ID,
      scope,
      entityCode: "ADM_SITE_CLEARANCE",
      reportedStatus: "APPROVED",
      authorityRef: "B2-SC-A-2026-001625",
      evidenceId,
      evidenceVersion: 1,
      conflictDetected: false,
      notes: "Recorded from tracker sheet 1",
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) throw new Error(recorded.reason);
    expect(recorded.assertion.reportedStatus).toBe("APPROVED");
    expect(recorded.assertion.quarantined).toBe(true);

    // Unvalidated recorded approval cannot establish VERIFIED reliance
    const relianceBeforeValidation = await service.evaluateReliance("aor", {
      evidenceId,
      version: 1,
      scope,
      reason: "Check before independent validation",
    });
    expect(relianceBeforeValidation.ok).toBe(true);
    if (!relianceBeforeValidation.ok) throw new Error(relianceBeforeValidation.reason);
    expect(relianceBeforeValidation.evaluation.status).toBe("PENDING");
    expect(relianceBeforeValidation.evaluation.quarantined).toBe(true);

    // AOR_LEAD, SYSTEM_ADMIN, and CLIENT_EXECUTIVE cannot validate AUTHORITY_APPROVAL
    for (const caller of ["aor", "admin-1", "exec-1"]) {
      const denied = await service.validateEvidence(caller, {
        evidenceId,
        version: 1,
        scope,
        verdict: "VALID",
        reason: "ineligible validator role",
      });
      expect(denied.ok).toBe(false);
    }

    // Independent STAKEHOLDER_MANAGER validates and activates
    const valid = await service.validateEvidence("sm-1", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "Independently verified ADM clearance approval",
    });
    expect(valid.ok).toBe(true);
    await service.transitionDocument("sm-1", { evidenceId, version: 1, transitionId: "S10-T05", scope });

    const relianceAfterValidation = await service.evaluateReliance("sm-1", {
      evidenceId,
      version: 1,
      scope,
      reason: "Post-validation reliance check",
    });
    expect(relianceAfterValidation.ok).toBe(true);
    if (!relianceAfterValidation.ok) throw new Error(relianceAfterValidation.reason);
    expect(relianceAfterValidation.evaluation.status).toBe("VERIFIED");
    expect(relianceAfterValidation.evaluation.quarantined).toBe(false);
  });

  it("denies structural self-validation when inspector X uploads and tries to validate, requiring different credentialed inspector Y (IE-017, GAP-08, GAP-09)", async () => {
    const evidenceId = randomUUID();
    const scope = makeScope([`${evidenceId}:1`]);

    // Inspector X uploads their own signed structural report
    const up = await service.uploadEvidenceVersion("inspector-x", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("%PDF-1.7 stamped-soil-report"),
      mediaType: "application/pdf",
      evidenceClass: "STAMPED_TECHNICAL_DOCUMENT",
      documentType: "SOIL_REPORT_STAMPED",
      authorityRef: "DMT/PAS/OUT/2026/8415",
      signerId: "qualiconsult-x",
      issuerId: "QUALICONSULT",
      source: "qualiconsult_upload",
      provenance: "soil-rev-1",
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
    });
    expect(up.ok).toBe(true);
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T01", scope });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T02", scope });

    // Inspector X attempting to validate own upload -> DENIED (IE-017)
    const selfVal = await service.validateEvidence("inspector-x", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "self-validation attempt",
      authorizationState: "INSPECTION_ACTIVE",
      authorizationVersionCurrent: true,
    });
    expect(selfVal).toMatchObject({ ok: false, code: "FORBIDDEN" });

    // Inspector Y attempting to validate when appointment is only DMT_LICENSING_APPROVED -> DENIED (GAP-02 / GAP-08)
    const licensingOnlyVal = await service.validateEvidence("inspector-y", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "only licensing approved",
      authorizationState: "DMT_LICENSING_APPROVED",
      authorizationVersionCurrent: true,
    });
    expect(licensingOnlyVal).toMatchObject({ ok: false, code: "FORBIDDEN" });

    // Inspector Y with INSPECTION_ACTIVE and current credentialed assignment validates -> ALLOWED
    const validByY = await service.validateEvidence("inspector-y", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "Independent structural inspector Y verified stamp",
      authorizationState: "INSPECTION_ACTIVE",
      authorizationVersionCurrent: true,
    });
    expect(validByY.ok).toBe(true);

    // Record technical stamp by AOR_LEAD preserving distinct uploader, signer, validator, and recorder identities (GAP-08)
    const stampRecorded = await service.recordTechnicalStamp("aor", {
      evidenceId,
      version: 1,
      scope,
      signerId: "qualiconsult-x",
      signerAssignment: makeAssignment("qualiconsult-x", "THIRD_PARTY_INSPECTOR"),
      authorizationState: "INSPECTION_ACTIVE",
      authorizationVersionCurrent: true,
    });
    expect(stampRecorded.ok).toBe(true);
    if (!stampRecorded.ok) throw new Error(stampRecorded.reason);
    expect(stampRecorded.stamp).toMatchObject({
      uploaderId: "qualiconsult-x",
      signerId: "qualiconsult-x",
      validatorId: "qualiconsult-y",
      recorderId: "aor-1",
    });

    // If authorizationVersionCurrent is false at commit time, stamp recording is denied
    const staleStamp = await service.recordTechnicalStamp("aor", {
      evidenceId,
      version: 1,
      scope,
      signerId: "qualiconsult-x",
      signerAssignment: makeAssignment("qualiconsult-x", "THIRD_PARTY_INSPECTOR"),
      authorizationState: "INSPECTION_ACTIVE",
      authorizationVersionCurrent: false,
    });
    expect(staleStamp.ok).toBe(false);
  });

  it("enforces dual-control distinct human identities and hash/scope/epoch bindings on exemption/waiver evidence validation", async () => {
    const evidenceId = randomUUID();
    const scope = makeScope([`${evidenceId}:1`]);

    await service.uploadEvidenceVersion("aor", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("%PDF-1.7 exemption-confirmation"),
      mediaType: "application/pdf",
      evidenceClass: "EXEMPTION" as EvidenceClass,
      documentType: "GOVERNMENT_EXEMPTION_EVIDENCE",
      authorityRef: "ADM-EXEMPT-2026-01",
      signerId: null,
      issuerId: "ADM",
      source: "tracker",
      provenance: "exemption-1",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: "2027-06-01T00:00:00.000Z",
    });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T01", scope });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T02", scope });

    const { commandHash, scopeHash, dependencyEpoch } = await service.computeDualControlBinding({
      evidenceId,
      version: 1,
      scope,
      transitionId: "S2BC-T14",
    });

    // Same human holding both roles (sm-user-1 pretending to be both STAKEHOLDER_MANAGER and CLIENT_EXECUTIVE) -> DENIED
    const samePersonApprovals: ApprovalFact[] = [
      {
        actorId: "sm-user-1",
        actorKind: "HUMAN",
        assignment: makeAssignment("sm-user-1", "STAKEHOLDER_MANAGER", { id: "a-1" }),
        approvedAssignmentVersion: 1,
        commandHash,
        scopeHash,
        dependencyEpoch,
        verified: true,
        expiresAt: "2026-11-10T00:00:00.000Z",
      },
      {
        actorId: "sm-user-1",
        actorKind: "HUMAN",
        assignment: makeAssignment("sm-user-1", "CLIENT_EXECUTIVE", { id: "a-2" }),
        approvedAssignmentVersion: 1,
        commandHash,
        scopeHash,
        dependencyEpoch,
        verified: true,
        expiresAt: "2026-11-10T00:00:00.000Z",
      },
    ];
    const deniedSamePerson = await service.validateEvidence("sm-1", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "dual control same person",
      dualControlTransitionId: "S2BC-T14",
      approvals: samePersonApprovals,
    });
    expect(deniedSamePerson).toMatchObject({ ok: false, code: "APPROVAL_INVALID" });

    // Distinct eligible human identities (sm-user-1 + exec-user-1) with matching hash/scope/epoch -> ALLOWED
    const distinctApprovals: ApprovalFact[] = [
      samePersonApprovals[0],
      {
        actorId: "exec-user-1",
        actorKind: "HUMAN",
        assignment: makeAssignment("exec-user-1", "CLIENT_EXECUTIVE", { id: "a-exec-1" }),
        approvedAssignmentVersion: 1,
        commandHash,
        scopeHash,
        dependencyEpoch,
        verified: true,
        expiresAt: "2026-11-10T00:00:00.000Z",
      },
    ];
    const allowedDual = await service.validateEvidence("sm-1", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "dual control verified by SM and Executive",
      dualControlTransitionId: "S2BC-T14",
      approvals: distinctApprovals,
    });
    expect(allowedDual.ok).toBe(true);
  });
});
