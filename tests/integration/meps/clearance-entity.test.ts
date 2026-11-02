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
  SITE_CLEARANCE_ENTITIES_SEED,
  createMepsService,
  type MepsServicePort,
} from "../../../src/domain/meps";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("clearance-entity tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-sc:1"],
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

describe("DOMAIN-002 SM_2B_entity 16-entity seed matrix, conflicts, aliases & 14 transitions (S2B-T01..S2B-T14)", () => {
  const services: MepsServicePort[] = [];
  let service: MepsServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `meps_ent_${randomUUID().replace(/-/g, "")}`;
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

  it("preserves all 16 site-clearance entities (13 required + 3 not-required seeds), active/legacy refs, ADSSC/ADMCC aliases, and TAQA_WATER conflict quarantine", async () => {
    expect(SITE_CLEARANCE_ENTITIES_SEED).toHaveLength(16);
    const required = SITE_CLEARANCE_ENTITIES_SEED.filter((e) => e.required);
    const notRequiredSeeds = SITE_CLEARANCE_ENTITIES_SEED.filter((e) => !e.required);
    expect(required).toHaveLength(13);
    expect(notRequiredSeeds.map((e) => e.id).sort()).toEqual(["ADPC_PORTS", "ENEC", "ZONES_CORP"]);

    const taqaWater = SITE_CLEARANCE_ENTITIES_SEED.find((e) => e.id === "TAQA_WATER")!;
    expect(taqaWater.seedStatus).toBe("CONFLICT_APPROVED_VS_COMMENTS");
    expect(taqaWater.refs).toEqual(["B2-SC-A-2026-001525", "B2-SC-A-2026-001625"]);

    const adssc = SITE_CLEARANCE_ENTITIES_SEED.find((e) => e.id === "ADSSC")!;
    expect(adssc.alias).toBe("ADSCC");
    const admcc = SITE_CLEARANCE_ENTITIES_SEED.find((e) => e.id === "ADMCC")!;
    expect(admcc.alias).toBe("MCC");
  });

  it("executes all 14 SM_2B_entity transitions (S2B-T01..S2B-T14) including document requests, comments, unavailable service rejection, waiver, expiry, and not-required dual control", async () => {
    const caseId = randomUUID();
    const entId = randomUUID();
    await service.createClearanceEntity("aor", {
      aggregateId: entId,
      caseId,
      projectId: PROJECT_ID,
      entityCode: "AAM_ROADS",
      required: true,
      scope,
    });

    // S2B-T01: NOT_STARTED -> PREPARING
    expect(
      await service.transitionMeps("aor", {
        aggregateId: entId,
        transitionId: "S2B-T01",
        scope,
        payload: { ownerAssigned: true, requirementListGenerated: true },
      }),
    ).toMatchObject({ ok: true, state: "PREPARING" });

    // S2B-T02: PREPARING -> SUBMITTED
    expect(
      await service.transitionMeps("aor", {
        aggregateId: entId,
        transitionId: "S2B-T02",
        scope,
        payload: { requiredDocumentsPresent: true, signedUndertakingPresentIfRequired: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });

    // S2B-T03: SUBMITTED -> UNDER_REVIEW
    expect(
      await service.transitionMeps("aor", {
        aggregateId: entId,
        transitionId: "S2B-T03",
        scope,
        payload: { authorityReceiptCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "UNDER_REVIEW" });

    // S2B-T05: UNDER_REVIEW -> PENDING_DOCUMENTS
    expect(
      await service.transitionMeps("aor", {
        aggregateId: entId,
        transitionId: "S2B-T05",
        scope,
        payload: { authorityRequestCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "PENDING_DOCUMENTS" });

    // S2B-T06: PENDING_DOCUMENTS -> SUBMITTED -> S2B-T03 -> UNDER_REVIEW
    expect(
      await service.transitionMeps("aor", {
        aggregateId: entId,
        transitionId: "S2B-T06",
        scope,
        payload: { allRequestedDocumentsUploaded: true, documentsValidated: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });
    await service.transitionMeps("aor", {
      aggregateId: entId,
      transitionId: "S2B-T03",
      scope,
      payload: { authorityReceiptCaptured: true },
    });

    // S2B-T07: UNDER_REVIEW -> MODIFICATION_REQUIRED
    expect(
      await service.transitionMeps("aor", {
        aggregateId: entId,
        transitionId: "S2B-T07",
        scope,
        payload: { commentLetterCaptured: true, commentsLinked: true },
      }),
    ).toMatchObject({ ok: true, state: "MODIFICATION_REQUIRED" });

    // S2B-T08: MODIFICATION_REQUIRED -> SUBMITTED -> S2B-T03 -> UNDER_REVIEW
    expect(
      await service.transitionMeps("aor", {
        aggregateId: entId,
        transitionId: "S2B-T08",
        scope,
        payload: { revisedDrawingsUploaded: true, responseBundleComplete: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });
    await service.transitionMeps("aor", {
      aggregateId: entId,
      transitionId: "S2B-T03",
      scope,
      payload: { authorityReceiptCaptured: true },
    });

    // S2B-T04: UNDER_REVIEW -> APPROVED
    expect(
      await service.transitionMeps("sm", {
        aggregateId: entId,
        transitionId: "S2B-T04",
        scope,
        payload: { validNocEvidence: true, evidenceNotExpired: true, relianceVerified: true },
      }),
    ).toMatchObject({ ok: true, state: "APPROVED" });

    // S2B-T11: APPROVED -> EXPIRED (SYSTEM)
    expect(
      await service.transitionMeps("sys", {
        aggregateId: entId,
        transitionId: "S2B-T11",
        scope,
        payload: { evidenceExpiryPassed: true },
      }),
    ).toMatchObject({ ok: true, state: "EXPIRED" });

    // S2B-T12: EXPIRED -> SUBMITTED -> S2B-T03 -> UNDER_REVIEW -> S2B-T09 REJECT_UNAVAILABLE
    expect(
      await service.transitionMeps("aor", {
        aggregateId: entId,
        transitionId: "S2B-T12",
        scope,
        payload: { renewedEvidenceUploaded: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });
    await service.transitionMeps("aor", {
      aggregateId: entId,
      transitionId: "S2B-T03",
      scope,
      payload: { authorityReceiptCaptured: true },
    });
    expect(
      await service.transitionMeps("sm", {
        aggregateId: entId,
        transitionId: "S2B-T09",
        scope,
        payload: { authorityLetterConfirmsUnavailableService: true },
      }),
    ).toMatchObject({ ok: true, state: "REJECTED_INFRASTRUCTURE_UNAVAILABLE" });

    // S2B-T10: WAIVE from REJECTED_INFRASTRUCTURE_UNAVAILABLE with dual control (CLIENT_EXECUTIVE + SYSTEM_ADMIN)
    const waivePayload = {
      authorityWrittenConfirmation: true,
      executiveApprovalRecorded: true,
      reviewDateRecorded: "2027-06-01T00:00:00.000Z",
    };
    const b10 = await service.computeDualControlBinding({
      aggregateId: entId,
      transitionId: "S2B-T10",
      scope,
      payload: waivePayload,
    });
    expect(
      await service.transitionMeps("exec", {
        aggregateId: entId,
        transitionId: "S2B-T10",
        scope,
        payload: waivePayload,
        approvals: [
          {
            actorId: "exec-1",
            actorKind: "HUMAN",
            assignment: makeAssignment("exec-1", "CLIENT_EXECUTIVE"),
            approvedAssignmentVersion: 1,
            commandHash: b10.commandHash,
            scopeHash: b10.scopeHash,
            dependencyEpoch: b10.dependencyEpoch,
            verified: true,
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          {
            actorId: "admin-1",
            actorKind: "HUMAN",
            assignment: makeAssignment("admin-1", "SYSTEM_ADMIN"),
            approvedAssignmentVersion: 1,
            commandHash: b10.commandHash,
            scopeHash: b10.scopeHash,
            dependencyEpoch: b10.dependencyEpoch,
            verified: true,
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ ok: true, state: "WAIVED" });

    // S2B-T14: MARK_NOT_REQUIRED on ADPC_PORTS with dual control (STAKEHOLDER_MANAGER + CLIENT_EXECUTIVE)
    const ent2 = randomUUID();
    await service.createClearanceEntity("aor", {
      aggregateId: ent2,
      caseId,
      projectId: PROJECT_ID,
      entityCode: "ADPC_PORTS",
      required: false,
      scope,
    });
    const nrPayload = {
      authorityConfirmsNotApplicable: true,
      justificationRecorded: "Inland housing plot outside port zone",
      validatorApprovalRecorded: true,
    };
    const b14 = await service.computeDualControlBinding({
      aggregateId: ent2,
      transitionId: "S2B-T14",
      scope,
      payload: nrPayload,
    });
    expect(
      await service.transitionMeps("sm", {
        aggregateId: ent2,
        transitionId: "S2B-T14",
        scope,
        payload: nrPayload,
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
    ).toMatchObject({ ok: true, state: "NOT_REQUIRED" });

    // S2B-T13: WITHDRAW on third entity
    const ent3 = randomUUID();
    await service.createClearanceEntity("aor", {
      aggregateId: ent3,
      caseId,
      projectId: PROJECT_ID,
      entityCode: "ENEC",
      required: false,
      scope,
    });
    expect(
      await service.transitionMeps("sm", {
        aggregateId: ent3,
        transitionId: "S2B-T13",
        scope,
        payload: { reasonRecorded: "Duplicate seed withdrawn" },
      }),
    ).toMatchObject({ ok: true, state: "WITHDRAWN" });
  });
});
