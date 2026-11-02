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
  type EvidenceServicePort,
} from "../../../src/domain/evidence";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("correction tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

const scope: ScopeBinding = {
  kind: "PACKAGE_GATE",
  projectId: PROJECT_ID,
  packageId: "PACKAGE_I",
  plotIds: ["plot-401"],
  scopeVersion: 1,
  designRevision: "rev-1",
  requirementSnapshotId: "req-1",
  evidenceVersionIds: [],
};

const makeAssignment = (actorId: string, role: Role): RoleAssignment => ({
  id: `assign-${actorId}-${role}`,
  actorId,
  version: 1,
  role,
  tenantId: TENANT,
  scope: { kind: "PROJECT", projectId: PROJECT_ID, allPackages: true },
  verified: true,
  active: true,
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: null,
  credentialVerified: true,
});

describe("BUILD-004 admin corrections append-only & regulated correction independent approval (CS-017, I10, GAP-06)", () => {
  let pool: Pool;
  let schema: string;
  let currentTime: Date;
  let service: EvidenceServicePort;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 6 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    schema = `ev_corr_${randomUUID().replace(/-/g, "")}`;
    currentTime = new Date("2026-11-02T12:00:00.000Z");

    const sessions = new Map<string, VerifiedSessionRecord>([
      [
        "admin",
        {
          actorId: "sysadmin-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("sysadmin-1", "SYSTEM_ADMIN")],
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
        "sm",
        {
          actorId: "sm-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("sm-1", "STAKEHOLDER_MANAGER")],
        },
      ],
      [
        "exec",
        {
          actorId: "exec-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("exec-1", "CLIENT_EXECUTIVE")],
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
          return { objectKey: input.objectKey, contentHash: "c".repeat(64), byteSize: input.content.byteLength };
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

  it("denies direct state writes and appends superseding assertions while preserving originals (CS-017, I10, GAP-06)", async () => {
    const evidenceId = randomUUID();
    const versionRef = `${evidenceId}:1`;
    const boundScope: ScopeBinding = { ...scope, evidenceVersionIds: [versionRef] };

    await service.uploadEvidenceVersion("aor", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope: boundScope,
      content: Buffer.from("%PDF-1.7 original-assertion-doc"),
      mediaType: "application/pdf",
      evidenceClass: "AUTHORITY_APPROVAL",
      documentType: "CLEARANCE_LETTER",
      authorityRef: "B2-SC-A-2026-001525",
      signerId: null,
      issuerId: "ADM",
      source: "tracker",
      provenance: "row-1",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: "2027-06-01T00:00:00.000Z",
    });

    const sourceAssertionId = randomUUID();
    const orig = await service.recordAuthorityFact("aor", {
      assertionId: sourceAssertionId,
      projectId: PROJECT_ID,
      scope: boundScope,
      entityCode: "ADM_SITE_CLEARANCE",
      reportedStatus: "SUBMITTED",
      authorityRef: "B2-SC-A-2026-001525",
      evidenceId,
      evidenceVersion: 1,
      conflictDetected: false,
      notes: "Original legacy reference assertion",
    });
    expect(orig.ok).toBe(true);

    // Direct state edit is forbidden even for SYSTEM_ADMIN
    const directEdit = await service.attemptDirectStateEdit("admin", {
      targetId: sourceAssertionId,
      desiredState: "APPROVED",
    });
    expect(directEdit).toMatchObject({ ok: false, code: "DIRECT_STATE_EDIT_FORBIDDEN" });

    // Non-admin cannot issue admin correction
    const nonAdminCorr = await service.appendAdminCorrection("aor", {
      correctionId: randomUUID(),
      projectId: PROJECT_ID,
      scope: boundScope,
      sourceAssertionId,
      reason: "AOR trying admin correction",
      replacementAssertion: {
        entityCode: "ADM_SITE_CLEARANCE",
        reportedStatus: "APPROVED",
        authorityRef: "B2-SC-A-2026-001625",
      },
      evidenceLinks: [versionRef],
      regulated: true,
    });
    expect(nonAdminCorr).toMatchObject({ ok: false, code: "FORBIDDEN" });

    // CS-017: Admin corrects a regulated assertion without independent approval -> original retained, correction quarantined and cannot clear a gate
    const unapprovedRegulatedCorr = await service.appendAdminCorrection("admin", {
      correctionId: randomUUID(),
      projectId: PROJECT_ID,
      scope: boundScope,
      sourceAssertionId,
      reason: "Update clearance reference to active B2-SC-A-2026-001625",
      replacementAssertion: {
        entityCode: "ADM_SITE_CLEARANCE",
        reportedStatus: "APPROVED",
        authorityRef: "B2-SC-A-2026-001625",
      },
      evidenceLinks: [versionRef],
      regulated: true,
    });
    expect(unapprovedRegulatedCorr.ok).toBe(true);
    if (!unapprovedRegulatedCorr.ok) throw new Error(unapprovedRegulatedCorr.reason);
    expect(unapprovedRegulatedCorr.correction.quarantined).toBe(true);
    expect(unapprovedRegulatedCorr.correction.independentApprovalVerified).toBe(false);

    // Original assertion is still preserved in assertion_records
    const history = await service.getAssertionHistory(PROJECT_ID, "ADM_SITE_CLEARANCE");
    expect(history).toHaveLength(2);
    expect(history[0].assertionId).toBe(sourceAssertionId);
    expect(history[0].authorityRef).toBe("B2-SC-A-2026-001525");
    expect(history[1].supersedesAssertionId).toBe(sourceAssertionId);
    expect(history[1].quarantined).toBe(true);

    // Attempting to create a READY gate snapshot from the unvalidated admin correction is denied
    const gateAttempt = await service.createGateSnapshot("sm", {
      snapshotId: randomUUID(),
      gateName: "STEP_04_FULL_PERMIT",
      scope: boundScope,
    });
    expect(gateAttempt.ok).toBe(false);

    // Even with independent dual-control approval on the correction, reliance still requires ordinary independent evidence validation
    const { commandHash, scopeHash, dependencyEpoch } = await service.computeDualControlBinding({
      evidenceId,
      version: 1,
      scope: boundScope,
      transitionId: "S11-T06",
    });
    const approvals: ApprovalFact[] = [
      {
        actorId: "sysadmin-1",
        actorKind: "HUMAN",
        assignment: makeAssignment("sysadmin-1", "SYSTEM_ADMIN"),
        approvedAssignmentVersion: 1,
        commandHash,
        scopeHash,
        dependencyEpoch,
        verified: true,
        expiresAt: "2026-11-10T00:00:00.000Z",
      },
      {
        actorId: "exec-1",
        actorKind: "HUMAN",
        assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
        approvedAssignmentVersion: 1,
        commandHash,
        scopeHash,
        dependencyEpoch,
        verified: true,
        expiresAt: "2026-11-10T00:00:00.000Z",
      },
    ];
    const approvedCorr = await service.appendAdminCorrection("admin", {
      correctionId: randomUUID(),
      projectId: PROJECT_ID,
      scope: boundScope,
      sourceAssertionId,
      reason: "Approved factual reference correction with documentary proof",
      replacementAssertion: {
        entityCode: "ADM_SITE_CLEARANCE",
        reportedStatus: "APPROVED",
        authorityRef: "B2-SC-A-2026-001625",
      },
      evidenceLinks: [versionRef],
      regulated: true,
      dualControlTransitionId: "S11-T06",
      approvals,
    });
    expect(approvedCorr.ok).toBe(true);
    if (!approvedCorr.ok) throw new Error(approvedCorr.reason);
    expect(approvedCorr.correction.independentApprovalVerified).toBe(true);

    // Direct SQL DELETE or UPDATE on assertion_records is blocked by immutable trigger
    await expect(
      pool.query(`DELETE FROM "${schema}".assertion_records WHERE assertion_id = $1`, [sourceAssertionId]),
    ).rejects.toThrow(/IMMUTABLE_TABLE_MUTATION_FORBIDDEN/);
  });
});
