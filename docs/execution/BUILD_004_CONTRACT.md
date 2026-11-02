# BUILD-004 — Evidence vault and reliance lifecycle foundation

**Status:** approved bounded local/synthetic dispatch. No live object storage, scanner, authority communication or hosted extraction.
**Owner:** Luna evidence agent; independent reviewer/integration owner: lead.
**Sources:** IMPORT_EVIDENCE_RBAC_SPEC.md, SPEC_DECISIONS.md, COMMAND_SCHEMA_SPEC.md, YAML v1.2 behavioral_contract, shared types `src/contracts/foundation.ts`.

## Ownership and interface

Write only `src/domain/evidence/**`, `tests/integration/evidence/**`, `docs/validation/TDD_BUILD_004_REPORT.md`. Lead owns shared types, package/lock, configuration and docs/backlog. Do not edit command-engine, authorization, application routes or CI. No recursive agents; one repair maximum.

Export `createEvidenceService({ database, clock, storage, scan, authorization })` returning a server-only evidence lifecycle port. It must consume the shared `AuthorizationPort` and `ScopeBinding` types. No permissive defaults. No direct HTTP route. No live object-storage client; use an injected adapter. No hosted document extraction unless explicitly approved.

## Required behavior

- **Evidence version identity:** immutable `evidence_id` + `version`, content SHA-256, media/type metadata, uploader identity, signer identity (nullable), issuer identity (nullable), source/provenance, created time, validity interval and scan status. Append-only; no overwrite of content or metadata. New bytes = new version.
- **Validation:** independent `ValidateEvidence` command using the shared authorization port. Validation binds immutable evidence version/hash/class/project/scope, validator identity, verified assignment/credential IDs and versions, verdict, reason and timestamp. Regulated classes require uploader != validator, current assignment, matching scope and class-specific role. Uploader self-validation denied. Generic metadata entry is not validation.
- **Reliance:** separate `reliance_evaluation` append-only records with status `PENDING`, `VERIFIED`, `SCOPE_MISMATCH`, `EXPIRED`. Conflict and quarantine are validation/reason fields, not replacement reliance statuses. Current reliance is a projection over latest valid evaluation plus current dependency epoch. Expired, superseded, revoked, conflicted, scope-mismatched or unverified evidence cannot satisfy a gate.
- **Scope binding:** every gate snapshot binds project, package, plots, scope version, design revision, requirement snapshot, evidence-version IDs and dependency epoch. Shared evidence requires explicit verified coverage for every binding. No inferred coverage.
- **Revalidation:** material dependency change (expiry, revocation, suspension, scope/design/requirement change, evidence supersession, exemption revocation) increments epoch atomically and sets revalidation `REQUIRED`. Historical authority fact may be recorded as quarantined reliance; it does not claim dashboard authorization. Recovery requires fresh independent verification and current gate evaluation. Never rewrite authority state or legally revoke/suspend a permit automatically.
- **Expiry:** use injected clock at command commit, not timer delivery. Expiry crossing injected boundary denies immediately.
- **Document lifecycle:** scan → extract → validate → active → expiring → expired → superseded/rejected. Scan clean required for activation. Quarantined documents block as evidence. Expired evidence cannot pass gate. Superseded versions remain auditable; reliance does not inherit.
- **Admin correction:** append superseding assertion; preserve original, reason, source/replacement/actor/time/evidence links. No direct state edit. Regulated correction requires independent approval and ordinary gate recomputation. Corrections cannot waive a gate.
- **Dual control:** two distinct eligible human identities with required roles approving same canonical command hash, scope hash and dependency/evidence versions. One person with two roles fails. Any changed input invalidates pending approvals.

## Verification / TDD

Write tests first, record actual RED, then implementation/GREEN and regression. Cover: evidence version identity and content hash; scan quarantine; validation independence and self-validation denial; regulated class role policy; scope mismatch and shared evidence coverage; expiry at injected clock boundary; reliance evaluation append-only and projection; material dependency change epoch invalidation; supersession non-inheritance; admin correction append-only; dual control distinct identities; no gate satisfaction from unverified/expired/conflicted/scope-mismatched evidence; no external I/O in command transaction.

Test paths: `tests/integration/evidence/*.test.ts`. Report actual RED/GREEN, DB version, commands, test counts, deferred work and unresolved risks. Lead independently reruns before acceptance. No tests executed yet = no claim.
