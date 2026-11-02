# W1 SPEC-004 — Import, evidence and RBAC contract

**Status:** accepted by lead for local/synthetic development after W1 review; runtime behavior is not implemented or verified here.  
**Owner:** `luna-domain-designer` (SPEC-004); implementers: `luna-importer` (INTEGRATE-001), `luna-evidence` (BUILD-004), `luna-authorization` (BUILD-003); independent reviewer: lead-designated reviewer, not an implementer.  
**Exclusive write path:** this specification only: `docs/execution/IMPORT_EVIDENCE_RBAC_SPEC.md`.  
**Anchors:** `state-machines.yaml` v1.2 `behavioral_contract`, SM-2B, SM-2B case, SM-2D, SM-2E, SM-4, SM-5, SM-6, SM-10; `SPEC_DECISIONS.md` GAP-01–09; `EXECUTION_PLAN.md` §§1.5–1.6, 2.4, 2.6, 2.8, 5, 8–9; `TASK_TEMPLATE.md`.

## 1. Scope and non-goals

Define an implementable contract for importing both tracker sheets and MEPS extracts, evidence provenance/validation/reliance, and server-side seven-role authorization. Imports are staged and auditable; they do not submit to or write back to MEPS/TAMM. The system records external assertions without declaring them legally true. Current eligibility is computed from verified, current, version-bound facts; imported status is not authority.

Not in scope: live authority reconciliation, approving the AOR entity, inventing DMP conditions, interpreting legal scope, hosted document extraction approval, external communications, transitions outside declared YAML, or tests/runtime code. Preserve unresolved matters as blockers and `UNKNOWN`/quarantined facts.

Required task/test ownership from backlog: `BUILD-003` → `tests/integration/auth`; `BUILD-004` → `tests/integration/evidence`; `DOMAIN-002` → `tests/integration/meps/clearance-entity.test.ts` and `clearance-case.test.ts`; `DOMAIN-003` → `tests/integration/packages/{workstream,full-permit,comment,bundle}.test.ts`; `DOMAIN-004` → `tests/integration/infrastructure/third-party.test.ts`; `INTEGRATE-001` → `tests/integration/imports`. These are planned paths, not proof tests exist or pass.

For every acceptance case, the first backlog task named is the sole test owner and its assigned path is authoritative; additional tasks named as collaborators provide fixtures/interfaces but do not create duplicate test ownership. (For IE-014, BUILD-004 owns the evidence test; BUILD-003 supplies authorization integration.)

## 2. Import contract

### 2.1 Batch lifecycle and persistence

Each upload creates an immutable `ImportBatch` with source kind, source filename/object hash, uploaded-by identity, upload timestamp, parser/mapping version, source-version/fingerprint, sheet names, row counts, and idempotency key. Preserve original bytes in restricted immutable storage. Parse the two statically inspected workbook sheets, `Preliminary Approvals` and `Package I`, independently, retaining exact sheet name and original row number; this is a mapping for the inspected workbook fixture, not confirmation of a live MEPS schema. Never infer that a missing/blank cell means `NOT_REQUIRED`, `APPROVED`, zero, or a date. MEPS input is import-only and uses its own versioned mapping.

Lifecycle: `STAGED → VALIDATED → COMMITTED` or `REJECTED`; dry-run is a read-only evaluation of staged rows, not a commit state. Stage records preserve raw cell value and type, normalized candidate, source coordinates, warnings/errors, matched target (if any), and proposed action. A staging update creates a new stage revision; it never rewrites the captured upload or prior validation. Dry-run emits deterministic counts and per-row diffs without changing domain records, domain transition ledger, outbox, machine states, or idempotency outcome for a commit. A separate import staging/security audit event may record that the dry-run occurred; it is not a domain mutation.

