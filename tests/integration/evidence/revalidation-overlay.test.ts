import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthorizationService } from "../../../src/auth/authorization";
import type {
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
  throw new Error("revalidation-overlay tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";

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

describe("BUILD-004 revalidation overlay, reliance.invalidated events & non-destructive authority history (CS-022, GAP-01)", () => {
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
    schema = `ev_rev_${randomUUID().replace(/-/g, "")}`;
    currentTime = new Date("2026-11-02T12:00:00.000Z");

    const sessions = new Map<string, VerifiedSessionRecord>([
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
        "sm",
        {
          actorId: "sm-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("sm-1", "STAKEHOLDER_MANAGER")],
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
          return { objectKey: input.objectKey, contentHash: "d".repeat(64), byteSize: input.content.byteLength };
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

  it("updates orthogonal revalidation overlay on reliance.invalidated without rewriting recorded authority status, dedupes events, and requires fresh verification to recover (CS-022, GAP-01)", async () => {
    const evidenceId = randomUUID();
    const versionRef1 = `${evidenceId}:1`;
    const scope: ScopeBinding = {
      kind: "PACKAGE_GATE",
      projectId: PROJECT_ID,
      packageId: "PACKAGE_I",
      plotIds: ["plot-501"],
      scopeVersion: 1,
      designRevision: "rev-A",
      requirementSnapshotId: "req-1",
      evidenceVersionIds: [versionRef1],
    };

    await service.uploadEvidenceVersion("aor", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("%PDF-1.7 issued-permit-evidence"),
      mediaType: "application/pdf",
      evidenceClass: "AUTHORITY_APPROVAL",
      documentType: "BUILDING_PERMIT_APPROVAL",
      authorityRef: "ADM-BP-2026-501",
      signerId: null,
      issuerId: "ADM",
      source: "tracker",
      provenance: "row-20",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: "2027-06-01T00:00:00.000Z",
    });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T01", scope });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T02", scope });
    await service.validateEvidence("sm", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "Verified ADM approval",
    });
    await service.transitionDocument("sm", { evidenceId, version: 1, transitionId: "S10-T05", scope });
    await service.evaluateReliance("sm", { evidenceId, version: 1, scope, reason: "Verified reliance" });

    // Record authority status APPROVED
    const assertionId = randomUUID();
    await service.recordAuthorityFact("aor", {
      assertionId,
      projectId: PROJECT_ID,
      scope,
      entityCode: "STEP_04_PACKAGE_I_PERMIT",
      reportedStatus: "APPROVED",
      authorityRef: "ADM-BP-2026-501",
      evidenceId,
      evidenceVersion: 1,
      conflictDetected: false,
      notes: "Permit approved by ADM",
    });

    const initialGate = await service.createGateSnapshot("sm", {
      snapshotId: randomUUID(),
      gateName: "STEP_04_FULL_PERMIT",
      scope,
    });
    expect(initialGate.ok).toBe(true);

    // Emit and process reliance.invalidated event (CS-022)
    const eventId = randomUUID();
    const processed1 = await service.processRelianceInvalidatedEvent("sys", {
      eventId,
      handlerName: "revalidation-overlay-projector",
      projectId: PROJECT_ID,
      scope,
      changeKind: "revocation",
      reason: "Upstream utility NOC dependency revoked",
    });
    expect(processed1).toMatchObject({
      ok: true,
      deduped: false,
      revalidationStatus: "REQUIRED",
      authorityReportedStatusPreserved: "APPROVED",
    });

    // Duplicate delivery of the same event is deduped and does not bump epoch a second time
    const stateAfterFirst = await service.getProjectState(PROJECT_ID);
    const processedDup = await service.processRelianceInvalidatedEvent("sys", {
      eventId,
      handlerName: "revalidation-overlay-projector",
      projectId: PROJECT_ID,
      scope,
      changeKind: "revocation",
      reason: "Upstream utility NOC dependency revoked",
    });
    expect(processedDup).toMatchObject({
      ok: true,
      deduped: true,
      revalidationStatus: "REQUIRED",
    });
    const stateAfterDup = await service.getProjectState(PROJECT_ID);
    expect(stateAfterDup.dependencyEpoch).toBe(stateAfterFirst.dependencyEpoch);

    // Historical authority status remains APPROVED (never automatically legally revoked by software!)
    const history = await service.getAssertionHistory(PROJECT_ID, "STEP_04_PACKAGE_I_PERMIT");
    expect(history[0].reportedStatus).toBe("APPROVED");

    // Attempting to recover revalidation with stale/unverified reliance or old epoch is denied
    const prematureRecovery = await service.recoverRevalidation("sm", {
      projectId: PROJECT_ID,
      snapshotId: initialGate.ok ? initialGate.snapshot.snapshotId : "",
      scope,
    });
    expect(prematureRecovery.ok).toBe(false);

    // Fresh reliance evaluation at current epoch + new gate snapshot allows recovery to CLEAR
    const freshReliance = await service.evaluateReliance("sm", {
      evidenceId,
      version: 1,
      scope,
      reason: "Re-verified after dependency resolution",
    });
    expect(freshReliance.ok && freshReliance.evaluation.status).toBe("VERIFIED");

    const freshGate = await service.createGateSnapshot("sm", {
      snapshotId: randomUUID(),
      gateName: "STEP_04_FULL_PERMIT",
      scope,
    });
    expect(freshGate.ok).toBe(true);
    if (!freshGate.ok) throw new Error(freshGate.reason);

    const recovered = await service.recoverRevalidation("sm", {
      projectId: PROJECT_ID,
      snapshotId: freshGate.snapshot.snapshotId,
      scope,
    });
    expect(recovered).toMatchObject({ ok: true, revalidationStatus: "CLEAR" });
  });
});
