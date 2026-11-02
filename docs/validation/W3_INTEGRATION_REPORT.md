# W3 integration report — domain permitting state machines

**Date:** 2 November 2026  
**Outcome:** All four Wave 3 domain tasks (`DOMAIN-001`, `DOMAIN-002`, `DOMAIN-003`, and `DOMAIN-004`) are accepted for local/synthetic development. Every domain state machine executes through the atomic `SERIALIZABLE` PostgreSQL command engine (`createCommandEngine`) and shared `AuthorizationPort`.

## Accepted W3 domain artifacts

| Task | Machines | Artifacts | Verification |
|---|---|---|---|
| `DOMAIN-001` | `SM_1_masterplan`, `SM_1_condition`, `SM_11_baseline_change` | `src/domain/masterplan/index.ts`, `tests/integration/masterplan/{masterplan,condition,baseline-change}.test.ts` | 3 files / 4 PostgreSQL integration tests pass |
| `DOMAIN-002` | `SM_2A_registration`, `SM_2B_entity`, `SM_2B_case`, `SM_2C_soil_work`, `SM_2D_soil_report` | `src/domain/meps/index.ts`, `tests/integration/meps/{registration,clearance-entity,clearance-case,soil-work,soil-report}.test.ts` | 5 files / 6 PostgreSQL integration tests pass |
| `DOMAIN-003` | `SM_2D_workstream`, `SM_2E_full_permit`, `SM_2F_appointments`, `SM_5_comment`, `SM_6_bundle` | `src/domain/packages/index.ts`, `src/domain/comments/index.ts`, `src/domain/bundles/index.ts`, `tests/integration/packages/{workstream,full-permit,appointments,comment,bundle}.test.ts` | 5 files / 5 PostgreSQL integration tests pass |
| `DOMAIN-004` | `SM_3_infra_step`, `SM_3_infra_program`, `SM_4_third_party`, `SM_7_risk` | `src/domain/infrastructure/index.ts`, `src/domain/third-party/index.ts`, `src/domain/risks/index.ts`, `tests/integration/infrastructure/{infra-step,infra-program,third-party,risk}.test.ts` | 4 files / 4 PostgreSQL integration tests pass |

## Key domain invariants verified

- **Attachment 1 24-condition freeze gate (`SM_1_masterplan`):** `SM1-T02` and `SM1-T04` fail closed when only 11 conditions are present; no missing conditions are fabricated.
- **Sixteen-entity site clearance (`SM_2B_entity` / `SM_2B_case`):** 13 required entities + 3 not-required seeds (`ADPC_PORTS`, `ENEC`, `ZONES_CORP`), active (`B2-SC-A-2026-001625`) and legacy (`B2-SC-A-2026-001525`) reference lineage, `ADSSC` (`ADSCC` alias) and `ADMCC` (`MCC` alias), `TAQA_WATER` conflict quarantine (`CONFLICT_APPROVED_VS_COMMENTS`), pre-project linkage, and dual-control government exemption.
- **Active third-party inspection lock (`SM_4_third_party` / `SM_2D_soil_report`):** `DMT/PAS/OUT/2026/8415` (`APPOINTMENT_UNDER_PROCESS`) and `DMT_LICENSING_APPROVED` keep technical plan review, inspection, and soil stamps locked until `INSPECTION_ACTIVE` (`S4-T05`).
- **Package I coordinated full building permit (`SM_2E_full_permit`):** enforces all 12 release-gate prerequisites and fails closed on standalone fallback (`fallback_adm_direction_if_standalone`).
- **Step 05 contractor permit issuance (`SM_2F_appointments`):** remains `BLOCKED` until Step 04 is `APPROVED`; requires `contractor_is_issuing_party` on `S2F-T04`; contractors cannot close authority comments (`SM_5_comment`).
