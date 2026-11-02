import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import YAML from "yaml";
import type {
  ApprovalFact,
  AuthorizationPort,
  JsonValue,
  ScopeBinding,
} from "../../contracts/foundation";
import {
  canonicalHash,
  createCommandEngine,
  loadMachineDefinitions,
  normalizeScope,
  type CommandEnvelope,
  type CommandResult,
} from "../commands/engine";

export interface InfraStepDefinition {
  readonly id: string;
  readonly outputState: string;
  readonly dependsOn: readonly string[];
  readonly leadTimeWeeks: readonly [number, number];
  readonly crossLink?: string;
}

function loadInfraSteps(): readonly InfraStepDefinition[] {
  const raw = YAML.parse(readFileSync(resolve(process.cwd(), "docs/state-machines.yaml"), "utf8")) as {
    machines: {
      SM_3_infra_program: {
        steps: {
          id: string;
          output_state: string;
          depends_on: string[];
          lead_time_weeks: [number, number];
          cross_link?: string;
        }[];
      };
    };
  };
  return Object.freeze(
    raw.machines.SM_3_infra_program.steps.map((s) =>
      Object.freeze({
        id: s.id,
        outputState: s.output_state,
        dependsOn: Object.freeze([...s.depends_on]),
        leadTimeWeeks: Object.freeze([s.lead_time_weeks[0], s.lead_time_weeks[1]] as const),
        crossLink: s.cross_link,
      }),
    ),
  );
}

export const INFRA_STEPS_DAG: readonly InfraStepDefinition[] = loadInfraSteps();

export function computeCriticalPath(completedSteps: ReadonlySet<string>): {
  readonly path: readonly string[];
  readonly maxWeeks: number;
} {
  const stepById = new Map(INFRA_STEPS_DAG.map((s) => [s.id, s] as const));
  const memo = new Map<string, { path: string[]; maxWeeks: number }>();

  function bestTo(stepId: string): { path: string[]; maxWeeks: number } {
    const cached = memo.get(stepId);
    if (cached) return cached;
    const step = stepById.get(stepId)!;
    const ownWeeks = completedSteps.has(stepId) ? 0 : step.leadTimeWeeks[1];
    if (step.dependsOn.length === 0) {
      const res = { path: completedSteps.has(stepId) ? [] : [stepId], maxWeeks: ownWeeks };
      memo.set(stepId, res);
      return res;
    }
    let bestDep: { path: string[]; maxWeeks: number } = { path: [], maxWeeks: -1 };
    for (const dep of step.dependsOn) {
      const candidate = bestTo(dep);
      if (candidate.maxWeeks > bestDep.maxWeeks) {
        bestDep = candidate;
      }
    }
    const res = {
      path: completedSteps.has(stepId) ? [...bestDep.path] : [...bestDep.path, stepId],
      maxWeeks: bestDep.maxWeeks + ownWeeks,
    };
    memo.set(stepId, res);
    return res;
  }

  let overallBest: { path: string[]; maxWeeks: number } = { path: [], maxWeeks: 0 };
  for (const s of INFRA_STEPS_DAG) {
    const candidate = bestTo(s.id);
    if (candidate.maxWeeks > overallBest.maxWeeks) {
      overallBest = candidate;
    }
  }
  return { path: Object.freeze(overallBest.path), maxWeeks: overallBest.maxWeeks };
}

export interface InfrastructureServiceOptions {
  connectionString: string;
  schema: string;
  authorization: AuthorizationPort;
  clock: () => Date;
}

export interface InfrastructureServicePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createInfraStep(
    credential: unknown,
    input: { aggregateId: string; projectId: string; stepCode: string; scope: ScopeBinding },
  ): Promise<void>;
  createInfraProgram(
    credential: unknown,
    input: { aggregateId: string; projectId: string; scope: ScopeBinding },
  ): Promise<void>;
  transitionInfrastructure(
    credential: unknown,
    input: {
      aggregateId: string;
      transitionId: string;
      scope: ScopeBinding;
      payload: Record<string, JsonValue>;
      approvals?: readonly ApprovalFact[];
    },
  ): Promise<CommandResult>;
  computeDualControlBinding(input: {
    aggregateId: string;
    transitionId: string;
    scope: ScopeBinding;
    payload: Record<string, JsonValue>;
  }): Promise<{ commandHash: string; scopeHash: string; dependencyEpoch: number }>;
}

