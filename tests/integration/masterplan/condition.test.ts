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
  throw new Error("condition integration tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "10000000-0000-4000-8000-000000000002";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-cond:1"],
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

describe("DOMAIN-001 SM_1_condition lifecycle & waiver dual control (SMC-T01..SMC-T07)", () => {
  const services: MasterplanServicePort[] = [];
  let service: MasterplanServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `mp_cond_${randomUUID().replace(/-/g, "")}`;
    const currentTime = new Date("2026-11-02T12:00:00.000Z");

    const sessions = new Map<string, VerifiedSessionRecord>([
      [
        "dl",
        {
          actorId: "dl-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("dl-1", "DISCIPLINE_LEAD")],
        },
      ],
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

  it("executes all 7 SM_1_condition transitions (SMC-T01..SMC-T07) and requires authority confirmation, review date, and dual control on waivers", async () => {
    const mpId = randomUUID();
    await service.createMasterplan("aor", {
      aggregateId: mpId,
      projectId: PROJECT_ID,
      scope,
      certificateRef: "MPD-230126-0505",
      dmtCorrespondenceRef: "DMT/MD/OUT/2026/4886",
      validUntil: "2029-06-04T00:00:00.000Z",
    });

    const condId = randomUUID();
    await service.createCondition("aor", {
      aggregateId: condId,
      masterplanId: mpId,
      projectId: PROJECT_ID,
      conditionNumber: 1,
      scope,
    });

    // SMC-T01: OPEN -> EVIDENCE_SUBMITTED
    const t01 = await service.transitionCondition("dl", {
      aggregateId: condId,
      transitionId: "SMC-T01",
      scope,
      payload: { evidenceUploaded: true, evidenceTypeMatchesCondition: true },
    });
    expect(t01).toMatchObject({ ok: true, state: "EVIDENCE_SUBMITTED" });

    // SMC-T02: EVIDENCE_SUBMITTED -> UNDER_REVIEW
    const t02 = await service.transitionCondition("sm", {
      aggregateId: condId,
      transitionId: "SMC-T02",
      scope,
      payload: { reviewerAssigned: true },
    });
    expect(t02).toMatchObject({ ok: true, state: "UNDER_REVIEW" });

    // SMC-T04: UNDER_REVIEW -> REJECTED
    const t04 = await service.transitionCondition("sm", {
      aggregateId: condId,
      transitionId: "SMC-T04",
      scope,
      payload: { rejectionReasonRecorded: "Drawing scale mismatch" },
    });
    expect(t04).toMatchObject({ ok: true, state: "REJECTED" });

    // SMC-T05: REJECTED -> EVIDENCE_SUBMITTED
    const t05 = await service.transitionCondition("aor", {
      aggregateId: condId,
      transitionId: "SMC-T05",
      scope,
      payload: { newEvidenceUploaded: true },
    });
    expect(t05).toMatchObject({ ok: true, state: "EVIDENCE_SUBMITTED" });

    // SMC-T06: WAIVE without reviewDateRecorded -> GUARD_DENIED
    const waivePayloadBad = {
      authorityWrittenConfirmation: true,
      executiveApprovalRecorded: true,
      reviewDateRecorded: "",
    };
    const bBad = await service.computeDualControlBinding({
      aggregateId: condId,
      transitionId: "SMC-T06",
      commandName: "WAIVE",
      scope,
      payload: waivePayloadBad,
    });
    const deniedWaive = await service.transitionCondition("exec", {
      aggregateId: condId,
      transitionId: "SMC-T06",
      scope,
      payload: waivePayloadBad,
      approvals: [
        {
          actorId: "exec-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
          approvedAssignmentVersion: 1,
          commandHash: bBad.commandHash,
          scopeHash: bBad.scopeHash,
          dependencyEpoch: bBad.dependencyEpoch,
          verified: true,
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
        {
          actorId: "admin-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("admin-1", "SYSTEM_ADMIN"),
          approvedAssignmentVersion: 1,
          commandHash: bBad.commandHash,
          scopeHash: bBad.scopeHash,
          dependencyEpoch: bBad.dependencyEpoch,
          verified: true,
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      ],
    });
    expect(deniedWaive).toMatchObject({
      ok: false,
      error: "GUARD_DENIED",
      failedGuards: ["review_date_recorded"],
    });

    // SMC-T06: WAIVE with valid reviewDateRecorded and dual control (CLIENT_EXECUTIVE + SYSTEM_ADMIN)
    const waivePayloadOk = {
      authorityWrittenConfirmation: true,
      executiveApprovalRecorded: true,
      reviewDateRecorded: "2027-06-01T00:00:00.000Z",
    };
    const bOk = await service.computeDualControlBinding({
      aggregateId: condId,
      transitionId: "SMC-T06",
      commandName: "WAIVE",
      scope,
      payload: waivePayloadOk,
    });
    const t06 = await service.transitionCondition("exec", {
      aggregateId: condId,
      transitionId: "SMC-T06",
      scope,
      payload: waivePayloadOk,
      approvals: [
        {
          actorId: "exec-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
          approvedAssignmentVersion: 1,
          commandHash: bOk.commandHash,
          scopeHash: bOk.scopeHash,
          dependencyEpoch: bOk.dependencyEpoch,
          verified: true,
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
        {
          actorId: "admin-1",
          actorKind: "HUMAN",
          assignment: makeAssignment("admin-1", "SYSTEM_ADMIN"),
          approvedAssignmentVersion: 1,
          commandHash: bOk.commandHash,
          scopeHash: bOk.scopeHash,
          dependencyEpoch: bOk.dependencyEpoch,
          verified: true,
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      ],
    });
    expect(t06).toMatchObject({ ok: true, state: "WAIVED" });

    // SMC-T07: WAIVED -> OPEN on REOPEN
    const t07 = await service.transitionCondition("exec", {
      aggregateId: condId,
      transitionId: "SMC-T07",
      scope,
      payload: { executiveApprovalRecorded: true, reasonRecorded: "Waiver review period elapsed" },
    });
    expect(t07).toMatchObject({ ok: true, state: "OPEN" });

    // Advance OPEN -> EVIDENCE_SUBMITTED -> UNDER_REVIEW -> ACCEPTED (SMC-T03)
    await service.transitionCondition("aor", {
      aggregateId: condId,
      transitionId: "SMC-T01",
      scope,
      payload: { evidenceUploaded: true, evidenceTypeMatchesCondition: true },
    });
    await service.transitionCondition("sm", {
      aggregateId: condId,
      transitionId: "SMC-T02",
      scope,
      payload: { reviewerAssigned: true },
    });
    const t03 = await service.transitionCondition("sm", {
      aggregateId: condId,
      transitionId: "SMC-T03",
      scope,
      payload: { acceptanceEvidenceRecorded: true },
    });
    expect(t03).toMatchObject({ ok: true, state: "ACCEPTED" });
  });
});