Commit requires a fresh successful validation of the exact stage revision, active uploader identity, current independent named validator assignment where needed, current scope authorization, and expected target versions. All row mutations, immutable source assertions, lineage links, audit entries and outbox events commit atomically. A failure rolls back all writes. Repeating the same commit key and canonical request hash returns the original result; reusing the key with a different hash is a conflict. Import identity is `(source kind, source fingerprint, sheet/row identity, mapping version)`; exact replay creates no duplicate assertion. New source versions create new assertions, not overwrites. Concurrent target changes cause an explicit stale-version conflict and require a new dry-run.

### 2.2 Raw source, dates and status

Persist raw values byte/character faithfully (including blank/null, original spelling, whitespace and cell type) alongside separately normalized values. For dates, blank remains SQL null with `date_presence=BLANK`; invalid nonblank text remains raw with a parse error and no fabricated date. Do not impute dates from file date, header date, neighboring rows or status. Record source header date `2026-07-19` and file date `2026-08-31` as distinct metadata, not row dates. Preserve raw status and remarks separately from canonical interpretation; retain unknown/unmapped status as `UNMAPPED`, never coerce to a machine state. Remarks are exact source text with source coordinates and hash; normalized tags are supplemental only.

Status interpretation is an append-only assertion with source, parser/version, mapping rule, actor, timestamp, confidence/validation state and links to source evidence. Imported `seed_status` is descriptive only. Only authorized commands using verified evidence can change machine state. Do not rewrite authority status when a dependency expires, is revoked, conflicted, or becomes out of scope: set orthogonal revalidation/reliance status and block new gated action.

### 2.3 Entity reconciliation and lineage

Import all 16 tracker entities. Applicability classification is 13 `REQUIRED` plus 3 `NOT_REQUIRED` seeds, but **all 16 classifications require verified, versioned package requirement-snapshot confirmation** before they can drive a gate. Seed classification is not executable state. Unknown applicability blocks affected release. Preserve all 16 even when not required. Do not reduce to the PRD's five critical entities.

Canonical mapping table (source labels remain preserved verbatim):

| Canonical ID | Source label / aliases | Seed applicability | Ref lineage rule |
|---|---|---|---|
| ADNOC | ADNOC | REQUIRED | retain each source ref |
| TABREED | TABREED | REQUIRED | retain each source ref |
| DU_TELECOM | DU TELECOM / DU | REQUIRED | retain each source ref |
| EAND_ETISALAT | e& / Etisalat | REQUIRED | retain each source ref |
| ADSSC | ADSSC / ADSCC | REQUIRED | canonical ADSSC; alias only, no entity merge |
| ADMCC | ADMCC / MCC | REQUIRED | retain each source ref |
| EAD | EAD | REQUIRED | retain each source ref |
| GHQ_MILITARY_TELECOM | GHQ Military Telecom | REQUIRED | retain each source ref |
| ADPC_PORTS | ADPC Ports | NOT_REQUIRED seed | retain each source ref |
| ENEC | ENEC | NOT_REQUIRED seed | retain each source ref |
| AAM_ROADS | AAM Roads | REQUIRED | retain both refs separately |
| ADAC_AIR_NAVIGATION | ADAC Air Navigation | REQUIRED | retain each source ref |
| ZONES_CORP | Zones Corp | NOT_REQUIRED seed | retain each source ref |
| DCT | DCT | REQUIRED | retain each source ref |
| TAQA_WATER | TAQA Water | REQUIRED | retain both refs separately |
| TAQA_ELECTRICITY | TAQA Electricity | REQUIRED | retain both refs separately |

Reference lineage mapping: `B2-SC-A-2026-001525` and `B2-SC-A-2026-001625` are distinct application references in a provisional family. Store `application_family_id`, exact `application_ref`, source assertion, and lineage status `UNRESOLVED` until verified by AOR/client. Never merge, replace, relabel active/legacy, or deduplicate on entity alone. Tracker references remain per-row values; absence of a ref remains absent. No implied active reference is assigned.

### 2.4 Conflicts, evidence rejection and unresolved inputs

