# Independent specification audit — W0

**Date:** 2 November 2026  
**Reviewer:** GPT-6 Luna, separate read-only agent  
**Disposition:** Findings accepted for triage, not automatically accepted as domain amendments. No authority approval is inferred.

Anchors refer to v1.1 at audit time. Semantic gaps can remain in a structurally valid YAML document. The lead must distinguish a contradiction from an implementation detail before changing the contract.

## Findings and red-test obligations

| ID | Priority / classification | Requirement anchors | Gap / risk | Required decision and failing scenario | Owner |
|---|---|---|---|---|---|
| GAP-01 | P0; propagation gap | YAML `SM_2B_case` reopen/revoke; `SM_2E_full_permit`; plan §2.8 I13/I14 | Upstream revocation re-lock effects do not define what happens to already-submitted/approved/issued downstream records | Define revalidation and future-command restrictions separately from legal permit suspension. RED: approve Package I, revoke relied-upon evidence, attempt subsequent action; no stale release allowed. Do not have software unilaterally revoke an authority-issued permit. | Lead + AOR for legal effect |
| GAP-02 | P0; authorization ambiguity | YAML `SM_4_third_party` licensing approval/activation; Step 04 guards; plan §2.6 | “Enable plan review” at licensing approval can be confused with permission before `INSPECTION_ACTIVE` | Clarify whether effect enables activation only or authorizes review. RED: licensing approved, inspection inactive; attempt review and full permit release, with expected outcome fixed by reviewed scope/state rule. | Lead + AOR/third party |
| GAP-03 | P0; applicability ambiguity | YAML `SM_2D_workstream.config`; `SM_2E_full_permit.config`; plan §2.4 | Catalogue `MANDATORY` labels can be misread as activated requirements despite EAD-only current 03A | Define track as classification, separate applicability snapshot from catalogue and independent full-permit prerequisites. RED: EAD-only 03A list does not activate other 03A/03B submissions, but does not waive soil/structure full-permit gates. | Lead + AOR |
| GAP-04 | P1; segregation underspecified | YAML `SM_2B_entity.APPROVE`; plan §1.6 | AOR recording an approval is not explicitly separated from independent validation | Define recorder vs validator and required distinct actors. RED: same actor records then validates authority evidence; denied, no downstream unlock. Recording alone must not be mislabelled self-approval. | Lead/security reviewer |
| GAP-05 | P1; binding underspecified | YAML `SM_2E_full_permit.config` and release guards; plan §2.8 I15 | Package flag alone does not define evidence/plot/revision joins | Bind gate evaluations to immutable package scope/version and matching evidence. RED: Package I approval cannot satisfy Package II, another plot or a stale revision. Shared evidence needs explicit verified coverage, not blanket duplication. | Lead/schema owner |
| GAP-06 | P1; correction command missing | Plan §1.3/§1.6; YAML waiver/exemption roles | Safe admin correction path is not specified | Define append-only superseding facts and ordinary gate recomputation. RED: correcting imported status preserves old assertion and cannot clear regulatory gates without independent evidence. | Lead/security reviewer |
| GAP-07 | P1; event contract missing | YAML orchestration and producer transition effects | Payloads, producer links, version order, dedupe and revocation recompute semantics unspecified | Define event schemas/producers/version keys and stale-event rejection. RED: deliver unlock twice, revoke, then delayed unlock retry; dependents remain blocked with no duplicate effect. | Lead/command engine owner |
| GAP-08 | P1; stamp signer/race boundary missing | YAML `SM_2D_soil_report.RECORD_STAMP`; plan §2.4 | Recording actor may be AOR, but signer/assignment and commit-time authorization binding are unclear | Distinguish signed technical act from evidence recording; bind signer, assignment and active authorization versions. RED: AOR uploads unsigned/unassigned stamp evidence or authorization expires during commit; deny eligibility. | Lead + third party |
| GAP-09 | P1; evidence class policy missing | YAML `SM_10_document` validation/activation; plan §1.6 | Uploader/validator separation not explicit per evidence class | Define evidence-class validator policy. RED: uploader validates own regulated NOC/stamped drawing; deny where independent validation required. Do not ban harmless metadata entry without a policy reason. | Lead/security reviewer |
| GAP-10 | P2; fallback interface missing | Plan §2.4; YAML standalone fallback guard | ADM-directed preparatory contingency lacks separate command/output contract | Keep fallback blocked until separately specified; never reuse full permit success. RED: ADM direction plus pending soil permits only explicitly authorized preparation, never full Step 04/05 success. | Lead + AOR |

## Implementation-safe work while decisions are pending

- Structural tooling, test manifest design, synthetic fixtures and generic transaction/interface specifications can proceed.
- Proposed technical contracts must preserve missing evidence and decisions as explicit unsatisfied inputs.
- Runtime implementation requiring an unresolved semantic choice waits for `TECH_SPEC` acceptance.
- Live activation/release also waits for human evidence and hosting gates; an agent cannot satisfy them by writing tests.
- No new states/transitions or changes to the 173-transition baseline are approved by this audit alone.

## Review routing

Use separate proposed-spec tasks for: (A) revocation/events, (B) roles/signer/evidence, (C) activation/package/fallback, (D) admin correction. Proposals are read-only against the main YAML until the lead reconciles overlap. AOR/Client resolve regulatory meaning; lead owns software command and transaction semantics. The independently reviewed outcome belongs in `SPEC_DECISIONS.md`, then the plan/YAML are amended together.
