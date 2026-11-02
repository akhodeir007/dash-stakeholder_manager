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
  throw new Error("soil-report tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "20000000-0000-4000-8000-000000000005";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-soil-rep:1"],
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

describe("DOMAIN-002 SM_2D_soil_report lifecycle & third-party inspection stamp enforcement (S2DS-T01..S2DS-T07)", () => {
  const services: MepsServicePort[] = [];
  let service: MepsServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `meps_sr_${randomUUID().replace(/-/g, "")}`;
    const currentTime = new Date("2026-11-02T12:00:00.000Z");

    const sessions = new Map<string, VerifiedSessionRecord>([
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

    service = createMepsService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("denies S2DS-T03 RECORD_STAMP when third-party authorization is only DMT_LICENSING_APPROVED, and executes all 7 SM_2D_soil_report transitions", async () => {
    const srId = randomUUID();
    await service.createSoilReport("dl", {
      aggregateId: srId,
      projectId: PROJECT_ID,
      scope,
    });

    // S2DS-T01: NOT_STARTED -> IN_PROGRESS
    expect(
      await service.transitionMeps("dl", {
        aggregateId: srId,
        transitionId: "S2DS-T01",
        scope,
        payload: { geotechnicalScopeDefined: true },
      }),
    ).toMatchObject({ ok: true, state: "IN_PROGRESS" });

    // S2DS-T02: IN_PROGRESS -> PENDING_THIRD_PARTY_STAMP
    expect(
      await service.transitionMeps("dl", {
        aggregateId: srId,
        transitionId: "S2DS-T02",
        scope,
        payload: { draftReportComplete: true },
      }),
    ).toMatchObject({ ok: true, state: "PENDING_THIRD_PARTY_STAMP" });

    // S2DS-T06: PENDING_THIRD_PARTY_STAMP -> REJECTED
    expect(
      await service.transitionMeps("tpi", {
        aggregateId: srId,
        transitionId: "S2DS-T06",
        scope,
        payload: { rejectionReasonRecorded: "Liquefaction section missing borehole logs" },
      }),
    ).toMatchObject({ ok: true, state: "REJECTED" });

    // S2DS-T07: REJECTED -> IN_PROGRESS -> S2DS-T02 -> PENDING_THIRD_PARTY_STAMP
    expect(
      await service.transitionMeps("dl", {
        aggregateId: srId,
        transitionId: "S2DS-T07",
        scope,
        payload: { correctionsRecorded: true },
      }),
    ).toMatchObject({ ok: true, state: "IN_PROGRESS" });
    await service.transitionMeps("dl", {
      aggregateId: srId,
      transitionId: "S2DS-T02",
      scope,
      payload: { draftReportComplete: true },
    });

    // S2DS-T03 with DMT_LICENSING_APPROVED (not INSPECTION_ACTIVE) -> FORBIDDEN by AuthorizationPort
    const licensingOnlyStamp = await service.transitionMeps("aor", {
      aggregateId: srId,
      transitionId: "S2DS-T03",
      scope,
      evidenceFact: {
        class: "STAMPED_TECHNICAL_DOCUMENT",
        uploaderId: "qualiconsult-1",
        signerId: "qualiconsult-1",
        signerAssignment: makeAssignment("qualiconsult-1", "THIRD_PARTY_INSPECTOR"),
        authorizationState: "DMT_LICENSING_APPROVED",
        authorizationVersionCurrent: true,
        independentValidationVerified: true,
      },
      payload: {
        thirdPartyAuthorizationActive: true,
        authorizedScopeCoversStructuralInspection: true,
        stampedReportUploaded: true,
        stampValid: true,
        signerAssignedAndCredentialed: true,
        independentStructuralValidationRecorded: true,
        authorizationVersionCurrentAtCommit: true,
      },
    });
    expect(licensingOnlyStamp).toMatchObject({ ok: false, error: "FORBIDDEN" });

    // S2DS-T03 with INSPECTION_ACTIVE, credentialed assigned signer, and independent structural validation -> STAMPED_BY_THIRD_PARTY
    const stamped = await service.transitionMeps("aor", {
      aggregateId: srId,
      transitionId: "S2DS-T03",
      scope,
      evidenceFact: {
        class: "STAMPED_TECHNICAL_DOCUMENT",
        uploaderId: "qualiconsult-1",
        signerId: "qualiconsult-1",
        signerAssignment: makeAssignment("qualiconsult-1", "THIRD_PARTY_INSPECTOR"),
        authorizationState: "INSPECTION_ACTIVE",
        authorizationVersionCurrent: true,
        independentValidationVerified: true,
      },
      payload: {
        thirdPartyAuthorizationActive: true,
        authorizedScopeCoversStructuralInspection: true,
        stampedReportUploaded: true,
        stampValid: true,
        signerAssignedAndCredentialed: true,
        independentStructuralValidationRecorded: true,
        authorizationVersionCurrentAtCommit: true,
      },
    });
    expect(stamped).toMatchObject({ ok: true, state: "STAMPED_BY_THIRD_PARTY" });

    // S2DS-T04: STAMPED_BY_THIRD_PARTY -> SUBMITTED
    expect(
      await service.transitionMeps("aor", {
        aggregateId: srId,
        transitionId: "S2DS-T04",
        scope,
        payload: { submissionReceiptCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });

    // S2DS-T05: SUBMITTED -> ACCEPTED
    expect(
      await service.transitionMeps("aor", {
        aggregateId: srId,
        transitionId: "S2DS-T05",
        scope,
        payload: { acceptanceEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "ACCEPTED" });
  });
});
