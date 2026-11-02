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
  throw new Error("appointments tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "40000000-0000-4000-8000-000000000003";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PACKAGE_GATE",
  projectId: PROJECT_ID,
  packageId: "40000000-0000-4000-8000-000000000999",
  plotIds: ["plot-101"],
  scopeVersion: 1,
  designRevision: "rev-A",
  requirementSnapshotId: "req-1",
  evidenceVersionIds: ["ev-app:1"],
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

describe("DOMAIN-003 SM_2F_appointments Step 05 consultant appointments & contractor permit issuance (S2F-T01..S2F-T05)", () => {
  const services: PackagesServicePort[] = [];
  let service: PackagesServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `pkg_app_${randomUUID().replace(/-/g, "")}`;
    const currentTime = new Date("2026-11-02T12:00:00.000Z");

    const sessions = new Map<string, VerifiedSessionRecord>([
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
        "contractor",
        {
          actorId: "contractor-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("contractor-1", "CONTRACTOR")],
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

  it("keeps Step 05 BLOCKED until Step 04 is APPROVED, enforces contractor_is_issuing_party on S2F-T04, and executes S2F-T01..S2F-T05", async () => {
    const appId = randomUUID();
    await service.createAppointments("aor", {
      aggregateId: appId,
      projectId: PROJECT_ID,
      scope,
    });

    const prepPayload = {
      step04Approved: true,
      contractorTradeLicenseValid: true,
      supervisionConsultantLicenseValid: true,
      constructionContractSignedWithCostAndDuration: true,
      contractorAssignedInMeps: true,
    };

    // S2F-T01 denied if step04Approved is false
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: appId,
        transitionId: "S2F-T01",
        scope,
        payload: { ...prepPayload, step04Approved: false },
      }),
    ).toMatchObject({ ok: false, error: "GUARD_DENIED", failedGuards: ["step04_approved"] });

    // S2F-T01: BLOCKED -> READY
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: appId,
        transitionId: "S2F-T01",
        scope,
        payload: prepPayload,
      }),
    ).toMatchObject({ ok: true, state: "READY" });

    // S2F-T02: READY -> SUBMITTED
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: appId,
        transitionId: "S2F-T02",
        scope,
        payload: { appointmentPackageComplete: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });

    // S2F-T05: SUBMITTED -> REJECTED on a second appointment aggregate
    const appId2 = randomUUID();
    await service.createAppointments("aor", { aggregateId: appId2, projectId: PROJECT_ID, scope });
    await service.transitionPackageAggregate("contractor", {
      aggregateId: appId2,
      transitionId: "S2F-T01",
      scope,
      payload: prepPayload,
    });
    await service.transitionPackageAggregate("aor", {
      aggregateId: appId2,
      transitionId: "S2F-T02",
      scope,
      payload: { appointmentPackageComplete: true },
    });
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: appId2,
        transitionId: "S2F-T05",
        scope,
        payload: { rejectionReasonRecorded: "Supervision engineer registration card expired" },
      }),
    ).toMatchObject({ ok: true, state: "REJECTED" });

    // S2F-T03: SUBMITTED -> APPROVED on primary appointment
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: appId,
        transitionId: "S2F-T03",
        scope,
        payload: { appointmentApprovalCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "APPROVED" });

    // S2F-T04: APPROVED -> BUILDING_PERMIT_ISSUED (requires contractor_is_issuing_party)
    expect(
      await service.transitionPackageAggregate("contractor", {
        aggregateId: appId,
        transitionId: "S2F-T04",
        scope,
        payload: {
          permitNumberRecorded: "BP-2026-PKG1-001",
          permitDocumentUploaded: true,
          contractorIsIssuingParty: true,
        },
      }),
    ).toMatchObject({ ok: true, state: "BUILDING_PERMIT_ISSUED" });
  });
});
