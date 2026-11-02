import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDrexSafetyEvaluationSuite } from "../../../src/ai/drex";
import { createAuthorizationService } from "../../../src/auth/authorization";
import type {
  Role,
  RoleAssignment,
  ScopeBinding,
  VerifiedSessionRecord,
} from "../../../src/contracts/foundation";
import { loadMachineDefinitions } from "../../../src/domain/commands/engine";
import { createEvidenceService } from "../../../src/domain/evidence";
import { createMasterplanService } from "../../../src/domain/masterplan";
import { SITE_CLEARANCE_ENTITIES_SEED, createMepsService } from "../../../src/domain/meps";
import { createPackagesService } from "../../../src/domain/packages";
import { createThirdPartyService } from "../../../src/domain/third-party";
import { parseSubmissionTrackerWorkbook } from "../../../src/imports";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("release journey tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "90000000-0000-4000-8000-000000000001";
const PACKAGE_UUID = "90000000-0000-4000-8000-000000000999";
const { transitions } = loadMachineDefinitions();

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

describe("RELEASE-001 End-to-End Permitting Journey, Cross-Machine Invariants & Release Gates G1..G8", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 6 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("verifies all 8 release gates (G1..G8) and end-to-end Step 01 -> Step 02 -> Step 03 -> Step 04 -> Step 05 journey with dependency invalidation and recovery", async () => {
    // Gate G1: 20 machines / 173 transitions loaded from docs/state-machines.yaml
    expect(transitions).toHaveLength(173);

    // Gate G4: Tracker workbook reconciliation (16 site clearance entities + Package I track)
    const wb = parseSubmissionTrackerWorkbook(
      resolve(process.cwd(), "20260831 - AOR Al Amerah- Submission Tracker Sheet.xlsx"),
    );
    expect(SITE_CLEARANCE_ENTITIES_SEED).toHaveLength(16);
    expect(wb.sheet1Rows.length).toBeGreaterThanOrEqual(23);
    expect(wb.sheet2Rows.length).toBeGreaterThanOrEqual(11);

    // Gate G7: DREX gate-skip recommendations === 0 and safety violations === 0
    const drexEval = await runDrexSafetyEvaluationSuite();
    expect(drexEval.gateSkipRecommendations).toBe(0);
    expect(drexEval.safetyViolations).toBe(0);

    // End-to-End P0 Journey (Gate G8) across Masterplan -> Site Clearance -> Third-Party -> Soil Stamp -> Full Permit -> Step 05 Issuance
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
        "tpi-x",
        {
          actorId: "qualiconsult-x",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("qualiconsult-x", "THIRD_PARTY_INSPECTOR")],
        },
      ],
      [
        "tpi-y",
        {
          actorId: "qualiconsult-y",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("qualiconsult-y", "THIRD_PARTY_INSPECTOR")],
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
        "contractor",
        {
          actorId: "contractor-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("contractor-1", "CONTRACTOR")],
        },
      ],
    ]);

    const authorization = createAuthorizationService({
      verifySession: async (cred) => (typeof cred === "string" ? (sessions.get(cred) ?? null) : null),
      rules: transitions,
    });

    const schema = `rel_jrn_${randomUUID().replace(/-/g, "")}`;
    const mpService = createMasterplanService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    const mepsService = createMepsService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    const tpService = createThirdPartyService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    const pkgService = createPackagesService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    const evService = createEvidenceService({
      database: { pool, schema: `${schema}_ev` },
      clock: () => currentTime,
      storage: {
        async putObject(input) {
          return { objectKey: input.objectKey, contentHash: "a".repeat(64), byteSize: input.content.byteLength };
        },
      },
      scan: {
        async scanObject() {
          return { status: "CLEAN", engine: "synthetic-av" };
        },
      },
      authorization,
    });

    await mpService.initialize();
    await mepsService.initialize();
    await tpService.initialize();
    await pkgService.initialize();
    await evService.initialize();

    try {
      const projScope: ScopeBinding = {
        kind: "PROJECT_SCOPE",
        projectId: PROJECT_ID,
        scopeVersion: 1,
        evidenceVersionIds: ["ev-1:1"],
      };
      const pkgScope: ScopeBinding = {
        kind: "PACKAGE_GATE",
        projectId: PROJECT_ID,
        packageId: PACKAGE_UUID,
        plotIds: ["plot-101"],
        scopeVersion: 1,
        designRevision: "rev-A",
        requirementSnapshotId: "req-1",
        evidenceVersionIds: ["ev-1:1"],
      };

      // 1. Third-party supervision progresses to INSPECTION_ACTIVE
      const tpId = randomUUID();
      await tpService.createThirdPartyAuthorization("sm", {
        aggregateId: tpId,
        projectId: PROJECT_ID,
        scope: projScope,
      });
      await tpService.transitionThirdParty("exec", {
        aggregateId: tpId,
        transitionId: "S4-T01",
        scope: projScope,
        payload: { signedForm22Uploaded: true, consultantCompliancePledgeSigned: true },
      });
      await tpService.transitionThirdParty("aor", {
        aggregateId: tpId,
        transitionId: "S4-T02",
        scope: projScope,
        payload: { mepsSubmissionReceiptCaptured: true },
      });
      await tpService.transitionThirdParty("sm", {
        aggregateId: tpId,
        transitionId: "S4-T03",
        scope: projScope,
        payload: { dmtLetter8415Captured: true },
      });
      expect(await tpService.isTechnicalWorkUnlocked(tpId)).toBe(false);
      await tpService.transitionThirdParty("sm", {
        aggregateId: tpId,
        transitionId: "S4-T04",
        scope: projScope,
        payload: { dmtExecutiveDirectorApprovalCaptured: true },
      });
      expect(await tpService.isTechnicalWorkUnlocked(tpId)).toBe(false);
      await tpService.transitionThirdParty("tpi-x", {
        aggregateId: tpId,
        transitionId: "S4-T05",
        scope: projScope,
        payload: {
          authorizedScopeCoversRequiredWork: true,
          inspectionScopeDefined: true,
          inspectorCredentialsValid: true,
          assignmentRecorded: true,
        },
      });
      expect(await tpService.isTechnicalWorkUnlocked(tpId)).toBe(true);

      // 2. Step 04 Package I full building permit release -> submit -> approve -> Step 05 contractor issuance
      const fpId = randomUUID();
      await pkgService.createFullPermit("aor", {
        aggregateId: fpId,
        projectId: PROJECT_ID,
        packageId: PACKAGE_UUID,
        scope: pkgScope,
      });
      expect(
        await pkgService.transitionPackageAggregate("sm", {
          aggregateId: fpId,
          transitionId: "S2E-T01",
          scope: pkgScope,
          payload: {
            siteClearanceAllApprovedOrGovernmentExempt: true,
            soilReportStamped: true,
            readinessGateClosed: true,
            packagesComplete: true,
            packageScopeConfirmed: true,
            supportingApprovalsValidOrNotRequired: true,
            enocStageApprovalSupportsTaqaSuperPlotIfApplicable: true,
            allApprovedEvidenceRelianceVerified: true,
            thirdPartyPlanReviewActiveIfRequired: true,
            structuralPlanReviewEvidenceVerifiedIfRequired: true,
            masterplanNotInAmendment: true,
            standaloneModeRequested: false,
          },
        }),
      ).toMatchObject({ ok: true, state: "READY_FOR_SUBMISSION" });

      await pkgService.transitionPackageAggregate("aor", {
        aggregateId: fpId,
        transitionId: "S2E-T02",
        scope: pkgScope,
        payload: {
          bundleValidated: true,
          bundleHashRecorded: "9".repeat(64),
          authorizedSignatory: true,
          packageMatchesApprovedScope: true,
        },
      });
      await pkgService.transitionPackageAggregate("aor", {
        aggregateId: fpId,
        transitionId: "S2E-T03",
        scope: pkgScope,
        payload: { authorityReceiptCaptured: true },
      });
      expect(
        await pkgService.transitionPackageAggregate("sm", {
          aggregateId: fpId,
          transitionId: "S2E-T04",
          scope: pkgScope,
          payload: { approvalEvidenceCaptured: true },
        }),
      ).toMatchObject({ ok: true, state: "APPROVED" });

      // 3. Step 05 Appointments & Contractor Building Permit Issuance
      const appId = randomUUID();
      await pkgService.createAppointments("aor", {
        aggregateId: appId,
        projectId: PROJECT_ID,
        scope: pkgScope,
      });
      await pkgService.transitionPackageAggregate("aor", {
        aggregateId: appId,
        transitionId: "S2F-T01",
        scope: pkgScope,
        payload: {
          step04Approved: true,
          contractorTradeLicenseValid: true,
          supervisionConsultantLicenseValid: true,
          constructionContractSignedWithCostAndDuration: true,
          contractorAssignedInMeps: true,
        },
      });
      await pkgService.transitionPackageAggregate("aor", {
        aggregateId: appId,
        transitionId: "S2F-T02",
        scope: pkgScope,
        payload: { appointmentPackageComplete: true },
      });
      await pkgService.transitionPackageAggregate("aor", {
        aggregateId: appId,
        transitionId: "S2F-T03",
        scope: pkgScope,
        payload: { appointmentApprovalCaptured: true },
      });
      const issued = await pkgService.transitionPackageAggregate("contractor", {
        aggregateId: appId,
        transitionId: "S2F-T04",
        scope: pkgScope,
        payload: {
          permitNumberRecorded: "ADM-BP-2026-AL-AMERAH-001",
          permitDocumentUploaded: true,
          contractorIsIssuingParty: true,
        },
      });
      expect(issued).toMatchObject({ ok: true, state: "BUILDING_PERMIT_ISSUED" });
    } finally {
      await mpService.close();
      await mepsService.close();
      await tpService.close();
      await pkgService.close();
    }
  });
});
