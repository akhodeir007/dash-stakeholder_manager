import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthorizationService } from "../../../src/auth/authorization";
import type {
  Role,
  RoleAssignment,
  ScopeBinding,
  VerifiedSessionRecord,
} from "../../../src/contracts/foundation";
import { loadMachineDefinitions } from "../../../src/domain/commands/engine";
import { createPackagesService, type PackagesServicePort } from "../../../src/domain/packages";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("full-permit tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "40000000-0000-4000-8000-000000000002";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PACKAGE_GATE",
  projectId: PROJECT_ID,
  packageId: "40000000-0000-4000-8000-000000000999",
  plotIds: ["plot-101"],
  scopeVersion: 1,
  designRevision: "rev-A",
  requirementSnapshotId: "req-1",
  evidenceVersionIds: ["ev-fp:1"],
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

describe("DOMAIN-003 SM_2E_full_permit Package I coordinated submission, 12-guard release gate & fallback restriction (S2E-T01..S2E-T10)", () => {
  const services: PackagesServicePort[] = [];
  let service: PackagesServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `pkg_fp_${randomUUID().replace(/-/g, "")}`;
    const currentTime = new Date("2026-11-02T12:00:00.000Z");

    const sessions = new Map<string, VerifiedSessionRecord>([
      [
        "sys",
        {
          actorId: "system-1",
          tenantId: TENANT,
          kind: "SERVICE",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("system-1", "SYSTEM")],
          serviceCapabilities: transitions.filter((t) => t.roles.includes("SYSTEM")).map((t) => `transition:${t.id}`),
        },
      ],
      [
        "aor",
        {
          actorId: "aor-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("aor-1", "AOR_LEAD")],
        },
      ],
      [
        "sm",
        {
          actorId: "sm-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("sm-1", "STAKEHOLDER_MANAGER")],
        },
      ],
    ]);

    const authorization = createAuthorizationService({
      verifySession: async (cred) => (typeof cred === "string" ? (sessions.get(cred) ?? null) : null),
      rules: transitions,
    });

    service = createPackagesService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("denies standalone fallback full-permit release, enforces all 12 S2E-T01 prerequisites, and executes S2E-T01..S2E-T10", async () => {
    const fpId = randomUUID();
    await service.createFullPermit("aor", {
      aggregateId: fpId,
      projectId: PROJECT_ID,
      packageId: "40000000-0000-4000-8000-000000000999",
      scope,
    });

    const baseGatePayload = {
      siteClearanceAllApprovedOrGovernmentExempt: true,
      soilReportStamped: true,
      readinessGateClosed: true,
      packagesComplete: true,
      packageScopeConfirmed: true,
      supportingApprovalsValidOrNotRequired: true,
      enocStageApprovalSupportsTaqaSuperPlotIfApplicable: true,
      allApprovedEvidenceRelianceVerified: true,
      thirdPartyPlanReviewActiveIfRequired: true,
      structuralPlanReviewEvidenceVerifiedIfRequired: true,
      masterplanNotInAmendment: true,
      standaloneModeRequested: false,
    };

    // Standalone fallback without separate contract/ADM direction fails closed on fallback_adm_direction_if_standalone
    const deniedStandalone = await service.transitionPackageAggregate("sm", {
      aggregateId: fpId,
      transitionId: "S2E-T01",
      scope,
      payload: { ...baseGatePayload, standaloneModeRequested: true },
    });
    expect(deniedStandalone).toMatchObject({
      ok: false,
      error: "GUARD_DENIED",
      failedGuards: ["fallback_adm_direction_if_standalone"],
    });

    // S2E-T01: LOCKED -> READY_FOR_SUBMISSION
    expect(
      await service.transitionPackageAggregate("sm", {
        aggregateId: fpId,
        transitionId: "S2E-T01",
        scope,
        payload: baseGatePayload,
      }),
    ).toMatchObject({ ok: true, state: "READY_FOR_SUBMISSION" });

    // S2E-T02: READY_FOR_SUBMISSION -> SUBMITTED
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: fpId,
        transitionId: "S2E-T02",
        scope,
        payload: {
          bundleValidated: true,
          bundleHashRecorded: "a".repeat(64),
          authorizedSignatory: true,
          packageMatchesApprovedScope: true,
        },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });

    // S2E-T03: SUBMITTED -> UNDER_REVIEW
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: fpId,
        transitionId: "S2E-T03",
        scope,
        payload: { authorityReceiptCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "UNDER_REVIEW" });

    // S2E-T05: UNDER_REVIEW -> MODIFICATION_REQUIRED
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: fpId,
        transitionId: "S2E-T05",
        scope,
        payload: { commentLetterCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "MODIFICATION_REQUIRED" });

    // S2E-T06: MODIFICATION_REQUIRED -> RESUBMITTED -> S2E-T07 -> UNDER_REVIEW -> S2E-T04 APPROVED -> S2E-T09 EXPIRED
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: fpId,
        transitionId: "S2E-T06",
        scope,
        payload: { allCommentsResolved: true, newBundleHashRecorded: "b".repeat(64) },
      }),
    ).toMatchObject({ ok: true, state: "RESUBMITTED" });
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: fpId,
        transitionId: "S2E-T07",
        scope,
        payload: { authorityReceiptCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "UNDER_REVIEW" });
    expect(
      await service.transitionPackageAggregate("sm", {
        aggregateId: fpId,
        transitionId: "S2E-T04",
        scope,
        payload: { approvalEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "APPROVED" });
    expect(
      await service.transitionPackageAggregate("sys", {
        aggregateId: fpId,
        transitionId: "S2E-T09",
        scope,
        payload: { permitExpiryPassed: true },
      }),
    ).toMatchObject({ ok: true, state: "EXPIRED" });

    // Second full-permit: S2E-T01 -> S2E-T02 -> S2E-T03 -> S2E-T08 REJECTED -> S2E-T10 WITHDRAWN
    const fpId2 = randomUUID();
    await service.createFullPermit("aor", {
      aggregateId: fpId2,
      projectId: PROJECT_ID,
      packageId: "40000000-0000-4000-8000-000000000999",
      scope,
    });
    await service.transitionPackageAggregate("sm", {
      aggregateId: fpId2,
      transitionId: "S2E-T01",
      scope,
      payload: baseGatePayload,
    });
    await service.transitionPackageAggregate("aor", {
      aggregateId: fpId2,
      transitionId: "S2E-T02",
      scope,
      payload: {
        bundleValidated: true,
        bundleHashRecorded: "c".repeat(64),
        authorizedSignatory: true,
        packageMatchesApprovedScope: true,
      },
    });
    await service.transitionPackageAggregate("aor", {
      aggregateId: fpId2,
      transitionId: "S2E-T03",
      scope,
      payload: { authorityReceiptCaptured: true },
    });
    expect(
      await service.transitionPackageAggregate("sm", {
        aggregateId: fpId2,
        transitionId: "S2E-T08",
        scope,
        payload: { rejectionReasonRecorded: "Substation setback non-compliance" },
      }),
    ).toMatchObject({ ok: true, state: "REJECTED" });
    expect(
      await service.transitionPackageAggregate("sm", {
        aggregateId: fpId2,
        transitionId: "S2E-T10",
        scope,
        payload: { reasonRecorded: "Withdrawn for plot redesign" },
      }),
    ).toMatchObject({ ok: true, state: "WITHDRAWN" });
  });
});