TAQA Water: preserve separate strategy `APPROVED` assertion and tracker comments/resubmission assertion, each with source coordinates and raw remarks. Mark conflict and reliance `PENDING`/quarantined. Neither source wins automatically; only current authority evidence independently validated for issuer, validity, plot/package and design can resolve reliance. Do not silently move application reference.

ADSSC: canonical ID is ADSSC; retain PRD/strategy spelling `ADSCC` as alias/provenance. Preserve strategy unavailable-service assertion and tracker comments/resubmission/undertaking assertion separately. An unavailable-service comment is a blocker/risk trigger, not a formal rejection. `REJECTED_INFRASTRUCTURE_UNAVAILABLE` requires the YAML guard's authority letter confirming unavailable service. Evidence outcomes are distinct: `REJECTED` means evidence itself failed type/hash/scan/authenticity or validation; `CONFLICTED` means assertions disagree; `QUARANTINED` means not eligible for reliance pending review; authority application `REJECTED_INFRASTRUCTURE_UNAVAILABLE` means an evidenced authority decision. None substitutes for another.

Never treat a source tracker row or a status label as approved evidence. Missing DMP Attachment 1's 24 conditions, live MEPS extract/mapping, Package I building/plot scope, AOR legal entity/account owner, signed Form 22/DMT originals, ENOC stage evidence/owner, Harmony Study decision, and other live legal decisions remain named blocked inputs per plan/backlog. No synthetic facts may clear them.

## 3. Evidence, validation and gate bindings

### 3.1 Evidence records and independent validation

Separate `uploader_id`, `recorder_id`, `technical_signer_id`, and `validator_id`; store each role/assignment version and timestamp. Generic metadata entry/recording is not validation. Regulated classes are exactly `AUTHORITY_APPROVAL`, `NOC`, `STAMPED_TECHNICAL_DOCUMENT`, `LEGAL_AUTHORIZATION`, `EXEMPTION`, `WAIVER`. Regulated uploader must differ from validator. Validator must be a verified named human with a current role assignment and matching project, package/plot and evidence-class scope; unresolved assignment means unusable evidence. Required application policy: authority/NOC/legal/exemption/waiver validator is `STAKEHOLDER_MANAGER`; structural stamped document validator is `THIRD_PARTY_INSPECTOR`, independently assigned and credentialed for that work. AOR may record a reported approval but cannot thereby validate it.

Technical signer may upload their own signed technical act, but signer and recording actor remain separate identity fields. Stamp recording requires an assigned credentialed signer, verified stamp/evidence and current authorization, checked again atomically at commit. Structural uploader-validator overlap is denied unless a different credentialed assigned inspector validates. Dual control means two distinct eligible humans approve the same canonical command hash, evidence versions, scope and dependency versions; approvals expire on any change. SYSTEM_ADMIN and CLIENT_EXECUTIVE have no blanket technical validation.

Evidence validation, document activation and package reliance are separate records. Validation checks hash/scan/type, source/issuer and class-specific assertions; activation records vault lifecycle; reliance checks validity, issuer, plot/package scope and design consistency for a specific gate binding. Evidence can be valid yet not relied upon for a particular package. Expired, superseded, revoked, conflicted, scope-mismatched or unverified evidence cannot satisfy a gate.

### 3.2 Immutable scope snapshots and revalidation

Every gate evaluation stores immutable snapshot of `project_id`, `package_id`, exact `plot_ids`, `scope_version`, `design_revision`, `requirement_snapshot_id`, evidence-version IDs, authorization/assignment versions, machine version, evaluation timestamp/current-clock result and dependency epoch. Shared evidence is reusable only with explicit independently verified coverage for every project/package/plot/scope/design binding; no inferred coverage from project-wide label.

Any material dependency change (expiry, revocation, suspension, scope/design/requirement change, evidence supersession, exemption revocation) increments relevant dependency epoch in same transaction, sets revalidation `REQUIRED`, and invalidates snapshots immediately. Check expiry using injected clock at command commit, not timer delivery. Gated command locks/version-checks coherent dependency and authorization rows in deterministic order; stale epoch/snapshot denies even if stored state is `READY` or `APPROVED`. Historical external fact may be recorded as quarantined reliance; it does not claim dashboard authorized it. Recovery requires fresh independent verification and current gate evaluation. Never rewrite authority state or legally revoke/suspend a permit automatically.

