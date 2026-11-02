import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthorizationService } from "../../../src/auth/authorization";
import type {
  Role,
  RoleAssignment,
  ScopeBinding,
  VerifiedSessionRecord,
} from "../../../src/contracts/foundation";
import { createBundleService, type BundleServicePort } from "../../../src/domain/bundles";
import { loadMachineDefinitions } from "../../../src/domain/commands/engine";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("bundle tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "40000000-0000-4000-8000-000000000005";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PACKAGE_GATE",
  projectId: PROJECT_ID,
  packageId: "40000000-0000-4000-8000-000000000999",
  plotIds: ["plot-101"],
  scopeVersion: 1,
  designRevision: "rev-A",
  requirementSnapshotId: "req-1",
  evidenceVersionIds: ["ev-bnd:1"],
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

describe("DOMAIN-003 SM_6_bundle lifecycle & immutable resubmission revisions (S6-T01..S6-T13)", () => {
  const services: BundleServicePort[] = [];
  let service: BundleServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `pkg_bnd_${randomUUID().replace(/-/g, "")}`;
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
    ]);

    const authorization = createAuthorizationService({
      verifySession: async (cred) => (typeof cred === "string" ? (sessions.get(cred) ?? null) : null),
      rules: transitions,
    });

    service = createBundleService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("executes all 13 SM_6_bundle transitions (S6-T01..S6-T13) and preserves prior bundle revisions on resubmission", async () => {
    const bndId = randomUUID();
    await service.createBundle("aor", {
      aggregateId: bndId,
      projectId: PROJECT_ID,
      scope,
    });

    // S6-T01: DRAFT -> IN_REVIEW
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bndId,
        transitionId: "S6-T01",
        scope,
        payload: { allItemsAdded: true },
      }),
    ).toMatchObject({ ok: true, state: "IN_REVIEW" });

    // S6-T03: IN_REVIEW -> DRAFT -> S6-T01 -> IN_REVIEW
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bndId,
        transitionId: "S6-T03",
        scope,
        payload: { returnReasonRecorded: "Missing architectural sheet index" },
      }),
    ).toMatchObject({ ok: true, state: "DRAFT" });
    await service.transitionBundle("aor", {
      aggregateId: bndId,
      transitionId: "S6-T01",
      scope,
      payload: { allItemsAdded: true },
    });

    // S6-T02: IN_REVIEW -> READY
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bndId,
        transitionId: "S6-T02",
        scope,
        payload: {
          allItemsValidated: true,
          noOpenBlocker: true,
          bundleHashRecorded: "e".repeat(64),
          authorizedSignatory: true,
        },
      }),
    ).toMatchObject({ ok: true, state: "READY" });

    // S6-T04: READY -> SUBMITTED
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bndId,
        transitionId: "S6-T04",
        scope,
        payload: { submissionReceiptCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "SUBMITTED" });

    // S6-T05: SUBMITTED -> ACKNOWLEDGED
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bndId,
        transitionId: "S6-T05",
        scope,
        payload: { acknowledgementCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "ACKNOWLEDGED" });

    // S6-T06: ACKNOWLEDGED -> UNDER_REVIEW
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bndId,
        transitionId: "S6-T06",
        scope,
        payload: { authorityReviewStarted: true },
      }),
    ).toMatchObject({ ok: true, state: "UNDER_REVIEW" });

    // S6-T08: UNDER_REVIEW -> MODIFICATION_REQUIRED
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bndId,
        transitionId: "S6-T08",
        scope,
        payload: { commentsLinked: true },
      }),
    ).toMatchObject({ ok: true, state: "MODIFICATION_REQUIRED" });

    // S6-T10: MODIFICATION_REQUIRED -> DRAFT (creates new revision 2 without overwriting revision 1)
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bndId,
        transitionId: "S6-T10",
        scope,
        payload: { newRevisionCreated: true },
      }),
    ).toMatchObject({ ok: true, state: "DRAFT" });
    const revisions = await service.getBundleRevisions(bndId);
    expect(revisions).toEqual([1, 2]);

    // Advance revision 2 -> S6-T01 -> S6-T02 -> S6-T04 -> S6-T05 -> S6-T06 -> S6-T07 APPROVED -> S6-T13 CLOSED
    await service.transitionBundle("aor", {
      aggregateId: bndId,
      transitionId: "S6-T01",
      scope,
      payload: { allItemsAdded: true },
    });
    await service.transitionBundle("aor", {
      aggregateId: bndId,
      transitionId: "S6-T02",
      scope,
      payload: {
        allItemsValidated: true,
        noOpenBlocker: true,
        bundleHashRecorded: "f".repeat(64),
        authorizedSignatory: true,
      },
    });
    await service.transitionBundle("aor", {
      aggregateId: bndId,
      transitionId: "S6-T04",
      scope,
      payload: { submissionReceiptCaptured: true },
    });
    await service.transitionBundle("aor", {
      aggregateId: bndId,
      transitionId: "S6-T05",
      scope,
      payload: { acknowledgementCaptured: true },
    });
    await service.transitionBundle("aor", {
      aggregateId: bndId,
      transitionId: "S6-T06",
      scope,
      payload: { authorityReviewStarted: true },
    });
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bndId,
        transitionId: "S6-T07",
        scope,
        payload: { approvalEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "APPROVED" });
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bndId,
        transitionId: "S6-T13",
        scope,
        payload: { closureEvidenceCaptured: true },
      }),
    ).toMatchObject({ ok: true, state: "CLOSED" });

    // Second bundle: S6-T01 -> S6-T02 -> S6-T04 -> S6-T05 -> S6-T06 -> S6-T09 REJECTED; third: S6-T11 WITHDRAWN; fourth: S6-T12 SUPERSEDED
    const bnd2 = randomUUID();
    await service.createBundle("aor", { aggregateId: bnd2, projectId: PROJECT_ID, scope });
    await service.transitionBundle("aor", {
      aggregateId: bnd2,
      transitionId: "S6-T01",
      scope,
      payload: { allItemsAdded: true },
    });
    await service.transitionBundle("aor", {
      aggregateId: bnd2,
      transitionId: "S6-T02",
      scope,
      payload: {
        allItemsValidated: true,
        noOpenBlocker: true,
        bundleHashRecorded: "1".repeat(64),
        authorizedSignatory: true,
      },
    });
    await service.transitionBundle("aor", {
      aggregateId: bnd2,
      transitionId: "S6-T04",
      scope,
      payload: { submissionReceiptCaptured: true },
    });
    await service.transitionBundle("aor", {
      aggregateId: bnd2,
      transitionId: "S6-T05",
      scope,
      payload: { acknowledgementCaptured: true },
    });
    await service.transitionBundle("aor", {
      aggregateId: bnd2,
      transitionId: "S6-T06",
      scope,
      payload: { authorityReviewStarted: true },
    });
    expect(
      await service.transitionBundle("sm", {
        aggregateId: bnd2,
        transitionId: "S6-T09",
        scope,
        payload: { rejectionReasonRecorded: "Wrong plot index" },
      }),
    ).toMatchObject({ ok: true, state: "REJECTED" });

    const bnd3 = randomUUID();
    await service.createBundle("aor", { aggregateId: bnd3, projectId: PROJECT_ID, scope });
    expect(
      await service.transitionBundle("sm", {
        aggregateId: bnd3,
        transitionId: "S6-T11",
        scope,
        payload: { reasonRecorded: "Draft bundle withdrawn" },
      }),
    ).toMatchObject({ ok: true, state: "WITHDRAWN" });

    const bnd4 = randomUUID();
    await service.createBundle("aor", { aggregateId: bnd4, projectId: PROJECT_ID, scope });
    expect(
      await service.transitionBundle("aor", {
        aggregateId: bnd4,
        transitionId: "S6-T12",
        scope,
        payload: { replacementBundleRecorded: true },
      }),
    ).toMatchObject({ ok: true, state: "SUPERSEDED" });
  });
});
