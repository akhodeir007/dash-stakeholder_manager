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
import {
  THIRD_PARTY_SOURCE_TRUTH,
  createThirdPartyService,
  type ThirdPartyServicePort,
} from "../../../src/domain/third-party";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("third-party tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "30000000-0000-4000-8000-000000000003";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-tp:1"],
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

describe("DOMAIN-004 SM_4_third_party Qualiconsult Form 22 & DMT/PAS/OUT/2026/8415 lifecycle (S4-T01..S4-T09)", () => {
  const services: ThirdPartyServicePort[] = [];
  let service: ThirdPartyServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `tp_${randomUUID().replace(/-/g, "")}`;
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
      [
        "exec",
        {
          actorId: "exec-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("exec-1", "CLIENT_EXECUTIVE")],
        },
      ],
      [
        "tpi",
        {
          actorId: "qualiconsult-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("qualiconsult-1", "THIRD_PARTY_INSPECTOR")],
        },
      ],
    ]);

    const authorization = createAuthorizationService({
      verifySession: async (cred) => (typeof cred === "string" ? (sessions.get(cred) ?? null) : null),
      rules: transitions,
    });

    service = createThirdPartyService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("verifies Form 22 & DMT/PAS/OUT/2026/8415 source truths, keeps technical work locked in DMT_LICENSING_APPROVED, and executes S4-T01..S4-T09", async () => {
    expect(THIRD_PARTY_SOURCE_TRUTH).toMatchObject({
      clientLetterRef: "AMR-OUT-26-0124",
      form22Ref: "B2N-2026-002940",
      dmtLetterRef: "DMT/PAS/OUT/2026/8415",
      consultant: "Qualiconsult International",
      authorizedScopes: ["STRUCTURAL_PLAN_REVIEW", "STRUCTURAL_INSPECTION"],
    });

    const tpId = randomUUID();
    await service.createThirdPartyAuthorization("sm", {
      aggregateId: tpId,
      projectId: PROJECT_ID,
      scope,
    });

    // S4-T01: CLIENT_DELEGATION_SIGNED -> FORM_22_EXECUTED
    expect(
      await service.transitionThirdParty("exec", {
        aggregateId: tpId,
        transitionId: "S4-T01",
        scope,
        payload: { signedForm22Uploaded: true, consultantCompliancePledgeSigned: true },
      }),
    ).toMatchObject({ ok: true, state: "FORM_22_EXECUTED" });

    // S4-T02: FORM_22_EXECUTED -> MEPS_APPOINTMENT_SUBMITTED
    expect(
      await service.transitionThirdParty("aor", {
        aggregateId: tpId,
        transitionId: "S4-T02",
        scope,
        payload: { mepsSubmissionReceiptCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "MEPS_APPOINTMENT_SUBMITTED" });

    // S4-T03: MEPS_APPOINTMENT_SUBMITTED -> APPOINTMENT_UNDER_PROCESS (captures DMT/PAS/OUT/2026/8415)
    expect(
      await service.transitionThirdParty("sm", {
        aggregateId: tpId,
        transitionId: "S4-T03",
        scope,
        payload: { dmtLetter8415Captured: true },
      }),
    ).toMatchObject({ ok: true, state: "APPOINTMENT_UNDER_PROCESS" });
    expect(await service.isTechnicalWorkUnlocked(tpId)).toBe(false);

    // S4-T04: APPOINTMENT_UNDER_PROCESS -> DMT_LICENSING_APPROVED (still locked for technical acts!)
    expect(
      await service.transitionThirdParty("sm", {
        aggregateId: tpId,
        transitionId: "S4-T04",
        scope,
        payload: { dmtExecutiveDirectorApprovalCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "DMT_LICENSING_APPROVED" });
    expect(await service.isTechnicalWorkUnlocked(tpId)).toBe(false);

    // S4-T05: DMT_LICENSING_APPROVED -> INSPECTION_ACTIVE (unlocks structural plan review, inspection, and soil stamp)
    expect(
      await service.transitionThirdParty("tpi", {
        aggregateId: tpId,
        transitionId: "S4-T05",
        scope,
        payload: {
          authorizedScopeCoversRequiredWork: true,
          inspectionScopeDefined: true,
          inspectorCredentialsValid: true,
          assignmentRecorded: true,
        },
      }),
    ).toMatchObject({ ok: true, state: "INSPECTION_ACTIVE" });
    expect(await service.isTechnicalWorkUnlocked(tpId)).toBe(true);

    // S4-T07: INSPECTION_ACTIVE -> SUSPENDED (bumps dependency_epoch and locks technical work)
    const epochBeforeSuspend = await service.getProjectEpoch(PROJECT_ID);
    expect(
      await service.transitionThirdParty("sm", {
        aggregateId: tpId,
        transitionId: "S4-T07",
        scope,
        payload: { suspensionReasonRecorded: "Temporary trade license renewal check" },
      }),
    ).toMatchObject({ ok: true, state: "SUSPENDED" });
    expect(await service.getProjectEpoch(PROJECT_ID)).toBe(epochBeforeSuspend + 1);
    expect(await service.isTechnicalWorkUnlocked(tpId)).toBe(false);

    // S4-T08: SUSPENDED -> INSPECTION_ACTIVE
    expect(
      await service.transitionThirdParty("sm", {
        aggregateId: tpId,
        transitionId: "S4-T08",
        scope,
        payload: { suspensionResolved: true, reinstatementEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "INSPECTION_ACTIVE" });
    expect(await service.isTechnicalWorkUnlocked(tpId)).toBe(true);

    // S4-T09: INSPECTION_ACTIVE -> EXPIRED (bumps dependency_epoch)
    const epochBeforeExpire = await service.getProjectEpoch(PROJECT_ID);
    expect(
      await service.transitionThirdParty("sys", {
        aggregateId: tpId,
        transitionId: "S4-T09",
        scope,
        payload: { authorizationExpiryPassed: true },
      }),
    ).toMatchObject({ ok: true, state: "EXPIRED" });
    expect(await service.getProjectEpoch(PROJECT_ID)).toBe(epochBeforeExpire + 1);

    // S4-T06: REJECT from APPOINTMENT_UNDER_PROCESS on a second authorization record
    const tpId2 = randomUUID();
    await service.createThirdPartyAuthorization("sm", {
      aggregateId: tpId2,
      projectId: PROJECT_ID,
      scope,
    });
    await service.transitionThirdParty("sm", {
      aggregateId: tpId2,
      transitionId: "S4-T01",
      scope,
      payload: { signedForm22Uploaded: true, consultantCompliancePledgeSigned: true },
    });
    await service.transitionThirdParty("aor", {
      aggregateId: tpId2,
      transitionId: "S4-T02",
      scope,
      payload: { mepsSubmissionReceiptCaptured: true },
    });
    await service.transitionThirdParty("sm", {
      aggregateId: tpId2,
      transitionId: "S4-T03",
      scope,
      payload: { dmtLetter8415Captured: true },
    });
    expect(
      await service.transitionThirdParty("sm", {
        aggregateId: tpId2,
        transitionId: "S4-T06",
        scope,
        payload: { rejectionReasonRecorded: "Incomplete classification certificate" },
      }),
    ).toMatchObject({ ok: true, state: "REJECTED" });
  });
});