Conservative third-party policy: plan review and inspection require SM-4 `INSPECTION_ACTIVE`, matching scope and current assignment. `DMT_LICENSING_APPROVED` only enables activation; it does not enable technical work. Apply to all structural review/signoff and soil stamp. Any narrower rule needs evidenced AOR-approved versioned amendment; no implicit exception.

## 4. Seven-role server-side policy matrix

Legend: `A` allow only within listed scope and YAML transition/guard; `V` evidence validation only with class policy/verified assignment; `D` dual control (each participant must separately qualify); `R` read only within scope; `—` deny. Every command is authorized server-side; UI hiding is not control. This is additive: role membership never invents a direct state-entry, gate-clearance, external-submission, or comment-closure permission absent YAML transition and guards. `SYSTEM` transitions are service-only, not human roles.

| Capability | SYSTEM_ADMIN | STAKEHOLDER_MANAGER | AOR_LEAD | THIRD_PARTY_INSPECTOR | CLIENT_EXECUTIVE | DISCIPLINE_LEAD | CONTRACTOR |
|---|---|---|---|---|---|---|---|
| Read modules/records | A | A | A: assigned project, machines 1/2/3/5 | R: assigned structural scope | R: executive/risk | R: assigned discipline/parcel | R: assigned package |
| Stage/import tracker or MEPS | A: operational import, no authority | A: tracker coordination | A: applications/MEPS | — | — | A: assigned source preparation only | A: YAML-permitted registration/site clearance scope |
| Dry-run/reconcile | A | A | A: assigned project | R: own evidence only | R: summary | R: assigned scope | R: assigned package |
| Commit import/status assertions | A: factual metadata only | A: coordination assertions | A: record applications/authority reports | — | — | A: assigned technical facts | A: permitted assigned application facts |
| Correct historical fact | A: append-only superseding assertion; reason/source/replacement/actor/time/evidence; regulated correction independent approval | — | — | — | — | — | — |
| Submit to authority / record receipt | — | — | A: YAML scope | — | — | — | A only where YAML expressly permits (site clearance); never external write-back |
| Validate authority/NOC/legal/waiver evidence | — | V: verified named assignment/scope; independent uploader | — (may record only) | — | — | — | — |
| Validate structural stamped evidence | — | — | — | V: different assigned credentialed inspector, active SM-4 scope | — | — | — |
| Sign technical act / record stamp | — | — | AOR may record, not sign/impersonate | A: assigned credentialed act; commit rechecks | — | — | — |
| Design revision author/edit | — | — | A: controlled project design workflow only | — | — | A: assigned discipline | — |
| Comment TRIAGE `S5-T01` | — | — | A | — | — | A | — |
| Comment ASSIGN `S5-T02` | — | — | A | — | — | — | — |
| Comment DRAFT_RESPONSE `S5-T03` | — | — | — | — | — | A | — |
| Comment VALIDATE_RESPONSE `S5-T04` | — | — | A | A only for assigned structural technical review | — | — | — |
| Comment SUBMIT_RESPONSE `S5-T05` | — | — | A | — | — | — | — |
| Comment CLOSE `S5-T06` (authority closure evidence required) | — | A | A | — | — | — | — |
| Comment REOPEN `S5-T07` / REASSIGN `S5-T08` | — | — | A | — | — | — | — |
| Comment DISPUTE `S5-T09` | — | A | A | — | — | — | — |
| Baseline FREEZE `SM1-T04` (two distinct actors) | — | D: required Stakeholder Manager participant | — | — | D: required Client Executive participant | — | — |
| Baseline APPROVED_BASELINE_CHANGE `SM1-T07` | D: YAML-listed SYSTEM_ADMIN participant for this transition only; not a general correction grant | — | — | — | D: YAML-listed CLIENT_EXECUTIVE participant | — | — |
| Site-entity WAIVE `S2B-T10` | D: YAML-listed participant | — | — | — | D: YAML-listed executive participant | — | — |
| Government exemption `S2BC-T14` | D: YAML-listed participant | D: YAML-listed participant | — | — | D: YAML-listed participant | — | — |
| Workstream MARK_NOT_REQUIRED `S2D-T09` | — | D: YAML-listed participant | — | — | D: YAML-listed participant | — | — |
| Manage users/config | A | — | — | — | — | — | — |
| Data override / direct state edit | — | — | — | — | — | — | — |
| Report publication `S9-T03` | — | A | — | — | A | — | — |
| Risk ESCALATE `S7-T03` | — | A | — | — | A | — | — |
| Permit issuance recording | — | A: verify/record, not issuer | A: verify/record, not issuer | — | — | — | A: contractor is issuing party; assigned package |

