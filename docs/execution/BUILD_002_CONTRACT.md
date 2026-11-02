# BUILD-002 — Persistence and atomic command foundation

**Status:** approved bounded local/synthetic dispatch. No HTTP command endpoint or live workflow release.  
**Owner:** Luna command-engine agent; independent reviewer and integration owner: lead.  
**Sources:** COMMAND_SCHEMA_SPEC.md, SPEC_DECISIONS.md, state-machines.yaml v1.2; shared types `src/contracts/foundation.ts`.

## Ownership and interface

Write only `src/db/**`, `src/domain/commands/**`, `tests/integration/commands/**`, `docs/validation/TDD_BUILD_002_REPORT.md`. Lead owns shared types, package/lock, Vitest/TypeScript/CI configuration and docs/backlog. Do not edit auth code or application routes. One repair maximum, no subagents.

Export a server-only library factory `createCommandEngine` using a PostgreSQL pool, mandatory `AuthorizationPort`, reviewed machine definitions, server-owned guard registry, injected clock and optional server-owned authorization-fact loader. No permissive defaults. Export `loadMachineDefinitions` to normalize the local YAML into pinned machine definitions/TransitionRule values; unknown/malformed definitions fail closed. The implementation may define exact factory types under its own scope, but must consume the shared authorization port unchanged.

`execute(credential, command)` accepts a strict envelope: `commandId`, `commandName` (matches selected transition event), `aggregateId`, `transitionId`, `idempotencyKey`, `contractVersion`, `expected: {aggregateVersion, dependencyEpoch}`, `scope`, `payload` (finite canonicalizable JSON). No actor/roles/guard results or authorization approvals are accepted from the caller envelope. Authorization facts are loaded by a trusted callback using the transaction/client; missing required facts deny. Session resolution is refreshed in the transaction before eligibility commit and bound to the same actor/tenant as the initial authenticated lookup.

Existing aggregates are initialized by **test fixtures** for this task; production aggregate creation, evidence tables/lifecycle and domain guards belong to later bounded contracts. Implement foundational Drizzle schema plus versioned SQL migration for projects, scope/aggregate state, dependency epochs, idempotency, transition commits, events, append-only ledger, immutable outbox and handler receipts. Track any deferred full-schema groups explicitly; do not claim all evidence/domain tables or business guards are implemented. Immutable audit/event/outbox content must reject UPDATE/DELETE in real PostgreSQL; delivery metadata belongs separately. State-writing functions remain internal to the guarded executor, not exported bypass helpers.

## Required behavior

- Select aggregate by tenant **and** ID; bind scope to persisted normalized scope/hash, machine and contract version. No caller can choose another tenant/package through matching role alone.
- Resolve registry transition from server data, validate current from/event/to, registered payload validation and every local guard. Missing, false, unknown or throwing guard fails closed. No `payload.guards`/`approved=true` bypass. Runtime domain guards remain unavailable by default; synthetic all-true guards live only in tests.
- Canonical hashing uses the pinned RFC 8785 `canonicalize` package; reject non-JSON/nonfinite/cyclic/ambiguous input. Sort set-like scope IDs before hashing, reject duplicates/empty required IDs; role context never comes from payload.
- SERIALIZABLE transaction and deterministic locks: idempotency advisory key; project/scope; aggregate; dependency epoch; dependent facts/assignments/approvals. Refresh trusted identity/context under the transaction. Bound serialization/deadlock retries to three; no unbounded retry.
- Idempotency uniqueness `(tenant,actor,key)` includes command identity/scope/versions/payload in semantic hash. Same semantic retry replays original result/event IDs, with replay metadata only; cross-command/key mismatch conflicts. Authenticate and scope-authorize even replay; replay is history, not a fresh eligibility token.
- Expected aggregate version and current dependency epoch must match at commit. Project-wide epoch invalidation is acceptable as a conservative foundation policy; document its broader invalidation/performance cost. Provisional scopes remain separate and cannot satisfy package gates.
- Update state/version, transition record, event(s), ledger, outbox and stored idempotency result atomically. Multiple events use sequence per aggregate version. No external I/O in a command transaction.
- Reviewed `invalidatesDependencies` metadata, never caller payload flags, increments epoch atomically. Race tests prove either the action commits before invalidation or stale action is denied. No historical authority state is legally revoked.
- Error paths roll back success-side writes. Minimal denial audit may be separate; do not persist success on failure. Fault-injection hooks are server-owned test configuration, never request payload.

## Verification / TDD

Real disposable PostgreSQL 16 is required. Lead created a labeled temporary container, tmpfs data, loopback ephemeral port and synthetic test-only credentials; workers may use only the supplied test URL. Never connect to a production/shared DB or execute broad resets. Give tests their own random schema and clean up only that schema; validate the explicit test database name before DDL. No skipped/mocked DB tests may count as acceptance.

Write tests and run RED before implementation; record assertion failures beyond missing imports where feasible. GREEN tests must include: authorized commit; all denied/unknown/throwing/missing guards; tenant/scope mismatch; stale version/epoch; same-key sequential/concurrent replay; same-key different payload/command; racing writers; injected failures after each write; two events in one version; append-only update/delete rejection; invalidation race; replay after epoch change as history only; authorization/fact callback failure; no mutation from forged payload privileges. Assert DB state and event/ledger/outbox/idempotency counts, not only returned booleans.

Tests run through lead-provided Vitest integration configuration with `TEST_DATABASE_URL`; absent DB must fail rather than skip. Synthetic protocol coverage is not business-guard/regulatory coverage. Report actual RED/GREEN, PostgreSQL/version, commands, test counts, deferred work and any unresolved risks. Lead independently reruns before acceptance.
