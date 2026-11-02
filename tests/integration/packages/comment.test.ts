import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthorizationService } from "../../../src/auth/authorization";
import type {
  Role,
  RoleAssignment,
  ScopeBinding,
  VerifiedSessionRecord,
} from "../../../src/contracts/foundation";
import { createCommentService, type CommentServicePort } from "../../../src/domain/comments";
import { loadMachineDefinitions } from "../../../src/domain/commands/engine";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("comment tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "40000000-0000-4000-8000-000000000004";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PACKAGE_GATE",
  projectId: PROJECT_ID,
  packageId: "40000000-0000-4000-8000-000000000999",
  plotIds: ["plot-101"],
  scopeVersion: 1,
  designRevision: "rev-A",
  requirementSnapshotId: "req-1",
  evidenceVersionIds: ["ev-cmt:1"],
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

describe("DOMAIN-003 SM_5_comment lifecycle & structural third-party stamp check (S5-T01..S5-T11)", () => {
  const services: CommentServicePort[] = [];
  let service: CommentServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `pkg_cmt_${randomUUID().replace(/-/g, "")}`;
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
        "tpi",
        {
          actorId: "qualiconsult-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2030-12-31T00:00:00.000Z",
          assignments: [makeAssignment("qualiconsult-1", "THIRD_PARTY_INSPECTOR")],
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

    service = createCommentService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("executes all 11 SM_5_comment transitions (S5-T01..S5-T11), enforces structural stamp on S5-T04, and denies contractor closure", async () => {
    const cmtId = randomUUID();
    await service.createComment("aor", {
      aggregateId: cmtId,
      projectId: PROJECT_ID,
      scope,
    });

    // S5-T01: NEW -> TRIAGED
    expect(
      await service.transitionComment("aor", {
        aggregateId: cmtId,
        transitionId: "S5-T01",
        scope,
        payload: { categoryAssigned: true, disciplineAssigned: true },
      }),
    ).toMatchObject({ ok: true, state: "TRIAGED" });

    // S5-T02: TRIAGED -> ASSIGNED
    expect(
      await service.transitionComment("aor", {
        aggregateId: cmtId,
        transitionId: "S5-T02",
        scope,
        payload: { ownerAssigned: true, dueDateSet: "2026-11-10T00:00:00.000Z" },
      }),
    ).toMatchObject({ ok: true, state: "ASSIGNED" });

    // S5-T09: ASSIGNED -> DISPUTED -> S5-T10 -> ASSIGNED
    expect(
      await service.transitionComment("sm", {
        aggregateId: cmtId,
        transitionId: "S5-T09",
        scope,
        payload: { disputeReasonRecorded: "Comment cites superseded code clause" },
      }),
    ).toMatchObject({ ok: true, state: "DISPUTED" });
    expect(
      await service.transitionComment("sm", {
        aggregateId: cmtId,
        transitionId: "S5-T10",
        scope,
        payload: { resolutionRecorded: "Authority clarified applicable clause" },
      }),
    ).toMatchObject({ ok: true, state: "ASSIGNED" });

    // S5-T03: ASSIGNED -> RESPONSE_DRAFTED
    expect(
      await service.transitionComment("dl", {
        aggregateId: cmtId,
        transitionId: "S5-T03",
        scope,
        payload: { responseTextEntered: "Updated raft foundation reinforcement" },
      }),
    ).toMatchObject({ ok: true, state: "RESPONSE_DRAFTED" });

    // S5-T04: RESPONSE_DRAFTED -> READY_FOR_UPLOAD (requires stamped_revision_present_if_structural)
    expect(
      await service.transitionComment("tpi", {
        aggregateId: cmtId,
        transitionId: "S5-T04",
        scope,
        payload: {
          revisedDrawingUploaded: true,
          stampedRevisionPresentIfStructural: false,
          disciplineLeadApproval: true,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: "GUARD_DENIED",
      failedGuards: ["stamped_revision_present_if_structural"],
    });

    expect(
      await service.transitionComment("tpi", {
        aggregateId: cmtId,
        transitionId: "S5-T04",
        scope,
        payload: {
          revisedDrawingUploaded: true,
          stampedRevisionPresentIfStructural: true,
          disciplineLeadApproval: true,
        },
      }),
    ).toMatchObject({ ok: true, state: "READY_FOR_UPLOAD" });

    // S5-T05: READY_FOR_UPLOAD -> RESUBMITTED
    expect(
      await service.transitionComment("aor", {
        aggregateId: cmtId,
        transitionId: "S5-T05",
        scope,
        payload: { bundleSubmitted: true, submissionReceiptCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "RESUBMITTED" });

    // S5-T07: RESUBMITTED -> REOPENED -> S5-T08 -> ASSIGNED -> S5-T03 -> S5-T04 -> S5-T05 -> S5-T06 CLOSED
    expect(
      await service.transitionComment("aor", {
        aggregateId: cmtId,
        transitionId: "S5-T07",
        scope,
        payload: { authorityRejectionEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "REOPENED" });
    expect(
      await service.transitionComment("aor", {
        aggregateId: cmtId,
        transitionId: "S5-T08",
        scope,
        payload: { ownerAssigned: true },
      }),
    ).toMatchObject({ ok: true, state: "ASSIGNED" });
    await service.transitionComment("dl", {
      aggregateId: cmtId,
      transitionId: "S5-T03",
      scope,
      payload: { responseTextEntered: "Final structural calculation revision" },
    });
    await service.transitionComment("aor", {
      aggregateId: cmtId,
      transitionId: "S5-T04",
      scope,
      payload: {
        revisedDrawingUploaded: true,
        stampedRevisionPresentIfStructural: true,
        disciplineLeadApproval: true,
      },
    });
    await service.transitionComment("aor", {
      aggregateId: cmtId,
      transitionId: "S5-T05",
      scope,
      payload: { bundleSubmitted: true, submissionReceiptCaptured: true },
    });

    // Contractor cannot close comments (S5-T06)
    expect(
      await service.transitionComment("contractor", {
        aggregateId: cmtId,
        transitionId: "S5-T06",
        scope,
        payload: { authorityClosureEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: false, error: "FORBIDDEN" });

    expect(
      await service.transitionComment("sm", {
        aggregateId: cmtId,
        transitionId: "S5-T06",
        scope,
        payload: { authorityClosureEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "CLOSED" });

    // S5-T11: WITHDRAW on second comment
    const cmt2 = randomUUID();
    await service.createComment("aor", { aggregateId: cmt2, projectId: PROJECT_ID, scope });
    expect(
      await service.transitionComment("sm", {
        aggregateId: cmt2,
        transitionId: "S5-T11",
        scope,
        payload: { reasonRecorded: "Duplicate comment row withdrawn" },
      }),
    ).toMatchObject({ ok: true, state: "WITHDRAWN" });
  });
});