Constraints: contractor cannot edit design or close comments. Contractor may supply response materials/evidence to an authorized comment owner as a non-mutating input; it cannot invoke comment lifecycle transitions. Contractor issuance is its own identity, never AOR impersonation. Inspector may perform assigned technical review under `S5-T04`, not comment triage, lifecycle closure, or a transition not listing the role. Client Executive approves only where YAML lists it, but cannot edit trackers/status or independently validate technical evidence. Admin corrections are append-only, never direct state edits/gate bypass; regulated corrections require independent approval and ordinary gate recomputation. YAML transition role lists are necessary and sufficient only together with global evidence-class, scope, guard and SoD policies; they do not create broader capability grants.

The matrix is command-specific: a role is eligible only if it is explicitly present on that transition's YAML role list and satisfies global policy, scope, evidence, guard and dual-control requirements. An `A` cell therefore never overrides a narrower transition list. Transition roles are not generalized to other commands in the same module.

Other comment/baseline/waiver commands not separately tabulated use their exact YAML role lists, never a blanket module editor permission. The global YAML role-pair registry specifies both distinct participants for all ten dual-control transitions; risk acceptance `S7-T07` requires two different eligible Client Executives. This is a conservative software restriction, not confirmation that such staff or legal authority are available.

## 5. Import and runtime boundary

No MEPS/TAMM write-back, submission, authority email, or fee processing. DREX may not write text, status, evidence validation, machine state, or gate eligibility. Hosted DREX/document extraction is `OFF` until hosting/processing policy and approval are recorded; before approval, no document content or derived text may be sent to hosted service. MEPS is import-only. Offline/manual metadata capture remains available and does not itself validate regulated evidence.

## 6. Stable acceptance contract

All IDs are stable requirement tests; use synthetic fixtures unless explicitly verified live. Positive, negative, boundary, property, security, and concurrency tests are required. Tests prove software behavior, never legal/client approval. In every denied mutation assert no partial domain state, success transition, domain assertion, or outbox effect. A minimal security/denial audit record may be appended where the audit policy requires it; it is not a successful transition or domain mutation.

