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
  INFRA_STEPS_DAG,
  computeCriticalPath,
  createInfrastructureService,
  type InfrastructureServicePort,
} from "../../../src/domain/infrastructure";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("infra-step tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-inf:1"],
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

describe("DOMAIN-004 SM_3_infra_step 10-step DAG, critical path & 8 transitions (S3-T01..S3-T08)", () => {
  const services: InfrastructureServicePort[] = [];
  let service: InfrastructureServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `inf_step_${randomUUID().replace(/-/g, "")}`;
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
        "dl",
        {
          actorId: "dl-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("dl-1", "DISCIPLINE_LEAD")],
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
        "admin",
        {
          actorId: "admin-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("admin-1", "SYSTEM_ADMIN")],
        },
      ],
    ]);

    const authorization = createAuthorizationService({
      verifySession: async (cred) => (typeof cred === "string" ? (sessions.get(cred) ?? null) : null),
      rules: transitions,
    });

    service = createInfrastructureService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("loads the 10-step infrastructure DAG (INF-01..INF-10), computes longest remaining lead-time critical path through INF-06, and enforces S3-T01..S3-T08", async () => {
    expect(INFRA_STEPS_DAG).toHaveLength(10);
    const cp = computeCriticalPath(new Set());
    expect(cp.path).toEqual(["INF-01", "INF-06", "INF-08", "INF-09", "INF-10"]);
    expect(cp.maxWeeks).toBe(4 + 16 + 6 + 8 + 6);

    const stepId = randomUUID();
    await service.createInfraStep("aor", {
      aggregateId: stepId,
      projectId: PROJECT_ID,
      stepCode: "INF-06",
      scope,
    });

    // S3-T01: BLOCKED -> READY (SYSTEM)
    expect(
      await service.transitionInfrastructure("sys", {
        aggregateId: stepId,
        transitionId: "S3-T01",
        scope,
        payload: { allDependenciesApprovedOrWaived: true },
      }),
    ).toMatchObject({ ok: true, state: "READY" });

    // S3-T02: READY -> IN_PROGRESS
    expect(
      await service.transitionInfrastructure("dl", {
        aggregateId: stepId,
        transitionId: "S3-T02",
        scope,
        payload: { ownerAssigned: true, requiredInputsListed: true },
      }),
    ).toMatchObject({ ok: true, state: "IN_PROGRESS" });

    // S3-T03: IN_PROGRESS -> SUBMITTED
    expect(
      await service.transitionInfrastructure("aor", {
        aggregateId: stepId,
        transitionId: "S3-T03",
        scope,
        payload: { stepPackageComplete: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });

    // S3-T04: SUBMITTED -> UNDER_REVIEW
    expect(
      await service.transitionInfrastructure("aor", {
        aggregateId: stepId,
        transitionId: "S3-T04",
        scope,
        payload: { authorityReceiptCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "UNDER_REVIEW" });

    // S3-T06: UNDER_REVIEW -> REJECTED
    expect(
      await service.transitionInfrastructure("aor", {
        aggregateId: stepId,
        transitionId: "S3-T06",
        scope,
        payload: { rejectionReasonRecorded: "Substation load calculation sheet missing" },
      }),
    ).toMatchObject({ ok: true, state: "REJECTED" });

    // S3-T07: REJECTED -> IN_PROGRESS -> S3-T03 -> S3-T04 -> S3-T05 APPROVED
    expect(
      await service.transitionInfrastructure("dl", {
        aggregateId: stepId,
        transitionId: "S3-T07",
        scope,
        payload: { correctionsRecorded: true },
      }),
    ).toMatchObject({ ok: true, state: "IN_PROGRESS" });
    await service.transitionInfrastructure("aor", {
      aggregateId: stepId,
      transitionId: "S3-T03",
      scope,
      payload: { stepPackageComplete: true },
    });
    await service.transitionInfrastructure("aor", {
      aggregateId: stepId,
      transitionId: "S3-T04",
      scope,
      payload: { authorityReceiptCaptured: true },
    });
    expect(
      await service.transitionInfrastructure("sm", {
        aggregateId: stepId,
        transitionId: "S3-T05",
        scope,
        payload: { validEvidenceCaptured: true, outputStateRecorded: "POWER_ALLOCATION_APPROVED" },
      }),
    ).toMatchObject({ ok: true, state: "APPROVED" });

    // S3-T08: WAIVE on second step with dual control (CLIENT_EXECUTIVE + SYSTEM_ADMIN)
    const step2Id = randomUUID();
    await service.createInfraStep("aor", {
      aggregateId: step2Id,
      projectId: PROJECT_ID,
      stepCode: "INF-05",
      scope,
    });
    const waivePayload = {
      executiveApprovalRecorded: true,
      authorityWrittenConfirmation: true,
      reviewDateRecorded: "2027-06-01T00:00:00.000Z",
    };
    const b08 = await service.computeDualControlBinding({
      aggregateId: step2Id,
      transitionId: "S3-T08",
      scope,
      payload: waivePayload,
    });
    expect(
      await service.transitionInfrastructure("exec", {
        aggregateId: step2Id,
        transitionId: "S3-T08",
        scope,
        payload: waivePayload,
        approvals: [
          {
            actorId: "exec-1",
            actorKind: "HUMAN",
            assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
            approvedAssignmentVersion: 1,
            commandHash: b08.commandHash,
            scopeHash: b08.scopeHash,
            dependencyEpoch: b08.dependencyEpoch,
            verified: true,
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          {
            actorId: "admin-1",
            actorKind: "HUMAN",
            assignment: makeAssignment("admin-1", "SYSTEM_ADMIN"),
            approvedAssignmentVersion: 1,
            commandHash: b08.commandHash,
            scopeHash: b08.scopeHash,
            dependencyEpoch: b08.dependencyEpoch,
            verified: true,
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ ok: true, state: "WAIVED" });
  });
});
