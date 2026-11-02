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
  computeAbuDhabiBusinessDays,
  createEscalationService,
  type EscalationServicePort,
} from "../../../src/jobs";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("escalation tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "50000000-0000-4000-8000-000000000002";
const { transitions } = loadMachineDefinitions();

const scope: ScopeBinding = {
  kind: "PROJECT_SCOPE",
  projectId: PROJECT_ID,
  scopeVersion: 1,
  evidenceVersionIds: ["ev-esc:1"],
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

describe("INTEGRATE-002 SM_8_escalation lifecycle, Abu Dhabi business calendar & RULE_1..RULE_4 deduplication", () => {
  const services: EscalationServicePort[] = [];
  let service: EscalationServicePort;

  afterAll(async () => {
    for (const s of services) await s.close();
  });

  beforeEach(async () => {
    const schema = `rep_esc_${randomUUID().replace(/-/g, "")}`;
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
    ]);

    const authorization = createAuthorizationService({
      verifySession: async (cred) => (typeof cred === "string" ? (sessions.get(cred) ?? null) : null),
      rules: transitions,
    });

    service = createEscalationService({
      connectionString: url!,
      schema,
      authorization,
      clock: () => currentTime,
    });
    services.push(service);
    await service.initialize();
  });

  it("computes Abu Dhabi Mon-Fri business days skipping Sat/Sun and UAE holidays, deduplicates RULE_1..RULE_4 by (ruleId, entityId, businessDate), and executes S8-T01..S8-T07", async () => {
    // 2026-11-02 (Mon) to 2026-11-16 (Mon) = 10 Mon-Fri business days (skipping Sat/Sun)
    expect(
      computeAbuDhabiBusinessDays("2026-11-02T08:00:00.000Z", "2026-11-16T08:00:00.000Z", []),
    ).toBe(10);
    // With 2 UAE public holidays in that window -> 8 business days
    expect(
      computeAbuDhabiBusinessDays("2026-11-02T08:00:00.000Z", "2026-11-16T08:00:00.000Z", [
        "2026-11-04",
        "2026-11-05",
      ]),
    ).toBe(8);
    // Null start or end date never fabricates 0 duration
    expect(computeAbuDhabiBusinessDays(null, "2026-11-16T08:00:00.000Z", [])).toBeNull();

    // Evaluate RULE_1..RULE_4 and verify deduplication on same businessDate
    const firstEval = await service.evaluateEscalationRules("sys", {
      projectId: PROJECT_ID,
      businessDate: "2026-11-02",
      scope,
      candidates: [
        { ruleId: "RULE_1", entityId: "EAND_ETISALAT", conditionMet: true },
        { ruleId: "RULE_2", entityId: "ADSSC", conditionMet: true },
        { ruleId: "RULE_3", entityId: "PACKAGE_I", conditionMet: true },
        { ruleId: "RULE_4", entityId: "AAM_ROADS", conditionMet: true },
      ],
    });
    expect(firstEval.createdCount).toBe(4);
    expect(firstEval.dedupedCount).toBe(0);

    const secondEvalSameDay = await service.evaluateEscalationRules("sys", {
      projectId: PROJECT_ID,
      businessDate: "2026-11-02",
      scope,
      candidates: [
        { ruleId: "RULE_1", entityId: "EAND_ETISALAT", conditionMet: true },
        { ruleId: "RULE_2", entityId: "ADSSC", conditionMet: true },
        { ruleId: "RULE_3", entityId: "PACKAGE_I", conditionMet: true },
        { ruleId: "RULE_4", entityId: "AAM_ROADS", conditionMet: true },
      ],
    });
    expect(secondEvalSameDay.createdCount).toBe(0);
    expect(secondEvalSameDay.dedupedCount).toBe(4);

    // Execute full SM_8_escalation lifecycle (S8-T01..S8-T07)
    const escId = firstEval.escalationIds[0];
    // S8-T01: PENDING -> SENT
    expect(
      await service.transitionEscalation("sys", {
        aggregateId: escId,
        transitionId: "S8-T01",
        scope,
        payload: { dedupeKeyUnique: true, recipientResolved: true, templateRendered: true },
      }),
    ).toMatchObject({ ok: true, state: "SENT" });

    // S8-T05: SENT -> FAILED -> S8-T06 -> PENDING -> S8-T01 -> SENT -> S8-T02 -> DELIVERED
    expect(
      await service.transitionEscalation("sys", {
        aggregateId: escId,
        transitionId: "S8-T05",
        scope,
        payload: { deliveryFailed: true },
      }),
    ).toMatchObject({ ok: true, state: "FAILED" });
    expect(
      await service.transitionEscalation("sys", {
        aggregateId: escId,
        transitionId: "S8-T06",
        scope,
        payload: { retryBudgetAvailable: true },
      }),
    ).toMatchObject({ ok: true, state: "PENDING" });
    await service.transitionEscalation("sys", {
      aggregateId: escId,
      transitionId: "S8-T01",
      scope,
      payload: { dedupeKeyUnique: true, recipientResolved: true, templateRendered: true },
    });
    expect(
      await service.transitionEscalation("sys", {
        aggregateId: escId,
        transitionId: "S8-T02",
        scope,
        payload: { deliveryWebhookReceived: true },
      }),
    ).toMatchObject({ ok: true, state: "DELIVERED" });

    // S8-T03: DELIVERED -> ACKNOWLEDGED -> S8-T04 -> ESCALATED -> S8-T07 -> CLOSED
    expect(
      await service.transitionEscalation("sm", {
        aggregateId: escId,
        transitionId: "S8-T03",
        scope,
        payload: { acknowledgmentRecorded: true },
      }),
    ).toMatchObject({ ok: true, state: "ACKNOWLEDGED" });
    expect(
      await service.transitionEscalation("sys", {
        aggregateId: escId,
        transitionId: "S8-T04",
        scope,
        payload: { acknowledgmentDeadlinePassed: true, nextLevelResolved: true },
      }),
    ).toMatchObject({ ok: true, state: "ESCALATED" });
    expect(
      await service.transitionEscalation("sm", {
        aggregateId: escId,
        transitionId: "S8-T07",
        scope,
        payload: { conditionResolvedOrAcknowledged: true },
      }),
    ).toMatchObject({ ok: true, state: "CLOSED" });
  });
});
