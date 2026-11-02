# BUILD-004 validation report

**Date:** 2 November 2026  
**Scope:** Evidence vault, `SM_10_document` lifecycle, reliance evaluation, package gate snapshots, revalidation overlay, and append-only admin corrections (`src/domain/evidence/**`, `tests/integration/evidence/**`). No live object storage, external malware scanner, authority communication, or hosted DREX extraction.

## TDD and verification

- **Initial module-resolution RED:** `npm run test:database -- --pattern tests/integration/evidence` failed with 5 failed suites (`Cannot find module '../../../src/domain/evidence'`) before `src/domain/evidence` existed.
- **Behavioral assertion RED:** against the minimal placeholder interface in `src/domain/evidence/index.ts`, `npm run test:database -- --pattern tests/integration/evidence` collected 5 suites and **failed 12 of 12 behavioral assertions** across `document.test.ts`, `reliance.test.ts`, `gate-snapshot.test.ts`, `correction.test.ts`, and `revalidation-overlay.test.ts`.
- **Implementation & GREEN:** after implementing `src/domain/evidence/vault.ts` and expanding `tests/integration/evidence/document.test.ts`, `npm run test:database -- --pattern tests/integration/evidence` passed **5 test files / 14 integration tests** against disposable PostgreSQL 16 (`postgres:16.4-alpine`), and the full database integration suite passed **9 test files / 97 tests**.

## Implemented boundary

- **Evidence version identity (`evidence_versions`):** immutable `(tenant_id, evidence_id, version)`, SHA-256 `content_hash` verification, media-type and byte-size checks, uploader/recorder/signer/issuer provenance, validity intervals, and `BEFORE UPDATE OR DELETE` PostgreSQL triggers rejecting mutation (`IMMUTABLE_TABLE_MUTATION_FORBIDDEN`).
- **Zero external I/O inside DB transactions:** injected `storage.putObject` and `scan.scanObject` adapters run strictly outside `SERIALIZABLE` PostgreSQL transactions (`service.isInTransaction() === false` verified in tests).
- **`SM_10_document` lifecycle (`S10-T01`..`S10-T10`):** YAML-driven transition rules covering `UPLOADED`, `SCANNING`, `QUARANTINED`, `EXTRACTED`, `VALIDATED`, `ACTIVE`, `EXPIRING`, `EXPIRED`, `REJECTED`, and `SUPERSEDED`; DREX mode remains `"OFF"` (`hostedExtractionCalled: false`); `S10-T07` (`EXPIRE`) and `S10-T10` (`SUPERSEDE`) atomically increment project `dependency_epoch` and set `revalidation_status = 'REQUIRED'`; superseded versions remain auditable and reliance never auto-inherits to replacement versions.
- **Independent regulated validation & structural stamps:** consumes shared `AuthorizationPort`; enforces `uploaderId !== validatorId`, class-specific validator roles (`STAKEHOLDER_MANAGER` for `AUTHORITY_APPROVAL`/`NOC`/`LEGAL_AUTHORIZATION`/`EXEMPTION`/`WAIVER`; `THIRD_PARTY_INSPECTOR` with `INSPECTION_ACTIVE` and current version for `STAMPED_TECHNICAL_DOCUMENT`), separate authority fact recording (`recordAuthorityFact`), and distinct uploader/signer/validator/recorder stamp recording (`recordTechnicalStamp`).
- **Reliance & gate snapshots:** append-only `reliance_evaluations` (`PENDING`, `VERIFIED`, `SCOPE_MISMATCH`, `EXPIRED`) with structured `quarantined` and `conflict_detected` fields; explicit verified scope coverage required for shared evidence across packages, plots, or revisions; `createGateSnapshot` rejects `PROJECT_SCOPE` and `PROVISIONAL_PLOT_SCOPE`; `evaluateGateEligibility` synchronously rechecks current `dependency_epoch` and injected `clock()` expiry before allowing gated progression.
- **Revalidation overlay & admin corrections:** `processRelianceInvalidatedEvent` deduplicates by `(tenant_id, handler_name, event_id)`, increments `dependency_epoch`, and sets `revalidation_status = 'REQUIRED'` while preserving historical authority status; `appendAdminCorrection` enforces `SYSTEM_ADMIN`, preserves original assertions, blocks direct state edits (`DIRECT_STATE_EDIT_FORBIDDEN`), and requires independent dual-control approval and ordinary evidence validation before clearing gates.

## Verification commands

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass (0 errors, 0 warnings) |
| `npm run test` | 4 unit tests pass |
| `npm run test:database -- --pattern tests/integration/evidence` | **5 files / 14 tests pass** |
| `npm run test:database` | **9 files / 97 tests pass** |

## Limitations

Local/synthetic verification only. Live S3-compatible storage, ClamAV/managed malware scanning, Azure AD identity verification, live MEPS/tracker extracts, and authority-confirmed Sprint 0 inputs remain gated under `LIVE_EVIDENCE`, `HOSTING_POLICY`, and `RELEASE_SIGNOFF`.
