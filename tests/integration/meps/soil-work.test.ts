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
  throw new Error("soil-work tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "20000000-0000-4000-8000-000000000004";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-soil-work:1"],
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

describe("DOMAIN-002 SM_2C_soil_work lifecycle & site-clearance unlock gate (S2C-T01..S2C-T06)", () => {
  const services: MepsServicePort[] = [];
  let service: MepsServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `meps_sw_${randomUUID().replace(/-/g, "")}`;
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
        "sm",
        {
          actorId: "sm-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("sm-1", "STAKEHOLDER_MANAGER")],
        },
      ],
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

  it("denies S2C-T01 UNLOCK when site clearance is unverified, and executes all 6 SM_2C_soil_work transitions (S2C-T01..S2C-T06)", async () => {
    const swId = randomUUID();
    await service.createSoilWorkPermit("aor", {
      aggregateId: swId,
      projectId: PROJECT_ID,
      scope,
    });

    // S2C-T01 denied when siteClearanceAllApprovedOrGovernmentExempt is false
    const deniedUnlock = await service.transitionMeps("sys", {
      aggregateId: swId,
      transitionId: "S2C-T01",
      scope,
      payload: { siteClearanceAllApprovedOrGovernmentExempt: false },
    });
    expect(deniedUnlock).toMatchObject({
      ok: false,
      error: "GUARD_DENIED",
      failedGuards: ["site_clearance_all_approved_or_government_exempt"],
    });

    // S2C-T01: LOCKED -> ELIGIBLE
    expect(
      await service.transitionMeps("sys", {
        aggregateId: swId,
        transitionId: "S2C-T01",
        scope,
        payload: { siteClearanceAllApprovedOrGovernmentExempt: true },
      }),
    ).toMatchObject({ ok: true, state: "ELIGIBLE" });

    // S2C-T02: ELIGIBLE -> SUBMITTED
    expect(
      await service.transitionMeps("aor", {
        aggregateId: swId,
        transitionId: "S2C-T02",
        scope,
        payload: { soilWorkPackageComplete: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });

    // S2C-T04: SUBMITTED -> REJECTED
    expect(
      await service.transitionMeps("aor", {
        aggregateId: swId,
        transitionId: "S2C-T04",
        scope,
        payload: { rejectionReasonRecorded: "Borehole location map missing coordinates" },
      }),
    ).toMatchObject({ ok: true, state: "REJECTED" });

    // S2C-T05: REJECTED -> ELIGIBLE
    expect(
      await service.transitionMeps("aor", {
        aggregateId: swId,
        transitionId: "S2C-T05",
        scope,
        payload: { correctionsRecorded: true },
      }),
    ).toMatchObject({ ok: true, state: "ELIGIBLE" });

    // S2C-T02 -> S2C-T03: SUBMITTED -> APPROVED
    await service.transitionMeps("aor", {
      aggregateId: swId,
      transitionId: "S2C-T02",
      scope,
      payload: { soilWorkPackageComplete: true },
    });
    expect(
      await service.transitionMeps("aor", {
        aggregateId: swId,
        transitionId: "S2C-T03",
        scope,
        payload: { approvalEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "APPROVED" });

    // S2C-T06: WITHDRAW from ELIGIBLE on second soil work permit
    const swId2 = randomUUID();
    await service.createSoilWorkPermit("aor", {
      aggregateId: swId2,
      projectId: PROJECT_ID,
      scope,
    });
    await service.transitionMeps("sys", {
      aggregateId: swId2,
      transitionId: "S2C-T01",
      scope,
      payload: { siteClearanceAllApprovedOrGovernmentExempt: true },
    });
    expect(
      await service.transitionMeps("sm", {
        aggregateId: swId2,
        transitionId: "S2C-T06",
        scope,
        payload: { reasonRecorded: "Consolidated with primary borehole permit" },
      }),
    ).toMatchObject({ ok: true, state: "WITHDRAWN" });
  });
});
