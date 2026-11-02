# W1 software-contract decisions

**Date:** 2 November 2026  
**Contract:** `state-machines.yaml` v1.2 — **20 machines / 173 transitions**, unchanged topology.  
**Authority:** Engineering decisions only. Client/AOR facts and live approval gates are not resolved by this document.

## Decision boundary

The top-level `behavioral_contract` is mandatory in addition to local transition guards. Machine state records workflow history; current eligibility is a separately computed, version-bound permission. A stored `READY` or `APPROVED` value is never sufficient to authorize a later action. Unknown facts fail closed. Historical authority facts can still be recorded for audit, but remain unavailable for downstream reliance until independently verified.

These decisions allow specifications, synthetic fixtures and local development to proceed. They do not activate a permit, supply the missing DMP conditions, approve a legal entity or authorize hosted document processing. The existing regulatory decision register remains open.

## GAP dispositions

| Gap | Software decision | Remaining human/external input |
|---|---|---|
| GAP-01 | Add orthogonal `revalidation_status = CLEAR / REQUIRED`. Invalidate dependency epochs on any material dependency change. Block new gated actions immediately; retain original authority status and documents. Never automatically legally suspend/revoke an issued permit. | AOR determines legal consequences and external authority actions for already-issued permits; show urgent review/action notice meanwhile |
| GAP-02 | Preserve the plan's conservative lock: plan review and inspection both require `INSPECTION_ACTIVE`, matching scope and current assignment. Licensing approval enables the activation form only. | Any narrower/different official scope rule needs evidenced AOR approval and a versioned amendment |
| GAP-03 | `track`, catalogue membership and `seed_status` are descriptive, never applicability or executable state. Use versioned package requirement snapshots. EAD-only 03A does not waive soil/structure/clearance full-permit prerequisites. Unknown applicability blocks the affected gate. | Live MEPS list and package applicability signed/verified by AOR |
| GAP-04 | Separate recording from evidence validation. AOR may record a reported authority approval; only a different eligible validator can make regulated evidence usable. Aggregation checks independently verified reliance, not the recording actor alone. | Named authorized validators and scopes |
| GAP-05 | Every gate snapshot binds project, package, plots, scope version, design revision, requirement snapshot and evidence-version IDs. Shared evidence requires explicit verified coverage for each binding. | Signed package/building/plot scope and accepted revisions |
| GAP-06 | Admin corrections append superseding assertions; preserve originals, reason, links and audit. No direct state edits. Regulated corrections require independent approval and ordinary gate recomputation. | Documentary proof for factual correction; no administrative authority waiver |
| GAP-07 | Outbox messages carry immutable producer/version/scope/epoch metadata. Unlock handlers recompute from current committed facts; dedupe by handler + event ID. Unregistered producer/schema combinations are disabled. | Delivery configuration and production integration approvals |
| GAP-08 | Store technical signer, recorder, uploader and validator identities separately. Require assigned credentialed signer and current authorization/version at commit. An AOR may record another party's signed stamp, never manufacture the technical act. | Signed evidence, credentials, assignment and final appointment approval |
| GAP-09 | Independent validation is mandatory for regulated approval/NOC, stamped technical document, legal authorization, exemption and waiver classes. Uploader differs from validator; structural validation requires a credentialed assigned third-party inspector. | A different eligible inspector is needed if an inspector uploads and would otherwise self-validate; missing staffing remains blocked |
| GAP-10 | Keep preparatory fallback execution **disabled pending a separate reviewed contract** and recorded ADM direction. Full Step 04 accepts coordinated route only. | ADM direction and separately reviewed preparatory command/scope; never treat preparatory output as permit approval |

## Dependency invalidation and concurrency contract

1. A material change (expiry, revocation, suspension, scope/design/requirements change, evidence supersession or exemption revocation) increments the applicable project/scope dependency epoch in the **same transaction** as the fact change.
2. Gate evaluations bind that epoch and exact dependency versions. A changed epoch invalidates old evaluations immediately even if asynchronous projection work has not run. Expiry is also tested against the injected current clock at command time; delayed timers cannot extend evidence validity.
3. Commands for release, submit/resubmit, stamp recording, issuance recording, activation, technical sign-off and construction-start eligibility read a coherent set of current dependencies within the command transaction. Lock/version-check their scope and authorization rows in deterministic order so revocation cannot race a stale successful commit.
4. The rule denies a **new eligible action**, not preservation of an already-occurred external fact. Importing a historical receipt/authority approval creates a quarantined assertion if current prerequisites cannot be proved. It cannot retroactively assert that the dashboard authorized the action.
5. Background events materialize warnings/revalidation projections. They never blindly set an unlock boolean from an old event payload. Restore eligibility only through fresh applicable evidence validation and current gate evaluation; this does not rewrite immutable history.
6. No software event can unilaterally revoke or suspend an authority-issued permit. Display `REQUIRED` revalidation, preserve its recorded status and escalate to AOR/Client for legal direction.

