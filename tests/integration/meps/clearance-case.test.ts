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
  throw new Error("clearance-case tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "20000000-0000-4000-8000-000000000003";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-case:1"],
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

describe("DOMAIN-002 SM_2B_case derived aggregate, pre-project linkage & government exemption (S2BC-T01..S2BC-T16)", () => {
  const services: MepsServicePort[] = [];
  let service: MepsServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `meps_case_${randomUUID().replace(/-/g, "")}`;
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

  it("enforces pre-project linkage, blocks S2BC-T07 when approved entity lacks verified reliance, and supports government exemption grant/revocation (S2BC-T01..S2BC-T16)", async () => {
    const caseId = randomUUID();
    await service.createClearanceCase("aor", {
      aggregateId: caseId,
      projectId: PROJECT_ID,
      scope,
    });

    // S2BC-T02: NOT_STARTED -> PRE_PROJECT
    expect(
      await service.transitionMeps("contractor", {
        aggregateId: caseId,
        transitionId: "S2BC-T02",
        scope,
        payload: {
          siteClearancePreProjectAllowed: true,
          plotIdentified: true,
          initiatorIsConsultantOrContractor: true,
        },
      }),
    ).toMatchObject({ ok: true, state: "PRE_PROJECT" });

    // S2BC-T03: PRE_PROJECT -> PREPARING (requires meps_project_registered & project_link_recorded)
    expect(
      await service.transitionMeps("aor", {
        aggregateId: caseId,
        transitionId: "S2BC-T03",
        scope,
        payload: { mepsProjectRegistered: true, projectLinkRecorded: true },
      }),
    ).toMatchObject({ ok: true, state: "PREPARING" });

    // S2BC-T04: PREPARING -> SUBMITTED
    expect(
      await service.transitionMeps("aor", {
        aggregateId: caseId,
        transitionId: "S2BC-T04",
        scope,
        payload: { atLeastOneEntitySubmitted: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });

    // S2BC-T05: SUBMITTED -> UNDER_REVIEW
    expect(
      await service.transitionMeps("aor", {
        aggregateId: caseId,
        transitionId: "S2BC-T05",
        scope,
        payload: { authorityReceiptsCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "UNDER_REVIEW" });

    // S2BC-T06: UNDER_REVIEW -> PARTIALLY_APPROVED
    expect(
      await service.transitionMeps("sys", {
        aggregateId: caseId,
        transitionId: "S2BC-T06",
        scope,
        payload: { atLeastOneEntityApproved: true, notAllEntitiesApproved: true },
      }),
    ).toMatchObject({ ok: true, state: "PARTIALLY_APPROVED" });

    // S2BC-T08: PARTIALLY_APPROVED -> PENDING_MODIFICATION
    expect(
      await service.transitionMeps("sys", {
        aggregateId: caseId,
        transitionId: "S2BC-T08",
        scope,
        payload: { anyRequiredEntityInModificationOrPendingDocuments: true },
      }),
    ).toMatchObject({ ok: true, state: "PENDING_MODIFICATION" });

    // S2BC-T09: PENDING_MODIFICATION -> UNDER_REVIEW -> S2BC-T08 -> S2BC-T10 -> PARTIALLY_APPROVED
    expect(
      await service.transitionMeps("sys", {
        aggregateId: caseId,
        transitionId: "S2BC-T09",
        scope,
        payload: { allRequiredEntitiesResubmitted: true },
      }),
    ).toMatchObject({ ok: true, state: "UNDER_REVIEW" });
    await service.transitionMeps("sys", {
      aggregateId: caseId,
      transitionId: "S2BC-T08",
      scope,
      payload: { anyRequiredEntityInModificationOrPendingDocuments: true },
    });
    expect(
      await service.transitionMeps("sys", {
        aggregateId: caseId,
        transitionId: "S2BC-T10",
        scope,
        payload: { atLeastOneEntityApproved: true, notAllEntitiesApproved: true },
      }),
    ).toMatchObject({ ok: true, state: "PARTIALLY_APPROVED" });

    // S2BC-T07: Denied if allApprovedEntitiesRelianceVerified is false (e.g., TAQA_WATER conflict unverified)
    const deniedUnverified = await service.transitionMeps("sys", {
      aggregateId: caseId,
      transitionId: "S2BC-T07",
      scope,
      payload: {
        allRequiredEntitiesApprovedWaivedOrNotRequired: true,
        allApprovedEntitiesRelianceVerified: false,
        noUnwaivedUnavailableInfrastructure: true,
      },
    });
    expect(deniedUnverified).toMatchObject({
      ok: false,
      error: "GUARD_DENIED",
      failedGuards: ["all_approved_entities_reliance_verified"],
    });

    // S2BC-T07: Succeeds when all 13 required entities are approved/waived/not-required AND reliance is VERIFIED
    expect(
      await service.transitionMeps("sys", {
        aggregateId: caseId,
        transitionId: "S2BC-T07",
        scope,
        payload: {
          allRequiredEntitiesApprovedWaivedOrNotRequired: true,
          allApprovedEntitiesRelianceVerified: true,
          noUnwaivedUnavailableInfrastructure: true,
        },
      }),
    ).toMatchObject({ ok: true, state: "ALL_ENTITIES_APPROVED" });

    // S2BC-T11: ALL_ENTITIES_APPROVED -> REOPENED (bumps dependency_epoch)
    const epochBeforeReopen = await service.getProjectEpoch(PROJECT_ID);
    expect(
      await service.transitionMeps("sm", {
        aggregateId: caseId,
        transitionId: "S2BC-T11",
        scope,
        payload: { entityExpiredOrRevoked: true, reasonRecorded: "TAQA NOC expired" },
      }),
    ).toMatchObject({ ok: true, state: "REOPENED" });
    expect(await service.getProjectEpoch(PROJECT_ID)).toBe(epochBeforeReopen + 1);

    // S2BC-T12: REOPENED -> UNDER_REVIEW -> S2BC-T13: REJECT_CASE
    expect(
      await service.transitionMeps("aor", {
        aggregateId: caseId,
        transitionId: "S2BC-T12",
        scope,
        payload: { replacementEntitySubmitted: true },
      }),
    ).toMatchObject({ ok: true, state: "UNDER_REVIEW" });
    expect(
      await service.transitionMeps("sm", {
        aggregateId: caseId,
        transitionId: "S2BC-T13",
        scope,
        payload: { allEntitiesRejectedOrUnavailable: true, executiveNotificationRecorded: true },
      }),
    ).toMatchObject({ ok: true, state: "REJECTED" });

    // Second case: S2BC-T01 -> S2BC-T14 GRANT_GOVERNMENT_EXEMPTION (dual control) -> S2BC-T15 REVOKE_EXEMPTION -> S2BC-T16 WITHDRAW
    const case2 = randomUUID();
    await service.createClearanceCase("aor", {
      aggregateId: case2,
      projectId: PROJECT_ID,
      scope,
    });
    expect(
      await service.transitionMeps("aor", {
        aggregateId: case2,
        transitionId: "S2BC-T01",
        scope,
        payload: { step01ApprovedOrProjectLinked: true, allRequiredEntitiesInitialized: true },
      }),
    ).toMatchObject({ ok: true, state: "PREPARING" });

    const exPayload = {
      governmentOwnedProjectConfirmed: true,
      dmtMasterplanApprovalEvidence: true,
      admMepsExemptionConfirmation: true,
      executiveApprovalRecorded: true,
      reviewDateRecorded: "2027-06-01T00:00:00.000Z",
      reasonRecorded: "ADHA government housing exemption with ADM written confirmation",
    };
    const b14 = await service.computeDualControlBinding({
      aggregateId: case2,
      transitionId: "S2BC-T14",
      scope,
      payload: exPayload,
    });
    expect(
      await service.transitionMeps("sm", {
        aggregateId: case2,
        transitionId: "S2BC-T14",
        scope,
        payload: exPayload,
        approvals: [
          {
            actorId: "sm-1",
            actorKind: "HUMAN",
            assignment: makeAssignment("sm-1", "STAKEHOLDER_MANAGER"),
            approvedAssignmentVersion: 1,
            commandHash: b14.commandHash,
            scopeHash: b14.scopeHash,
            dependencyEpoch: b14.dependencyEpoch,
            verified: true,
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          {
            actorId: "exec-1",
            actorKind: "HUMAN",
            assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
            approvedAssignmentVersion: 1,
            commandHash: b14.commandHash,
            scopeHash: b14.scopeHash,
            dependencyEpoch: b14.dependencyEpoch,
            verified: true,
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ ok: true, state: "EXEMPT_GOVERNMENT_PROJECT" });

    // S2BC-T15: EXEMPT_GOVERNMENT_PROJECT -> REOPENED (bumps dependency_epoch)
    const epochBeforeRevoke = await service.getProjectEpoch(PROJECT_ID);
    expect(
      await service.transitionMeps("sm", {
        aggregateId: case2,
        transitionId: "S2BC-T15",
        scope,
        payload: { exemptionNoLongerValid: true, reasonRecorded: "Exemption review date expired" },
      }),
    ).toMatchObject({ ok: true, state: "REOPENED" });
    expect(await service.getProjectEpoch(PROJECT_ID)).toBe(epochBeforeRevoke + 1);

    // S2BC-T16: REOPENED -> WITHDRAWN
    expect(
      await service.transitionMeps("sm", {
        aggregateId: case2,
        transitionId: "S2BC-T16",
        scope,
        payload: { reasonRecorded: "Replaced by consolidated site-clearance application" },
      }),
    ).toMatchObject({ ok: true, state: "WITHDRAWN" });
  });
});