| ID | Given | When | Then | Test type / owner |
|---|---|---|---|---|
| IE-001 | Two-sheet tracker with blanks, raw status/remarks, dates and duplicate rows | Stage and dry-run twice | Both sheets/coordinates/raw values/null dates preserved; deterministic identical diff; no domain mutation | Positive/idempotency; INTEGRATE-001 `tests/integration/imports` |
| IE-002 | Exact previously committed source fingerprint/key/hash | Retry commit | Original result returned; one assertion per source row; no duplicate transition/outbox | Idempotency; INTEGRATE-001 |
| IE-003 | Same idempotency key but changed payload, or target version changed after dry-run | Commit | Hash conflict or stale-version response; entire transaction rolls back | Negative/concurrency; INTEGRATE-001 |
| IE-004 | Each of 16 canonical entities and tracker aliases/refs | Import | Exactly 16 rows; alias ADSSC/ADSCC retained; 13 required + 3 not-required seeds; every classification marked unverified until snapshot confirmation | Boundary/property; DOMAIN-002 `clearance-entity.test.ts` |
| IE-005 | Source refs contain both 001525 and 001625, or one is blank | Normalize | Separate reference assertions and unresolved lineage; no merge, inferred active ref, or replacement | Negative/property; INTEGRATE-001 |
| IE-006 | TAQA Water has conflicting strategy and tracker assertions | Import/reconcile | Both source assertions retained; conflict quarantines reliance; neither status wins | Conflict; DOMAIN-002 `clearance-entity.test.ts` |
| IE-007 | ADSSC tracker comments mention unavailable service, no formal rejection letter | Apply status interpretation | Blocking comment/risk semantics only; no `REJECTED_INFRASTRUCTURE_UNAVAILABLE`; rejection guard fails without qualifying letter | Negative/boundary; DOMAIN-002 |
| IE-008 | Evidence source is invalid hash/type/scan | Validate | Evidence rejection is recorded distinctly from assertion conflict/quarantine and authority rejection state | Negative; BUILD-004 `tests/integration/evidence` |
| IE-009 | Two evidence sources conflict, or source unsupported for authority | Validate/rely | Mark conflicted/quarantined; no reliance or downstream unlock | Negative; BUILD-004 |
| IE-010 | Required source date cell blank, malformed, or valid date | Import | Blank remains null; malformed remains raw/error; valid parses with provenance; no inferred date in any case | Boundary/property; INTEGRATE-001 |
| IE-011 | Raw status/remarks include unknown text, whitespace, aliases | Normalize | Raw values exact; canonical candidate separately versioned; unknown remains unmapped, never machine state | Property; INTEGRATE-001 |
| IE-012 | Required applicability or live MEPS list absent/unknown | Evaluate clearance/full-permit gate | Fail closed; seed status/catalogue/track cannot activate or waive item | Negative; DOMAIN-002 `tests/integration/meps/clearance-entity.test.ts` (DOMAIN-003 collaboration) |
| IE-013 | Regulated evidence uploaded by actor X; validator is X, unassigned, wrong scope, or unresolved name | Validate/commit | Deny reliance; no gate unlock | Security; BUILD-004 |
| IE-014 | AOR records another authority's reported approval | Record then attempt validation | Recording allowed in permitted scope; AOR cannot validate regulated class; independent Stakeholder Manager required | SoD; BUILD-004 `tests/integration/evidence` (BUILD-003 collaboration) |
| IE-015 | Technical signer uploads own signed act; distinct eligible validator exists | Record stamp at `INSPECTION_ACTIVE` | Preserve signer/uploader/recorder/validator separately; permit signer=uploader, validator differs; commit checks active credential/assignment | Positive; DOMAIN-004 `third-party.test.ts` |
| IE-016 | Signer credential/assignment/authorization expires or scope changes between evaluation and commit | Record stamp | Commit denied atomically; stale snapshot cannot stamp; no authority-state rewrite | Race/boundary; DOMAIN-004 |
| IE-017 | Structural uploader is inspector X and only validator is X | Validate | Deny; require a different credentialed assigned inspector | Negative; BUILD-004 `tests/integration/evidence` (DOMAIN-004 collaboration) |
| IE-018 | Gate snapshot omits or mismatches any required project/package/plot/scope/design/requirements/evidence binding | Release/use shared evidence | Deny with failed binding reason; shared evidence needs explicit verified coverage for every binding | Property/negative; DOMAIN-003 `full-permit.test.ts` |
| IE-019 | Evidence/exemption dependency expires, is revoked, superseded, or scope/design/requirements change | Mutate dependency then issue gated command before async recompute | Epoch increments transactionally; revalidation REQUIRED; stale command denied using injected clock/current facts | Race/property; BUILD-004 `tests/integration/evidence` (DOMAIN-003 collaboration) |
| IE-020 | External approval/permit was historically recorded but current dependency is invalid | Import historical fact | Preserve authority assertion/status; quarantine reliance and alert; do not synthesize dashboard authorization or legal suspension | Boundary; DOMAIN-002 |
| IE-021 | Third-party machine is `DMT_LICENSING_APPROVED`, not `INSPECTION_ACTIVE` | Plan review, inspection or soil stamp attempted | Deny all technical acts; matching active scope/assignment required | Negative; DOMAIN-004 |
| IE-022 | Each of seven roles invokes every capability row in §4 in/out of scope | Call server command directly (not UI) | Exact matrix enforced; every denied call has no mutation; scoped access cannot cross project/plot/package | Security matrix; BUILD-003 `tests/integration/auth` |
| IE-023 | Contractor assigned package attempts design edit, comment closure, gate waiver, other package read or AOR impersonation | Invoke command | Denied; contractor may only perform YAML-permitted scoped actions and record own issuance | Security; BUILD-003 `tests/integration/auth` (DOMAIN-003 collaboration) |
| IE-024 | Admin corrects a regulated fact | Append correction then evaluate gate | Original preserved; reason/source/replacement/evidence/actor/time linked; independent approval required; ordinary gate recomputed; no direct state write | Audit/SoD; BUILD-003 `tests/integration/auth` (BUILD-004 collaboration) |
| IE-025 | DREX is disabled and a user submits text/state-writing request; hosted extraction lacks approval | Invoke adapter/command | No network request, text/state write or transition; explicit OFF default; manual metadata path remains | Security/boundary; INTEGRATE-003 (planned adapter tests) |
| IE-026 | Missing 24 conditions, live source mapping, package scope or legal decision | Attempt release/configuration of blocked fact | Remains blocked with named owner; no synthetic data, guessed date or approval | Negative; DOMAIN-003 `tests/integration/packages/full-permit.test.ts` (DOMAIN-001/002 provide blocked fixtures) |

