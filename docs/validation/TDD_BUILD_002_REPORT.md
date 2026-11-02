# BUILD-002 validation report

**Date:** 2 November 2026  
**Scope:** Persistence, schema parity, and atomic command execution foundation (`src/db/**`, `src/domain/commands/engine.ts`, `tests/integration/commands/**`). No HTTP command endpoint or live workflow release.

## TDD and verification

- Initial RED before implementation: the scoped Vitest suite failed at import time because `engine.ts` did not exist.
- Expanded RED matrix before behavioral fixes: real-PostgreSQL acceptance cases were added across `tests/integration/commands/engine.test.ts` (40 tests), `tests/integration/commands/schema.test.ts` (6 tests), and `tests/integration/foundation-seam.test.ts` (7 tests).
- Final GREEN run against disposable PostgreSQL 16 (`postgres:16.4-alpine` via `npm run test:database`):
  - `tests/integration/commands/engine.test.ts`: **40 passed**
  - `tests/integration/commands/schema.test.ts`: **6 passed**
  - `tests/integration/foundation-seam.test.ts`: **7 passed**

## Implemented boundary

Foundational Drizzle table definitions (`src/db/schema.ts`), versioned SQL migration (`src/db/migrations/0001_command_foundation.sql`), and checksum-verified migration runner (`src/db/migrate.ts`) cover project dependency epochs, scoped aggregates, idempotency records, transition commits, domain events, append-only audit ledger, transactional outbox, handler receipts, and `schema_migrations`.

The command engine (`src/domain/commands/engine.ts`) implements:

- `SERIALIZABLE` PostgreSQL transactions with bounded retry on `40001` / `40P01`
- Transaction-bound identity resolution and re-verification via the shared `AuthorizationPort`
- Deterministic advisory lock on `(tenant_id, actor_id, idempotency_key)` before aggregate row locks
- Canonical semantic command hashing (excluding `commandId`, normalizing unordered plot/evidence sets, excluding expected-version metadata from semantic equivalence)
- Strict boolean `=== true` evaluation over registered guards; missing, false, non-boolean, or throwing guards fail closed
- Optimistic aggregate version and project dependency epoch checks
- Multi-event per-version sequencing and registered conditional outbox emission rules
- Immutable database triggers rejecting `UPDATE` and `DELETE` on `audit_ledger`, `domain_events`, `transition_commits`, and `idempotency_records`
- Deeply frozen source transition registry validated against `docs/state-machines.yaml` (20 machines / 173 transitions)

## Limitations

Synthetic protocol and persistence verification does not constitute regulatory guard implementation or production release readiness. Domain workflow guards, evidence vault lifecycle (`BUILD-004`), and external adapters remain separate gated tasks.
