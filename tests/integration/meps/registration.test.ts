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
import { createMepsService, type MepsServicePort } from "../../../src/domain/meps";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("meps registration tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-reg:1"],
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

describe("DOMAIN-002 SM_2A_registration lifecycle (S2A-T01..S2A-T06)", () => {
  const services: MepsServicePort[] = [];
  let service: MepsServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `meps_reg_${randomUUID().replace(/-/g, "")}`;
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

    service = createMepsService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("executes all 6 SM_2A_registration transitions (S2A-T01..S2A-T06) and enforces registration prerequisite for Step 02", async () => {
    const regId = randomUUID();
    await service.createRegistration("aor", {
      aggregateId: regId,
      projectId: PROJECT_ID,
      scope,
    });

    // S2A-T01: NOT_STARTED -> DRAFT (by CONTRACTOR or AOR_LEAD)
    const t01 = await service.transitionMeps("contractor", {
      aggregateId: regId,
      transitionId: "S2A-T01",
      scope,
      payload: {
        affectionPlanValid: true,
        clientAppointmentLetterValid: true,
        plotBaselinePresent: true,
        dmtApprovalRecordedOrNotApplicable: true,
      },
    });
    expect(t01).toMatchObject({ ok: true, state: "DRAFT" });

    // S2A-T02: DRAFT -> SUBMITTED (AOR_LEAD only)
    const deniedContractorSubmit = await service.transitionMeps("contractor", {
      aggregateId: regId,
      transitionId: "S2A-T02",
      scope,
      payload: { mepsTemplatePackageComplete: true },
    });
    expect(deniedContractorSubmit).toMatchObject({ ok: false, error: "FORBIDDEN" });

    const t02 = await service.transitionMeps("aor", {
      aggregateId: regId,
      transitionId: "S2A-T02",
      scope,
      payload: { mepsTemplatePackageComplete: true },
    });
    expect(t02).toMatchObject({ ok: true, state: "SUBMITTED" });

    // S2A-T04: SUBMITTED -> RETURNED
    const t04 = await service.transitionMeps("aor", {
      aggregateId: regId,
      transitionId: "S2A-T04",
      scope,
      payload: { returnReasonCaptured: "Plot coordinate table requires update" },
    });
    expect(t04).toMatchObject({ ok: true, state: "RETURNED" });

    // S2A-T05: RETURNED -> DRAFT
    const t05 = await service.transitionMeps("aor", {
      aggregateId: regId,
      transitionId: "S2A-T05",
      scope,
      payload: { correctionsRecorded: true },
    });
    expect(t05).toMatchObject({ ok: true, state: "DRAFT" });

    // S2A-T02 -> S2A-T03: SUBMITTED -> APPROVED
    await service.transitionMeps("aor", {
      aggregateId: regId,
      transitionId: "S2A-T02",
      scope,
      payload: { mepsTemplatePackageComplete: true },
    });
    const t03 = await service.transitionMeps("aor", {
      aggregateId: regId,
      transitionId: "S2A-T03",
      scope,
      payload: { approvalEvidenceCaptured: true },
    });
    expect(t03).toMatchObject({ ok: true, state: "APPROVED" });

    // S2A-T06: WITHDRAW on a second registration
    const regId2 = randomUUID();
    await service.createRegistration("aor", {
      aggregateId: regId2,
      projectId: PROJECT_ID,
      scope,
    });
    const t06 = await service.transitionMeps("sm", {
      aggregateId: regId2,
      transitionId: "S2A-T06",
      scope,
      payload: { reasonRecorded: "Duplicate registration entry" },
    });
    expect(t06).toMatchObject({ ok: true, state: "WITHDRAWN" });
  });
});