Property suites: permutation of source row order preserves semantic result and lineage; duplicate exact rows do not multiply assertions; any unknown required applicability denies release; any dependency epoch mismatch denies gated action; no role combination lets one human satisfy two-person control; adding an unverified or out-of-scope shared-evidence binding can never preserve eligibility.

Additional acceptance tests:

| ID | Given | When | Then | Test type / owner |
|---|---|---|---|---|
| IE-027 | Tracker contains absent header, duplicate header, formula, invalid encoding or unsupported date locale | Stage batch | Preserve recoverable raw representation; deterministic issue code; affected batch/rows cannot commit until resolved | Boundary; INTEGRATE-001 |
| IE-028 | Later tracker extract reorders rows or changes source fingerprint | Reconcile to prior committed batch | New source version; no row-identity overwrite; ambiguous correspondence requires review | Concurrency/provenance; INTEGRATE-001 |
| IE-029 | Reviewer attempts fuzzy entity match not in alias map | Commit mapping | Denied or left unmapped until explicit reviewed mapping; no automatic entity merge | Negative; INTEGRATE-001 |
| IE-030 | Same valid evidence file is uploaded under a different filename or changed bytes | Validate and link | Byte-identical digest may be related as same content without erasing upload provenance; changed digest is a new version requiring validation | Property; BUILD-004 |
| IE-031 | Previously validated evidence is superseded by a new version | Attempt reliance using old validation | Old version remains auditable; new version has no inherited validation/reliance; affected epoch invalidates | Regression; BUILD-004 |
| IE-032 | Validator role assignment is revoked/expired after dry-run but before commit | Commit regulated validation | Commit denies against current assignment version; stale prior approval cannot authorize | Race/security; BUILD-003 `tests/integration/auth` (BUILD-004 collaboration) |
| IE-033 | Two users approve a dual-control command but one approval references another hash/scope/evidence version | Commit | Deny; both approvals must bind the exact same canonical command and dependencies | Security/property; BUILD-003 |
| IE-034 | Same human holds two required roles and submits both dual-control approvals | Commit | Deny because dual control requires two distinct eligible human identities | Security; BUILD-003 |
| IE-035 | One shared approval covers plot A but is attached to package binding for plots A and B | Evaluate package gate | No inferred plot B coverage; gate remains blocked until explicit verified coverage for B | Boundary; DOMAIN-003 |
| IE-036 | Evidence expires or is revoked while a timer/event is delayed or duplicated | Issue release/stamp/activation command | Injected clock/current facts and epoch deny immediately; event handler dedupes and cannot blindly unlock | Property/concurrency; BUILD-004 `tests/integration/evidence` (DOMAIN-004 collaboration) |
| IE-037 | Historical authority receipt is valid but downstream scope/design changed | Import/record receipt and then release | Receipt remains recorded historical fact; current reliance is pending/revalidation required; no authority status rewrite | Regression; DOMAIN-002 `tests/integration/meps/clearance-entity.test.ts` (DOMAIN-003 collaboration) |
| IE-038 | Unauthorized role requests dry-run for another project | Call import API | Denied server-side with no row/diff disclosure and no mutation | Security; BUILD-003 `tests/integration/auth` (INTEGRATE-001 collaboration) |
| IE-039 | Batch has unresolved fields and operator attempts partial commit | Commit batch | Default all-or-nothing batch denies; no partial assertions unless separately reviewed unit contract exists | Negative/atomicity; INTEGRATE-001 |
| IE-040 | Source assertion carries status label `APPROVED` without evidence reference | Commit/import status | Stored as unverified source assertion only; no machine transition, evidence activation or gate satisfaction | Negative; INTEGRATE-001 `tests/integration/imports` (DOMAIN-002 collaboration) |