## Evidence and dual-control semantics

- Evidence-class validation is server-side. Generic document metadata entry is not regulated validation and cannot activate reliance.
- Authority approvals/NOCs: independent `STAKEHOLDER_MANAGER` validator with matching project/scope. Structural stamped documents: independent `THIRD_PARTY_INSPECTOR`, assigned and credentialed for that work. Other regulated legal/exemption/waiver validation uses the Stakeholder Manager's evidence role, in addition to any specific executive/authority requirements.
- These role mappings are application policy, not proof that a named person is legally/client-authorized. A verified named validator assignment and scope are mandatory; unresolved assignments keep regulated evidence unusable.
- `AOR_LEAD` in a transition's role list permits recording or non-regulated metadata validation only; it does not override the evidence-class policy. Neither `SYSTEM_ADMIN` nor `CLIENT_EXECUTIVE` receives blanket technical validation permission.
- Uploader and validator must differ for regulated evidence. Signer/recorder are separate identity fields, not a requirement that they always be different people; the signer may upload their own signed act, but a different eligible validator must verify it. If none is available, remain blocked.
- Dual control requires two distinct eligible human identities, including required role combinations, approving the **same canonical command hash, scope, evidence and dependency versions**. One person with two roles does not qualify. Changing a fact invalidates pending approvals.
- Exact participant pairs for all ten flagged transitions are pinned in `behavioral_contract.evidence_validation.dual_control_role_pairs`. Government exemption always includes a Client Executive plus Stakeholder Manager or System Admin. The risk-acceptance transition lists only `CLIENT_EXECUTIVE`, so its existing dual-control flag conservatively requires **two different eligible executives**; one executive cannot satisfy it. Availability of named approvers is an external staffing input, not permission to remove the flag.
- Document activation is not proof that a particular package may rely on it. Scan/hash/type checks, evidence validation and package reliance each have separate records.

## Event and external-I/O contract

- Required envelope fields are declared in the YAML. Exact event schemas and the producer registry are deliverables of `COMMAND_SCHEMA_SPEC.md`; an event lacking a reviewed producer/schema cannot execute handlers.
- A producer may be a declared transition, a versioned fact command (scope/evidence/requirements), a fake-clock-compatible scheduler or the isolated DREX adapter. Every registry row must name which, and its tested dedupe/version behavior.
- Existing effect names such as `submit_coordinated_transaction` and `notify_authority` describe dashboard recording/internal follow-up only in v1. They do **not** authorize MEPS/TAMM write-back, submission, authority email dispatch or fee processing. External-authority communication requires a separately approved adapter/contract.
- The reviewed command/event registry authorizes explicitly named conditional outbox emissions in addition to legacy effect aliases, with producer/type predicates and no new domain transitions. Non-ENOC workstream receipts cannot produce ENOC approval events; stale resume/unlock messages recompute current eligibility.
- `queued_drex_extraction` does not call a hosted document service before hosting/processing approval. Offline/manual extraction remains available; DREX defaults to quoted string `"OFF"`.
- YAML 1.1 coerces bare `OFF`, `yes` and `no` to booleans. Those DREX enum/option values are now quoted and covered by a regression test. No model-quality claim follows from this correction.

## Verification and limits

`tests/test_sdd_contract.py` was run RED against v1.1: six missing-policy assertion failures plus a seventh regression exposing `OFF` parsed as boolean. It checks policy declarations and typed enums after the v1.2 amendment; runtime guard behavior remains unimplemented. It is not a replacement for the transition-test manifest or integration tests.

No transitions/states were added to repair the audit. Terminal lists are success/stop milestones, not an implicit rule forbidding explicitly declared expiry/suspension transitions. Generated code must use declared `from/event/to` rules and the global contract together.

**Intake scope clarification:** full immutable package bindings apply to package gates/reliance. Project-level facts use `PROJECT_SCOPE`; pre-project clearance uses `PROVISIONAL_PLOT_SCOPE` with exact plots, provenance and verified initiator assignment. Such intake cannot clear a package gate until verified linkage creates a complete package binding. No fake project/package IDs or backdated applicability are permitted. The command/schema specification defines this union and preserves lineage through linkage.
