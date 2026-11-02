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
  computeDeterministicKpis,
  createReportService,
  type ReportServicePort,
} from "../../../src/reports";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("report tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "50000000-0000-4000-8000-000000000003";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-rep:1"],
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

describe("INTEGRATE-002 SM_9_report lifecycle, immutable reproducible snapshots & deterministic KPIs (S9-T01..S9-T07)", () => {
  const services: ReportServicePort[] = [];
  let service: ReportServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `rep_rpt_${randomUUID().replace(/-/g, "")}`;
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

    service = createReportService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("reports UNKNOWN_DURATION for null tracker dates (never 0 days), executes S9-T01..S9-T07, and reproduces identical snapshot hashes", async () => {
    const kpi1 = computeDeterministicKpis([
      { entityId: "ADNOC", status: "APPROVED", submittedAt: null, approvedAt: null },
      {
        entityId: "EAD",
        status: "APPROVED",
        submittedAt: "2026-10-01T08:00:00.000Z",
        approvedAt: "2026-10-08T08:00:00.000Z",
      },
      { entityId: "TAQA_WATER", status: "CONFLICT_APPROVED_VS_COMMENTS", submittedAt: null, approvedAt: null },
    ]);
    const kpi2 = computeDeterministicKpis([
      { entityId: "ADNOC", status: "APPROVED", submittedAt: null, approvedAt: null },
      {
        entityId: "EAD",
        status: "APPROVED",
        submittedAt: "2026-10-01T08:00:00.000Z",
        approvedAt: "2026-10-08T08:00:00.000Z",
      },
      { entityId: "TAQA_WATER", status: "CONFLICT_APPROVED_VS_COMMENTS", submittedAt: null, approvedAt: null },
    ]);
    expect(kpi1.snapshotHash).toBe(kpi2.snapshotHash);
    expect(kpi1.durationsByEntity.ADNOC).toBe("UNKNOWN_DURATION");
    expect(kpi1.durationsByEntity.EAD).toBe(5);
    expect(kpi1.conflictQuarantinedCount).toBe(1);

    const rptId = randomUUID();
    await service.createReport("sm", {
      aggregateId: rptId,
      projectId: PROJECT_ID,
      templateVersion: "exec-weekly-v1",
      scope,
    });

    // S9-T01: REQUESTED -> GENERATING
    expect(
      await service.transitionReport("sys", {
        aggregateId: rptId,
        transitionId: "S9-T01",
        scope,
        payload: { templateVersionResolved: true, dataSnapshotCreated: true },
      }),
    ).toMatchObject({ ok: true, state: "GENERATING" });

    // S9-T05: GENERATING -> FAILED -> S9-T06 -> REQUESTED -> S9-T01 -> GENERATING
    expect(
      await service.transitionReport("sys", {
        aggregateId: rptId,
        transitionId: "S9-T05",
        scope,
        payload: { renderErrorRecorded: "Transient PDF renderer timeout" },
      }),
    ).toMatchObject({ ok: true, state: "FAILED" });
    expect(
      await service.transitionReport("sys", {
        aggregateId: rptId,
        transitionId: "S9-T06",
        scope,
        payload: { retryBudgetAvailable: true },
      }),
    ).toMatchObject({ ok: true, state: "REQUESTED" });
    await service.transitionReport("sys", {
      aggregateId: rptId,
      transitionId: "S9-T01",
      scope,
      payload: { templateVersionResolved: true, dataSnapshotCreated: true },
    });

    // S9-T02: GENERATING -> IN_REVIEW -> S9-T04 -> GENERATING -> S9-T02 -> IN_REVIEW -> S9-T03 -> PUBLISHED -> S9-T07 -> SUPERSEDED
    expect(
      await service.transitionReport("sys", {
        aggregateId: rptId,
        transitionId: "S9-T02",
        scope,
        payload: { renderSucceeded: true, snapshotHashRecorded: kpi1.snapshotHash },
      }),
    ).toMatchObject({ ok: true, state: "IN_REVIEW" });
    expect(
      await service.transitionReport("sm", {
        aggregateId: rptId,
        transitionId: "S9-T04",
        scope,
        payload: { reasonRecorded: "Refresh after new TAQA comment" },
      }),
    ).toMatchObject({ ok: true, state: "GENERATING" });
    await service.transitionReport("sys", {
      aggregateId: rptId,
      transitionId: "S9-T02",
      scope,
      payload: { renderSucceeded: true, snapshotHashRecorded: kpi1.snapshotHash },
    });
    expect(
      await service.transitionReport("exec", {
        aggregateId: rptId,
        transitionId: "S9-T03",
        scope,
        payload: { approverRecorded: true, distributionListResolved: true },
      }),
    ).toMatchObject({ ok: true, state: "PUBLISHED" });
    expect(
      await service.transitionReport("sys", {
        aggregateId: rptId,
        transitionId: "S9-T07",
        scope,
        payload: { newerReportPublished: true },
      }),
    ).toMatchObject({ ok: true, state: "SUPERSEDED" });
  });
});