Mutation sensitivity minimum: remove uploader/validator inequality; skip version comparison; coerce blank date to current date; merge 001525/001625; permit source `APPROVED` to set machine state; accept licensing-approved stamp; reuse evidence validation across versions; treat seed applicability as verified; allow one identity to supply both approvals. Each mutation must cause at least one identified acceptance test to fail.

## 7. Verification record and open blockers

Specification-only deliverable. No tests were executed and no runtime behavior is claimed. Implementers must follow `TASK_TEMPLATE.md`: RED command/failure, GREEN result, regression, mutation sensitivity, fixtures provenance, independent review, repair limit, combined-workspace integration and queue update. Structural validation is not runtime coverage.

Blocked pending human/live input: all backlog gates `LIVE_EVIDENCE`, `HOSTING_POLICY`, and `RELEASE_SIGNOFF`; 24 DMP conditions; live MEPS extract and column mapping; building/Package I scope; legal AOR and MEPS account owner; authority confirmation resolving TAQA Water/ADSSC status; active/legacy clearance lineage; verified named validators and current assignments/credentials; signed appointment originals and authority scopes; ENOC owner/evidence; Harmony Study applicability; residency/AI processing approval. Keep all unknowns fail-closed; do not claim import reconciliation or release readiness until verified.

## 8. Cross-spec reconciliation required from lead

1. This spec's 13-required/3-not-required **seed** mapping follows YAML `required_entities`/`not_required_seed`; `behavioral_contract` requires all 16 classifications verified in a versioned package requirement snapshot. Importer and DOMAIN-002 must preserve that distinction.
2. Lead reconciled the former broad RBAC table in `EXECUTION_PLAN.md` to the command-specific matrix and YAML/global-policy intersection. No broad editor permission overrides a transition's roles or independent validation.
3. YAML has `SM_2B-T04 APPROVE` roles `[AOR_LEAD, STAKEHOLDER_MANAGER]`; decisions expressly prohibit AOR from regulated validation. AOR is recorder-only; a distinct eligible Stakeholder Manager validator is required.
4. Workbook fixture sheet names are statically inspected as `Preliminary Approvals` and `Package I`; the live MEPS schema and source-column mappings remain unconfirmed. Preserve source headers and block unmapped fields until verified.
5. `SM_2B_case` references current relied-on evidence and package scope, while site clearance may precede package definition. Keep intake records provisional and do not satisfy package gate until explicit package/plot/design coverage is verified.
