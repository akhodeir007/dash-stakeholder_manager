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
  WORKSTREAM_CATALOGUE,
  createPackagesService,
  type PackagesServicePort,
} from "../../../src/domain/packages";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("workstream tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PACKAGE_GATE",
  projectId: PROJECT_ID,
  packageId: "40000000-0000-4000-8000-000000000999",
  plotIds: ["plot-101"],
  scopeVersion: 1,
  designRevision: "rev-A",
  requirementSnapshotId: "req-1",
  evidenceVersionIds: ["ev-ws:1"],
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

describe("DOMAIN-003 SM_2D_workstream 16-item catalogue, EAD current requirement, ENOC linkage & 9 transitions (S2D-T01..S2D-T09)", () => {
  const services: PackagesServicePort[] = [];
  let service: PackagesServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `pkg_ws_${randomUUID().replace(/-/g, "")}`;
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

  it("verifies 16-item workstream catalogue with only EAD active in Step 03A current requirements, ENOC linkage to TAQA, and S2D-T01..S2D-T09", async () => {
    expect(WORKSTREAM_CATALOGUE.catalogue).toHaveLength(16);
    expect(WORKSTREAM_CATALOGUE.step03aCurrentRequirements).toEqual(["EAD"]);
    expect(WORKSTREAM_CATALOGUE.step03bSeparateSubmission).toBe(false);
    const enoc = WORKSTREAM_CATALOGUE.catalogue.find((w) => w.id === "ENOC_INFRASTRUCTURE")!;
    expect(enoc.links).toEqual(["TAQA_WATER", "TAQA_ELECTRICITY"]);

    const wsId = randomUUID();
    await service.createWorkstream("aor", {
      aggregateId: wsId,
      projectId: PROJECT_ID,
      workstreamCode: "GIS_DCR",
      scope,
    });

    // S2D-T07: NOT_AVAILABLE -> NOT_REQUIRED_YET -> S2D-T08 -> NOT_AVAILABLE
    expect(
      await service.transitionPackageAggregate("sm", {
        aggregateId: wsId,
        transitionId: "S2D-T07",
        scope,
        payload: { itemIsConditional: true },
      }),
    ).toMatchObject({ ok: true, state: "NOT_REQUIRED_YET" });
    expect(
      await service.transitionPackageAggregate("sys", {
        aggregateId: wsId,
        transitionId: "S2D-T08",
        scope,
        payload: { triggerConditionMet: true },
      }),
    ).toMatchObject({ ok: true, state: "NOT_AVAILABLE" });

    // S2D-T01: NOT_AVAILABLE -> IN_PROGRESS
    expect(
      await service.transitionPackageAggregate("dl", {
        aggregateId: wsId,
        transitionId: "S2D-T01",
        scope,
        payload: { ownerAssigned: true },
      }),
    ).toMatchObject({ ok: true, state: "IN_PROGRESS" });

    // S2D-T05: IN_PROGRESS -> REJECTED -> S2D-T06 -> IN_PROGRESS
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: wsId,
        transitionId: "S2D-T05",
        scope,
        payload: { rejectionReasonRecorded: "Coordinate datum mismatch" },
      }),
    ).toMatchObject({ ok: true, state: "REJECTED" });
    expect(
      await service.transitionPackageAggregate("dl", {
        aggregateId: wsId,
        transitionId: "S2D-T06",
        scope,
        payload: { correctionsRecorded: true },
      }),
    ).toMatchObject({ ok: true, state: "IN_PROGRESS" });

    // S2D-T02: IN_PROGRESS -> SUBMITTED -> S2D-T03 -> OBTAINED -> S2D-T04 -> ALIGNED
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: wsId,
        transitionId: "S2D-T02",
        scope,
        payload: { workstreamPackageComplete: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });
    expect(
      await service.transitionPackageAggregate("sm", {
        aggregateId: wsId,
        transitionId: "S2D-T03",
        scope,
        payload: { validEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "OBTAINED" });
    expect(
      await service.transitionPackageAggregate("aor", {
        aggregateId: wsId,
        transitionId: "S2D-T04",
        scope,
        payload: { alignmentRequiredForItem: true, gisAlignmentValidated: true },
      }),
    ).toMatchObject({ ok: true, state: "ALIGNED" });

    // Second workstream: S2D-T09 MARK_NOT_REQUIRED with dual control (STAKEHOLDER_MANAGER + CLIENT_EXECUTIVE)
    const condWs = randomUUID();
    await service.createWorkstream("aor", {
      aggregateId: condWs,
      projectId: PROJECT_ID,
      workstreamCode: "ADCD_FIRE_LIFE_SAFETY",
      scope,
    });
    const wPayload = {
      justificationRecorded: "Standard villa typology exempted from standalone FLS pre-submission",
      validatorApprovalRecorded: true,
    };
    const b09 = await service.computeDualControlBinding({
      aggregateId: condWs,
      transitionId: "S2D-T09",
      scope,
      payload: wPayload,
    });
    expect(
      await service.transitionPackageAggregate("sm", {
        aggregateId: condWs,
        transitionId: "S2D-T09",
        scope,
        payload: wPayload,
        approvals: [
          {
            actorId: "sm-1",
            actorKind: "HUMAN",
            assignment: makeAssignment("sm-1", "STAKEHOLDER_MANAGER"),
            approvedAssignmentVersion: 1,
            commandHash: b09.commandHash,
            scopeHash: b09.scopeHash,
            dependencyEpoch: b09.dependencyEpoch,
            verified: true,
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          {
            actorId: "exec-1",
            actorKind: "HUMAN",
            assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
            approvedAssignmentVersion: 1,
            commandHash: b09.commandHash,
            scopeHash: b09.scopeHash,
            dependencyEpoch: b09.dependencyEpoch,
            verified: true,
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ ok: true, state: "NOT_REQUIRED" });
  });
});
