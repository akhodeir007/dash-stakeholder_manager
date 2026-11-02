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
  throw new Error("gate-snapshot tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

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

describe("BUILD-004 gate snapshot bindings, shared evidence coverage & synchronous clock expiry (CS-010, IE-019, IE-036, GAP-05)", () => {
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
    schema = `ev_gate_${randomUUID().replace(/-/g, "")}`;
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
          actorId: "aor-user",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("aor-user", "AOR_LEAD")],
        },
      ],
      [
        "sm",
        {
          actorId: "sm-user",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("sm-user", "STAKEHOLDER_MANAGER")],
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
          return { objectKey: input.objectKey, contentHash: "b".repeat(64), byteSize: input.content.byteLength };
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

  it("denies cross-package, cross-plot, or changed revision reuse unless explicit verified coverage is registered (GAP-05, SNAPSHOT-BINDING)", async () => {
    const evidenceId = randomUUID();
    const versionRef = `${evidenceId}:1`;
    const pkg1Scope: ScopeBinding = {
      kind: "PACKAGE_GATE",
      projectId: PROJECT_ID,
      packageId: "PACKAGE_I",
      plotIds: ["plot-1", "plot-2"],
      scopeVersion: 1,
      designRevision: "rev-A",
      requirementSnapshotId: "req-1",
      evidenceVersionIds: [versionRef],
    };

    await service.uploadEvidenceVersion("aor", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope: pkg1Scope,
      content: Buffer.from("%PDF-1.7 shared-noc"),
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: "AUTHORITY_NOC",
      authorityRef: "EAD-NOC-2026-01",
      signerId: null,
      issuerId: "EAD",
      source: "tracker",
      provenance: "sheet1:r1",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: "2027-06-01T00:00:00.000Z",
    });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T01", scope: pkg1Scope });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T02", scope: pkg1Scope });
    await service.validateEvidence("sm", {
      evidenceId,
      version: 1,
      scope: pkg1Scope,
      verdict: "VALID",
      reason: "Verified for PACKAGE_I plots 1 & 2",
    });
    await service.transitionDocument("sm", { evidenceId, version: 1, transitionId: "S10-T05", scope: pkg1Scope });

    const relPkg1 = await service.evaluateReliance("sm", {
      evidenceId,
      version: 1,
      scope: pkg1Scope,
      reason: "Evaluate reliance for PACKAGE_I",
    });
    expect(relPkg1.ok && relPkg1.evaluation.status).toBe("VERIFIED");

    // Reusing on PACKAGE_II without explicit verified coverage -> SCOPE_MISMATCH
    const pkg2Scope: ScopeBinding = {
      ...pkg1Scope,
      packageId: "PACKAGE_II",
    };
    const relPkg2 = await service.evaluateReliance("sm", {
      evidenceId,
      version: 1,
      scope: pkg2Scope,
      reason: "Attempt unverified reuse on PACKAGE_II",
    });
    expect(relPkg2.ok && relPkg2.evaluation.status).toBe("SCOPE_MISMATCH");

    // Reusing on additional plot-3 or changed designRevision -> SCOPE_MISMATCH
    const extraPlotRel = await service.evaluateReliance("sm", {
      evidenceId,
      version: 1,
      scope: { ...pkg1Scope, plotIds: ["plot-1", "plot-2", "plot-3"] },
      reason: "Attempt extra plot",
    });
    expect(extraPlotRel.ok && extraPlotRel.evaluation.status).toBe("SCOPE_MISMATCH");

    const changedDesignRel = await service.evaluateReliance("sm", {
      evidenceId,
      version: 1,
      scope: { ...pkg1Scope, designRevision: "rev-B" },
      reason: "Attempt changed design revision",
    });
    expect(changedDesignRel.ok && changedDesignRel.evaluation.status).toBe("SCOPE_MISMATCH");

    // Non-gate scopes (PROJECT_SCOPE and PROVISIONAL_PLOT_SCOPE) cannot create a package gate snapshot
    const provisionalGate = await service.createGateSnapshot("sm", {
      snapshotId: randomUUID(),
      gateName: "STEP_04_FULL_PERMIT",
      scope: {
        kind: "PROVISIONAL_PLOT_SCOPE",
        provisionalCaseId: "case-1",
        plotIds: ["plot-1"],
        intakeVersion: 1,
        initiatorAssignmentId: "assign-aor-user-AOR_LEAD",
        sourceAssertionIds: ["assert-1"],
      },
    });
    expect(provisionalGate.ok).toBe(false);

    // Registering explicit verified coverage for PACKAGE_II allows reliance & gate snapshot on PACKAGE_II
    const cov = await service.registerVerifiedScopeCoverage("sm", {
      evidenceId,
      version: 1,
      scope: pkg2Scope,
      reason: "Stakeholder manager verified shared EAD NOC covers PACKAGE_II plots 1 & 2",
    });
    expect(cov.ok).toBe(true);

    const relPkg2AfterCoverage = await service.evaluateReliance("sm", {
      evidenceId,
      version: 1,
      scope: pkg2Scope,
      reason: "Re-evaluate PACKAGE_II after explicit coverage",
    });
    expect(relPkg2AfterCoverage.ok && relPkg2AfterCoverage.evaluation.status).toBe("VERIFIED");
  });

  it("denies stored READY gate snapshot immediately when dependency epoch changes or injected clock crosses expiry (CS-010, IE-019, IE-036)", async () => {
    const evidenceId = randomUUID();
    const versionRef = `${evidenceId}:1`;
    const scope: ScopeBinding = {
      kind: "PACKAGE_GATE",
      projectId: PROJECT_ID,
      packageId: "PACKAGE_I",
      plotIds: ["plot-1"],
      scopeVersion: 1,
      designRevision: "rev-A",
      requirementSnapshotId: "req-1",
      evidenceVersionIds: [versionRef],
    };

    await service.uploadEvidenceVersion("aor", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("%PDF-1.7 time-bound-noc"),
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: "AUTHORITY_NOC",
      authorityRef: "ADCD-NOC-2026-77",
      signerId: null,
      issuerId: "ADCD",
      source: "tracker",
      provenance: "sheet1:r8",
      validFrom: "2026-10-01T00:00:00.000Z",
      validUntil: "2026-12-01T00:00:00.000Z",
    });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T01", scope });
    await service.transitionDocument("sys", { evidenceId, version: 1, transitionId: "S10-T02", scope });
    await service.validateEvidence("sm", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "Verified ADCD NOC",
    });
    await service.transitionDocument("sm", { evidenceId, version: 1, transitionId: "S10-T05", scope });
    await service.evaluateReliance("sm", { evidenceId, version: 1, scope, reason: "Verified reliance" });

    const snapshotId = randomUUID();
    const snap = await service.createGateSnapshot("sm", {
      snapshotId,
      gateName: "STEP_04_FULL_PERMIT",
      scope,
    });
    expect(snap.ok).toBe(true);
    if (!snap.ok) throw new Error(snap.reason);
    expect(snap.snapshot.status).toBe("READY");

    // Eligible at 2026-11-02T12:00:00Z
    const eligibleNow = await service.evaluateGateEligibility("aor", {
      snapshotId,
      targetScope: scope,
    });
    expect(eligibleNow).toMatchObject({ eligible: true });

    // Advance injected clock past 2026-12-01 WITHOUT running any background expiry timer (IE-036)
    currentTime = new Date("2026-12-01T00:00:01.000Z");
    const expiredByClock = await service.evaluateGateEligibility("aor", {
      snapshotId,
      targetScope: scope,
    });
    expect(expiredByClock).toMatchObject({ eligible: false, code: "EVIDENCE_EXPIRED" });

    // Rewind clock to valid window, then trigger material dependency change (design_revision_change) (CS-010, IE-019)
    currentTime = new Date("2026-11-15T00:00:00.000Z");
    const inv = await service.invalidateDependency("sm", {
      projectId: PROJECT_ID,
      scope,
      changeKind: "design_revision_change",
      reason: "Masterplan plot boundary revision",
    });
    expect(inv.ok).toBe(true);

    const staleAfterInvalidation = await service.evaluateGateEligibility("aor", {
      snapshotId,
      targetScope: scope,
    });
    expect(staleAfterInvalidation).toMatchObject({ eligible: false, code: "STALE_SNAPSHOT" });
  });
});
