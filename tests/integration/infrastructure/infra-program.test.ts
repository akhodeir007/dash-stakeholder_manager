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
  createInfrastructureService,
  type InfrastructureServicePort,
} from "../../../src/domain/infrastructure";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("infra-program tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "30000000-0000-4000-8000-000000000002";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-inf-prog:1"],
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

describe("DOMAIN-004 SM_3_infra_program lifecycle (S3P-T01..S3P-T04)", () => {
  const services: InfrastructureServicePort[] = [];
  let service: InfrastructureServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `inf_prog_${randomUUID().replace(/-/g, "")}`;
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

  it("executes all 4 SM_3_infra_program transitions (S3P-T01..S3P-T04)", async () => {
    const progId = randomUUID();
    await service.createInfraProgram("sm", {
      aggregateId: progId,
      projectId: PROJECT_ID,
      scope,
    });

    // S3P-T01: NOT_STARTED -> IN_PROGRESS
    expect(
      await service.transitionInfrastructure("sys", {
        aggregateId: progId,
        transitionId: "S3P-T01",
        scope,
        payload: { atLeastOneStepReady: true },
      }),
    ).toMatchObject({ ok: true, state: "IN_PROGRESS" });

    // S3P-T02: IN_PROGRESS -> BLOCKED
    expect(
      await service.transitionInfrastructure("sys", {
        aggregateId: progId,
        transitionId: "S3P-T02",
        scope,
        payload: { criticalStepBlockedOrRejected: true },
      }),
    ).toMatchObject({ ok: true, state: "BLOCKED" });

    // S3P-T03: BLOCKED -> IN_PROGRESS
    expect(
      await service.transitionInfrastructure("sys", {
        aggregateId: progId,
        transitionId: "S3P-T03",
        scope,
        payload: { blockingStepResolved: true },
      }),
    ).toMatchObject({ ok: true, state: "IN_PROGRESS" });

    // S3P-T04: IN_PROGRESS -> INFRASTRUCTURE_PERMIT_CLOSED
    expect(
      await service.transitionInfrastructure("sm", {
        aggregateId: progId,
        transitionId: "S3P-T04",
        scope,
        payload: { allStepsApprovedOrWaived: true, finalSignoffEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "INFRASTRUCTURE_PERMIT_CLOSED" });
  });
});