const { version: CONTRACT_VERSION, transitions: ALL_TRANSITIONS } = loadMachineDefinitions();
const DOMAIN_MACHINES = new Set(["SM_3_infra_step", "SM_3_infra_program"]);
const DOMAIN_TRANSITIONS = ALL_TRANSITIONS.filter((t) => DOMAIN_MACHINES.has(t.machineId));
const RULE_BY_ID = new Map(DOMAIN_TRANSITIONS.map((r) => [r.id, r] as const));

const asRecord = (payload: JsonValue): Record<string, JsonValue> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : {};

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const validDateStr = (v: unknown): boolean =>
  typeof v === "string" && v.trim().length > 0 && Number.isFinite(Date.parse(v));

export function createInfrastructureService(
  options: InfrastructureServiceOptions,
): InfrastructureServicePort {
  const { connectionString, schema, authorization, clock } = options;
  const pool = new Pool({ connectionString, max: 6 });
  let pendingApprovals: readonly ApprovalFact[] | undefined;
  let retryNonce = 0;

  const guards: Record<string, (input: { payload: JsonValue }) => unknown> = {
    // SM_3_infra_step
    all_dependencies_approved_or_waived: ({ payload }) => asRecord(payload).allDependenciesApprovedOrWaived === true,
    owner_assigned: ({ payload }) => asRecord(payload).ownerAssigned === true,
    required_inputs_listed: ({ payload }) => asRecord(payload).requiredInputsListed === true,
    step_package_complete: ({ payload }) => asRecord(payload).stepPackageComplete === true,
    authority_receipt_captured: ({ payload }) => asRecord(payload).authorityReceiptCaptured === true,
    valid_evidence_captured: ({ payload }) => asRecord(payload).validEvidenceCaptured === true,
    output_state_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).outputStateRecorded),
    rejection_reason_recorded: ({ payload }) => nonEmptyStr(asRecord(payload).rejectionReasonRecorded),
    corrections_recorded: ({ payload }) => asRecord(payload).correctionsRecorded === true,
    executive_approval_recorded: ({ payload }) => asRecord(payload).executiveApprovalRecorded === true,
    authority_written_confirmation: ({ payload }) => asRecord(payload).authorityWrittenConfirmation === true,
    review_date_recorded: ({ payload }) => validDateStr(asRecord(payload).reviewDateRecorded),

    // SM_3_infra_program
    at_least_one_step_ready: ({ payload }) => asRecord(payload).atLeastOneStepReady === true,
    critical_step_blocked_or_rejected: ({ payload }) => asRecord(payload).criticalStepBlockedOrRejected === true,
    blocking_step_resolved: ({ payload }) => asRecord(payload).blockingStepResolved === true,
    all_steps_approved_or_waived: ({ payload }) => asRecord(payload).allStepsApprovedOrWaived === true,
    final_signoff_evidence_captured: ({ payload }) => asRecord(payload).finalSignoffEvidenceCaptured === true,
  };

  const payloadValidators: Record<string, (payload: JsonValue) => boolean> = Object.fromEntries(
    DOMAIN_TRANSITIONS.map((t) => [t.id, (p: JsonValue) => typeof p === "object" && p !== null && !Array.isArray(p)]),
  );

  const engine = createCommandEngine({
    connectionString,
    schema,
    authorization,
    transitions: ALL_TRANSITIONS,
    guards,
    payloadValidators,
    clock,
    loadAuthorizationFacts: async () => (pendingApprovals ? { approvals: pendingApprovals } : undefined),
  });

  async function ensureSeededAggregate(
    credential: unknown,
    machineId: string,
    initialState: string,
    aggregateId: string,
    projectId: string,
    scope: ScopeBinding,
  ) {
    const principal = await authorization.resolve(credential, clock());
    if (!principal) throw new Error("UNAUTHENTICATED");
    const normScope = normalizeScope(scope);
    const scopeHash = canonicalHash(normScope);
    await pool.query(
      `INSERT INTO "${schema}".projects (tenant_id, project_id, dependency_epoch)
       VALUES ($1, $2, 0)
       ON CONFLICT (tenant_id, project_id) DO NOTHING`,
      [principal.tenantId, projectId],
    );
    const projRes = await pool.query<{ dependency_epoch: number }>(
      `SELECT dependency_epoch FROM "${schema}".projects WHERE tenant_id = $1 AND project_id = $2`,
      [principal.tenantId, projectId],
    );
    const epoch = projRes.rows[0]?.dependency_epoch ?? 0;
    await pool.query(
      `INSERT INTO "${schema}".aggregates (
        tenant_id, aggregate_id, project_id, machine_id, contract_version, scope, scope_hash, state, version, dependency_epoch
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 0, $9)`,
      [
        principal.tenantId,
        aggregateId,
        projectId,
        machineId,
        CONTRACT_VERSION,
        JSON.stringify(normScope),
        scopeHash,
        initialState,
        epoch,
      ],
    );
  }

  async function getAggregateExpected(aggregateId: string): Promise<{ version: number; epoch: number }> {
    const res = await pool.query<{ version: number; project_id: string; tenant_id: string }>(
      `SELECT version, project_id, tenant_id FROM "${schema}".aggregates WHERE aggregate_id = $1 LIMIT 1`,
      [aggregateId],
    );
    if (res.rowCount === 0) return { version: 0, epoch: 0 };
    const { version, project_id, tenant_id } = res.rows[0];
    const proj = await pool.query<{ dependency_epoch: number }>(
      `SELECT dependency_epoch FROM "${schema}".projects WHERE tenant_id = $1 AND project_id = $2`,
      [tenant_id, project_id],
    );
    const epoch = proj.rows[0]?.dependency_epoch ?? 0;
    await pool.query(
      `UPDATE "${schema}".aggregates SET dependency_epoch = $1 WHERE tenant_id = $2 AND aggregate_id = $3`,
      [epoch, tenant_id, aggregateId],
    );
    return { version, epoch };
  }

  async function buildEnvelope(input: {
    aggregateId: string;
    transitionId: string;
    scope: ScopeBinding;
    payload: Record<string, JsonValue>;
  }): Promise<CommandEnvelope> {
    const rule = RULE_BY_ID.get(input.transitionId);
    if (!rule) throw new Error(`Unknown infrastructure transition ${input.transitionId}`);
    const { version, epoch } = await getAggregateExpected(input.aggregateId);
    const normScope = normalizeScope(input.scope);
    return {
      commandId: randomUUID(),
      commandName: rule.event,
      aggregateId: input.aggregateId,
      transitionId: rule.id,
      idempotencyKey: `${input.aggregateId}:${rule.id}:v${version}:e${epoch}:n${retryNonce}`,
      contractVersion: CONTRACT_VERSION,
      expected: { aggregateVersion: version, dependencyEpoch: epoch },
      scope: normScope,
      payload: input.payload,
    };
  }

  return {
    async initialize() {
      await engine.initialize();
    },

    async close() {
      await engine.close();
      await pool.end();
    },

    async createInfraStep(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_3_infra_step",
        "BLOCKED",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async createInfraProgram(credential, input) {
      await ensureSeededAggregate(
        credential,
        "SM_3_infra_program",
        "NOT_STARTED",
        input.aggregateId,
        input.projectId,
        input.scope,
      );
    },

    async transitionInfrastructure(credential, input) {
      const envelope = await buildEnvelope(input);
      pendingApprovals = input.approvals;
      try {
        const result = await engine.execute(credential, envelope);
        if (!result.ok) retryNonce += 1;
        else retryNonce = 0;
        return result;
      } finally {
        pendingApprovals = undefined;
      }
    },

    async computeDualControlBinding(input) {
      const env = await buildEnvelope(input);
      const commandHash = canonicalHash({
        commandName: env.commandName,
        aggregateId: env.aggregateId,
        transitionId: env.transitionId,
        idempotencyKey: env.idempotencyKey,
        contractVersion: env.contractVersion,
        expected: env.expected,
        scope: env.scope,
        payload: env.payload,
      });
      const scopeHash = canonicalHash(env.scope);
      return {
        commandHash,
        scopeHash,
        dependencyEpoch: env.expected.dependencyEpoch,
      };
    },
  };
}
