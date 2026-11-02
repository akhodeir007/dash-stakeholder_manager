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
import { createMasterplanService, type MasterplanServicePort } from "../../../src/domain/masterplan";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("baseline-change integration tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "10000000-0000-4000-8000-000000000003";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-bc:1"],
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

describe("DOMAIN-001 SM_11_baseline_change lifecycle & dual-control APPLY (S11-T01..S11-T07)", () => {
  const services: MasterplanServicePort[] = [];
  let service: MasterplanServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `mp_bc_${randomUUID().replace(/-/g, "")}`;
    const currentTime = new Date("2026-11-02T12:00:00.000Z");

    const sessions = new Map<string, VerifiedSessionRecord>([
      [
        "aor",
        {
          actorId: "aor-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("aor-1", "AOR_LEAD")],
        },
      ],
      [
        "sm",
        {
          actorId: "sm-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("sm-1", "STAKEHOLDER_MANAGER")],
        },
      ],
      [
        "exec",
        {
          actorId: "exec-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("exec-1", "CLIENT_EXECUTIVE")],
        },
      ],
      [
        "admin",
        {
          actorId: "admin-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("admin-1", "SYSTEM_ADMIN")],
        },
      ],
    ]);

    const authorization = createAuthorizationService({
      verifySession: async (cred) => (typeof cred === "string" ? (sessions.get(cred) ?? null) : null),
      rules: transitions,
    });

    service = createMasterplanService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("executes all 7 SM_11_baseline_change transitions (S11-T01..S11-T07) and bumps dependency epoch on S11-T06 APPLY", async () => {
    const bcId = randomUUID();
    await service.createBaselineChangeRequest("sm", {
      aggregateId: bcId,
      projectId: PROJECT_ID,
      scope,
    });

    // S11-T01: DRAFT -> IMPACT_ASSESSMENT
    const t01 = await service.transitionBaselineChange("aor", {
      aggregateId: bcId,
      transitionId: "S11-T01",
      scope,
      payload: { changeDescriptionRecorded: "Substation plot boundary shift", affectedParcelsListed: ["plot-101"] },
    });
    expect(t01).toMatchObject({ ok: true, state: "IMPACT_ASSESSMENT" });

    // S11-T02: IMPACT_ASSESSMENT -> PENDING_EXEC_APPROVAL
    const t02 = await service.transitionBaselineChange("sm", {
      aggregateId: bcId,
      transitionId: "S11-T02",
      scope,
      payload: { impactAssessmentComplete: true, affectedCasesListed: ["case-1"] },
    });
    expect(t02).toMatchObject({ ok: true, state: "PENDING_EXEC_APPROVAL" });

    // S11-T04: PENDING_EXEC_APPROVAL -> REJECTED
    const t04 = await service.transitionBaselineChange("exec", {
      aggregateId: bcId,
      transitionId: "S11-T04",
      scope,
      payload: { rejectionReasonRecorded: "Quantify TAQA schedule impact first" },
    });
    expect(t04).toMatchObject({ ok: true, state: "REJECTED" });

    // S11-T05: REJECTED -> DRAFT
    const t05 = await service.transitionBaselineChange("sm", {
      aggregateId: bcId,
      transitionId: "S11-T05",
      scope,
      payload: { revisionRecorded: "Added TAQA impact schedule" },
    });
    expect(t05).toMatchObject({ ok: true, state: "DRAFT" });

    // Advance DRAFT -> IMPACT_ASSESSMENT -> PENDING_EXEC_APPROVAL -> APPROVED (S11-T03)
    await service.transitionBaselineChange("sm", {
      aggregateId: bcId,
      transitionId: "S11-T01",
      scope,
      payload: { changeDescriptionRecorded: "Substation plot shift v2", affectedParcelsListed: ["plot-101"] },
    });
    await service.transitionBaselineChange("sm", {
      aggregateId: bcId,
      transitionId: "S11-T02",
      scope,
      payload: { impactAssessmentComplete: true, affectedCasesListed: ["case-1"] },
    });
    const t03 = await service.transitionBaselineChange("exec", {
      aggregateId: bcId,
      transitionId: "S11-T03",
      scope,
      payload: { executiveApprovalRecorded: true },
    });
    expect(t03).toMatchObject({ ok: true, state: "APPROVED" });

    // S11-T06: APPROVED -> APPLIED with dual control (SYSTEM_ADMIN + CLIENT_EXECUTIVE)
    const epochBefore = await service.getProjectEpoch(PROJECT_ID);
    const applyPayload = { impactActionsStarted: true, newBaselineVersionCreated: true };
    const b06 = await service.computeDualControlBinding({
      aggregateId: bcId,
      transitionId: "S11-T06",
      commandName: "APPLY",
      scope,
      payload: applyPayload,
    });
    const t06 = await service.transitionBaselineChange("exec", {
      aggregateId: bcId,
      transitionId: "S11-T06",
      scope,
      payload: applyPayload,
      approvals: [
        {
          actorId: "admin-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("admin-1", "SYSTEM_ADMIN"),
          approvedAssignmentVersion: 1,
          commandHash: b06.commandHash,
          scopeHash: b06.scopeHash,
          dependencyEpoch: b06.dependencyEpoch,
          verified: true,
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
        {
          actorId: "exec-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
          approvedAssignmentVersion: 1,
          commandHash: b06.commandHash,
          scopeHash: b06.scopeHash,
          dependencyEpoch: b06.dependencyEpoch,
          verified: true,
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      ],
    });
    expect(t06).toMatchObject({ ok: true, state: "APPLIED" });
    expect(await service.getProjectEpoch(PROJECT_ID)).toBe(epochBefore + 1);

    // S11-T07: DRAFT -> WITHDRAWN on second request
    const bcId2 = randomUUID();
    await service.createBaselineChangeRequest("sm", {
      aggregateId: bcId2,
      projectId: PROJECT_ID,
      scope,
    });
    const t07 = await service.transitionBaselineChange("sm", {
      aggregateId: bcId2,
      transitionId: "S11-T07",
      scope,
      payload: { reasonRecorded: "Change superseded by consolidated revision" },
    });
    expect(t07).toMatchObject({ ok: true, state: "WITHDRAWN" });
  });
});
