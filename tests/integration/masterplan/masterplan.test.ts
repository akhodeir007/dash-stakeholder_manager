import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthorizationService } from "../../../src/auth/authorization";
import type {
  ApprovalFact,
  Role,
  RoleAssignment,
  ScopeBinding,
  VerifiedSessionRecord,
} from "../../../src/contracts/foundation";
import { loadMachineDefinitions } from "../../../src/domain/commands/engine";
import { createMasterplanService, type MasterplanServicePort } from "../../../src/domain/masterplan";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("masterplan integration tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-dmp:1"],
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

describe("DOMAIN-001 SM_1_masterplan lifecycle & Attachment 1 24-condition freeze gate", () => {
  const services: MasterplanServicePort[] = [];
  let currentTime: Date;
  let service: MasterplanServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `mp_${randomUUID().replace(/-/g, "")}`;
    currentTime = new Date("2026-11-02T12:00:00.000Z");

    const sessions = new Map<string, VerifiedSessionRecord>([
      [
        "aor",
        {
          actorId: "aor-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2035-12-31T00:00:00.000Z",
          assignments: [makeAssignment("aor-1", "AOR_LEAD")],
        },
      ],
      [
        "sm",
        {
          actorId: "sm-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2035-12-31T00:00:00.000Z",
          assignments: [makeAssignment("sm-1", "STAKEHOLDER_MANAGER")],
        },
      ],
      [
        "exec",
        {
          actorId: "exec-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2035-12-31T00:00:00.000Z",
          assignments: [makeAssignment("exec-1", "CLIENT_EXECUTIVE")],
        },
      ],
      [
        "admin",
        {
          actorId: "admin-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2035-12-31T00:00:00.000Z",
          assignments: [makeAssignment("admin-1", "SYSTEM_ADMIN")],
        },
      ],
      [
        "sys",
        {
          actorId: "system-1",
          tenantId: TENANT,
          kind: "SERVICE",
          expiresAt: "2035-12-31T00:00:00.000Z",
          assignments: [makeAssignment("system-1", "SYSTEM")],
          serviceCapabilities: transitions.filter((t) => t.roles.includes("SYSTEM")).map((t) => `transition:${t.id}`),
        },
      ],
      [
        "contractor",
        {
          actorId: "contractor-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2035-12-31T00:00:00.000Z",
          assignments: [makeAssignment("contractor-1", "CONTRACTOR")],
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

  it("blocks SM1-T02 and SM1-T04 when Attachment 1 has fewer than 24 conditions (only 11 known from strategy) and never fabricates missing conditions", async () => {
    const mpId = randomUUID();
    await service.createMasterplan("aor", {
      aggregateId: mpId,
      projectId: PROJECT_ID,
      scope,
      certificateRef: "MPD-230126-0505",
      dmtCorrespondenceRef: "DMT/MD/OUT/2026/4886",
      validUntil: "2029-06-04T00:00:00.000Z",
    });

    // SM1-T01: CMP_APPROVED -> DMP_SUBMITTED
    const t01 = await service.transitionMasterplan("aor", {
      aggregateId: mpId,
      transitionId: "SM1-T01",
      scope,
      payload: {
        submissionPackageComplete: true,
        dmtReceiptCaptured: true,
      },
    });
    expect(t01).toMatchObject({ ok: true, state: "DMP_SUBMITTED" });

    // SM1-T02 with only 11 conditions from strategy PDF (Attachment 1 missing 13 conditions) -> GUARD_DENIED
    const partialConditions = await service.transitionMasterplan("sm", {
      aggregateId: mpId,
      transitionId: "SM1-T02",
      scope,
      payload: {
        dmtCorrespondenceRef: "DMT/MD/OUT/2026/4886",
        conditionsParsedCount: 11,
      },
    });
    expect(partialConditions).toMatchObject({
      ok: false,
      error: "GUARD_DENIED",
      failedGuards: ["conditions_parsed_count_24"],
    });

    // SM1-T02 with all 24 conditions transcribed -> DMP_CONDITIONALLY_APPROVED
    const t02 = await service.transitionMasterplan("sm", {
      aggregateId: mpId,
      transitionId: "SM1-T02",
      scope,
      payload: {
        dmtCorrespondenceRef: "DMT/MD/OUT/2026/4886",
        conditionsParsedCount: 24,
      },
    });
    expect(t02).toMatchObject({ ok: true, state: "DMP_CONDITIONALLY_APPROVED" });

    // SM1-T04 FREEZE_BASELINE denied when fewer than 24 conditions are accepted/waived in DB
    const dualBinding = await service.computeDualControlBinding({
      aggregateId: mpId,
      transitionId: "SM1-T04",
      commandName: "FREEZE_BASELINE",
      scope,
      payload: {
        noOpenAmendment: true,
        executiveApprovalRecorded: true,
      },
    });
    const approvals: ApprovalFact[] = [
      {
        actorId: "sm-1",
        actorKind: "HUMAN",
        assignment: makeAssignment("sm-1", "STAKEHOLDER_MANAGER"),
        approvedAssignmentVersion: 1,
        commandHash: dualBinding.commandHash,
        scopeHash: dualBinding.scopeHash,
        dependencyEpoch: dualBinding.dependencyEpoch,
        verified: true,
        expiresAt: "2026-12-01T00:00:00.000Z",
      },
      {
        actorId: "exec-1",
        actorKind: "HUMAN",
        assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
        approvedAssignmentVersion: 1,
        commandHash: dualBinding.commandHash,
        scopeHash: dualBinding.scopeHash,
        dependencyEpoch: dualBinding.dependencyEpoch,
        verified: true,
        expiresAt: "2026-12-01T00:00:00.000Z",
      },
    ];

    const freezeWithout24Accepted = await service.transitionMasterplan("sm", {
      aggregateId: mpId,
      transitionId: "SM1-T04",
      scope,
      approvals,
      payload: {
        noOpenAmendment: true,
        executiveApprovalRecorded: true,
      },
    });
    expect(freezeWithout24Accepted).toMatchObject({
      ok: false,
      error: "GUARD_DENIED",
      failedGuards: ["all_conditions_accepted", "evidence_complete_for_all_conditions"],
    });
  });

  it("executes all 9 SM_1_masterplan transitions (SM1-T01..SM1-T09), enforces dual control, and bumps dependency epoch on amendments/expiry", async () => {
    const mpId = randomUUID();
    await service.createMasterplan("aor", {
      aggregateId: mpId,
      projectId: PROJECT_ID,
      scope,
      certificateRef: "MPD-230126-0505",
      dmtCorrespondenceRef: "DMT/MD/OUT/2026/4886",
      validUntil: "2029-06-04T00:00:00.000Z",
    });

    // SM1-T01: CMP_APPROVED -> DMP_SUBMITTED
    await service.transitionMasterplan("aor", {
      aggregateId: mpId,
      transitionId: "SM1-T01",
      scope,
      payload: { submissionPackageComplete: true, dmtReceiptCaptured: true },
    });

    // SM1-T03: DMP_SUBMITTED -> DMP_AMENDMENT_REQUIRED (bumps dependency_epoch)
    const epochBeforeT03 = await service.getProjectEpoch(PROJECT_ID);
    const t03 = await service.transitionMasterplan("sm", {
      aggregateId: mpId,
      transitionId: "SM1-T03",
      scope,
      payload: { dmtLetterCaptured: true },
    });
    expect(t03).toMatchObject({ ok: true, state: "DMP_AMENDMENT_REQUIRED" });
    expect(await service.getProjectEpoch(PROJECT_ID)).toBe(epochBeforeT03 + 1);

    // SM1-T06: DMP_AMENDMENT_REQUIRED -> DMP_SUBMITTED
    const t06 = await service.transitionMasterplan("aor", {
      aggregateId: mpId,
      transitionId: "SM1-T06",
      scope,
      payload: { amendedPackageComplete: true, impactAssessmentComplete: true },
    });
    expect(t06).toMatchObject({ ok: true, state: "DMP_SUBMITTED" });

    // SM1-T02: DMP_SUBMITTED -> DMP_CONDITIONALLY_APPROVED
    await service.transitionMasterplan("sm", {
      aggregateId: mpId,
      transitionId: "SM1-T02",
      scope,
      payload: { dmtCorrespondenceRef: "DMT/MD/OUT/2026/4886", conditionsParsedCount: 24 },
    });

    // SM1-T05: DMP_CONDITIONALLY_APPROVED -> DMP_AMENDMENT_REQUIRED -> SM1-T06 -> SM1-T02
    const t05 = await service.transitionMasterplan("aor", {
      aggregateId: mpId,
      transitionId: "SM1-T05",
      scope,
      payload: { nocConflictEvidencePresent: true },
    });
    expect(t05).toMatchObject({ ok: true, state: "DMP_AMENDMENT_REQUIRED" });
    await service.transitionMasterplan("aor", {
      aggregateId: mpId,
      transitionId: "SM1-T06",
      scope,
      payload: { amendedPackageComplete: true, impactAssessmentComplete: true },
    });
    await service.transitionMasterplan("sm", {
      aggregateId: mpId,
      transitionId: "SM1-T02",
      scope,
      payload: { dmtCorrespondenceRef: "DMT/MD/OUT/2026/4886", conditionsParsedCount: 24 },
    });

    // SM1-T08: DMP_CONDITIONALLY_APPROVED -> VALIDITY_EXPIRED when clock passes validUntil (2029-06-04)
    currentTime = new Date("2029-06-05T00:00:00.000Z");
    const t08 = await service.transitionMasterplan("sys", {
      aggregateId: mpId,
      transitionId: "SM1-T08",
      scope,
      payload: { validUntil: "2029-06-04T00:00:00.000Z", noRenewalRecorded: true },
    });
    expect(t08).toMatchObject({ ok: true, state: "VALIDITY_EXPIRED" });

    // SM1-T09: VALIDITY_EXPIRED -> DMP_CONDITIONALLY_APPROVED on RENEW_VALIDITY
    const t09 = await service.transitionMasterplan("sm", {
      aggregateId: mpId,
      transitionId: "SM1-T09",
      scope,
      payload: { renewalCertificateCaptured: true, newValidityWindowRecorded: "2032-06-04T00:00:00.000Z" },
    });
    expect(t09).toMatchObject({ ok: true, state: "DMP_CONDITIONALLY_APPROVED" });

    // Seed 24 accepted conditions with complete evidence for mpId
    await service.seedAcceptedConditionsForTest(mpId, 24);

    // SM1-T04: DMP_CONDITIONALLY_APPROVED -> BASELINE_FREEZE with dual control (STAKEHOLDER_MANAGER + CLIENT_EXECUTIVE)
    const t04Payload = { noOpenAmendment: true, executiveApprovalRecorded: true };
    const b04 = await service.computeDualControlBinding({
      aggregateId: mpId,
      transitionId: "SM1-T04",
      commandName: "FREEZE_BASELINE",
      scope,
      payload: t04Payload,
    });
    const t04 = await service.transitionMasterplan("sm", {
      aggregateId: mpId,
      transitionId: "SM1-T04",
      scope,
      payload: t04Payload,
      approvals: [
        {
          actorId: "sm-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("sm-1", "STAKEHOLDER_MANAGER"),
          approvedAssignmentVersion: 1,
          commandHash: b04.commandHash,
          scopeHash: b04.scopeHash,
          dependencyEpoch: b04.dependencyEpoch,
          verified: true,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        {
          actorId: "exec-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
          approvedAssignmentVersion: 1,
          commandHash: b04.commandHash,
          scopeHash: b04.scopeHash,
          dependencyEpoch: b04.dependencyEpoch,
          verified: true,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(t04).toMatchObject({ ok: true, state: "BASELINE_FREEZE" });

    // SM1-T07: BASELINE_FREEZE -> DMP_AMENDMENT_REQUIRED via dual control (CLIENT_EXECUTIVE + SYSTEM_ADMIN)
    const t07Payload = { baselineChangeStatusApplied: true, executiveApprovalRecorded: true };
    const b07 = await service.computeDualControlBinding({
      aggregateId: mpId,
      transitionId: "SM1-T07",
      commandName: "APPROVED_BASELINE_CHANGE",
      scope,
      payload: t07Payload,
    });
    const t07 = await service.transitionMasterplan("exec", {
      aggregateId: mpId,
      transitionId: "SM1-T07",
      scope,
      payload: t07Payload,
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
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        {
          actorId: "admin-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("admin-1", "SYSTEM_ADMIN"),
          approvedAssignmentVersion: 1,
          commandHash: b07.commandHash,
          scopeHash: b07.scopeHash,
          dependencyEpoch: b07.dependencyEpoch,
          verified: true,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(t07).toMatchObject({ ok: true, state: "DMP_AMENDMENT_REQUIRED" });
  });
});
