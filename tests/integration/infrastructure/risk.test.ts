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
import { createRiskService, type RiskServicePort } from "../../../src/domain/risks";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("risk tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "30000000-0000-4000-8000-000000000004";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-risk:1"],
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

describe("DOMAIN-004 SM_7_risk lifecycle & two-executive dual control ACCEPT_RISK (S7-T01..S7-T08)", () => {
  const services: RiskServicePort[] = [];
  let service: RiskServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `risk_${randomUUID().replace(/-/g, "")}`;
    const currentTime = new Date("2026-11-02T12:00:00.000Z");

    const sessions = new Map<string, VerifiedSessionRecord>([
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
        "exec-1",
        {
          actorId: "exec-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("exec-1", "CLIENT_EXECUTIVE")],
        },
      ],
      [
        "exec-2",
        {
          actorId: "exec-2",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("exec-2", "CLIENT_EXECUTIVE")],
        },
      ],
    ]);

    const authorization = createAuthorizationService({
      verifySession: async (cred) => (typeof cred === "string" ? (sessions.get(cred) ?? null) : null),
      rules: transitions,
    });

    service = createRiskService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("executes all 8 SM_7_risk transitions (S7-T01..S7-T08) and requires two distinct CLIENT_EXECUTIVE humans for S7-T07 ACCEPT_RISK", async () => {
    const riskId = randomUUID();
    await service.createRisk("sm", {
      aggregateId: riskId,
      projectId: PROJECT_ID,
      scope,
    });

    // S7-T01: OPEN -> ASSESSED
    expect(
      await service.transitionRisk("sm", {
        aggregateId: riskId,
        transitionId: "S7-T01",
        scope,
        payload: {
          severityAssigned: "CRITICAL",
          ownerAssigned: "sm-1",
          decisionDueDateSet: "2026-11-15T00:00:00.000Z",
        },
      }),
    ).toMatchObject({ ok: true, state: "ASSESSED" });

    // S7-T07: ASSESSED -> ACCEPTED requires two distinct CLIENT_EXECUTIVE humans (exec-1 + exec-2)
    const acceptPayload = {
      executiveApprovalRecorded: true,
      reviewDateRecorded: "2027-02-01T00:00:00.000Z",
      rationaleRecorded: "Interim tanker water supply accepted pending TAQA network tie-in",
    };
    const b07 = await service.computeDualControlBinding({
      aggregateId: riskId,
      transitionId: "S7-T07",
      scope,
      payload: acceptPayload,
    });

    // Same executive twice -> APPROVAL_INVALID
    const sameExec = await service.transitionRisk("exec-1", {
      aggregateId: riskId,
      transitionId: "S7-T07",
      scope,
      payload: acceptPayload,
      approvals: [
        {
          actorId: "exec-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
          approvedAssignmentVersion: 1,
          commandHash: b07.commandHash,
          scopeHash: b07.scopeHash,
          dependencyEpoch: b07.dependencyEpoch,
          verified: true,
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
        {
          actorId: "exec-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
          approvedAssignmentVersion: 1,
          commandHash: b07.commandHash,
          scopeHash: b07.scopeHash,
          dependencyEpoch: b07.dependencyEpoch,
          verified: true,
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(sameExec).toMatchObject({ ok: false, error: "APPROVAL_INVALID" });

    // Two distinct executives (exec-1 + exec-2) -> ACCEPTED
    const b07Retry = await service.computeDualControlBinding({
      aggregateId: riskId,
      transitionId: "S7-T07",
      scope,
      payload: acceptPayload,
    });
    expect(
      await service.transitionRisk("exec-1", {
        aggregateId: riskId,
        transitionId: "S7-T07",
        scope,
        payload: acceptPayload,
        approvals: [
          {
            actorId: "exec-1",
            actorKind: "HUMAN",
            assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
            approvedAssignmentVersion: 1,
            commandHash: b07Retry.commandHash,
            scopeHash: b07Retry.scopeHash,
            dependencyEpoch: b07Retry.dependencyEpoch,
            verified: true,
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          {
            actorId: "exec-2",
            actorKind: "HUMAN",
            assignment: makeAssignment("exec-2", "CLIENT_EXECUTIVE"),
            approvedAssignmentVersion: 1,
            commandHash: b07Retry.commandHash,
            scopeHash: b07Retry.scopeHash,
            dependencyEpoch: b07Retry.dependencyEpoch,
            verified: true,
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ ok: true, state: "ACCEPTED" });

    // S7-T08: ACCEPTED -> OPEN -> S7-T01 -> ASSESSED -> S7-T02 -> MITIGATING -> S7-T03 -> ESCALATED -> S7-T04 -> MITIGATING -> S7-T05 -> RESOLVED -> S7-T06 -> CLOSED
    expect(
      await service.transitionRisk("sm", {
        aggregateId: riskId,
        transitionId: "S7-T08",
        scope,
        payload: { reviewDateReachedOrConditionsChanged: true, reasonRecorded: "Review date reached" },
      }),
    ).toMatchObject({ ok: true, state: "OPEN" });

    await service.transitionRisk("sm", {
      aggregateId: riskId,
      transitionId: "S7-T01",
      scope,
      payload: {
        severityAssigned: "HIGH",
        ownerAssigned: "sm-1",
        decisionDueDateSet: "2026-12-01T00:00:00.000Z",
      },
    });
    expect(
      await service.transitionRisk("sm", {
        aggregateId: riskId,
        transitionId: "S7-T02",
        scope,
        payload: { mitigationPlanRecorded: "Dedicated coordination taskforce with TAQA" },
      }),
    ).toMatchObject({ ok: true, state: "MITIGATING" });

    expect(
      await service.transitionRisk("sm", {
        aggregateId: riskId,
        transitionId: "S7-T03",
        scope,
        payload: { escalationLevelAssigned: "EXECUTIVE", escalationReasonRecorded: "SLA threshold exceeded" },
      }),
    ).toMatchObject({ ok: true, state: "ESCALATED" });

    expect(
      await service.transitionRisk("exec-1", {
        aggregateId: riskId,
        transitionId: "S7-T04",
        scope,
        payload: { escalationResolved: true, reasonRecorded: "TAQA joint review date confirmed" },
      }),
    ).toMatchObject({ ok: true, state: "MITIGATING" });

    expect(
      await service.transitionRisk("sm", {
        aggregateId: riskId,
        transitionId: "S7-T05",
        scope,
        payload: { resolutionEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "RESOLVED" });

    expect(
      await service.transitionRisk("sm", {
        aggregateId: riskId,
        transitionId: "S7-T06",
        scope,
        payload: { closureApproved: true },
      }),
    ).toMatchObject({ ok: true, state: "CLOSED" });
  });
});
