# BUILD-003 — Scoped server-side authorization foundation

**Status:** approved bounded local/synthetic dispatch. No Azure AD, login/session endpoint or user provisioning.  
**Owner:** Luna authorization agent; independent reviewer/integration owner: lead.  
**Sources:** IMPORT_EVIDENCE_RBAC_SPEC.md, SPEC_DECISIONS.md, YAML v1.2 global policies/role pairs, shared types `src/contracts/foundation.ts`.

## Ownership and interface

Write only `src/auth/**`, `tests/integration/auth/**`, `docs/validation/TDD_BUILD_003_REPORT.md`. Lead owns shared types, package/lock, configuration, docs/backlog. Do not edit database/command/application files. No recursive agents; one repair maximum.

Export `createAuthorizationService({ verifySession, rules })` returning the shared `AuthorizationPort`. `verifySession` is a mandatory trusted server adapter, not a client claim parser. There is **no production default verifier**. Test verifiers use synthetic credentials only. `resolve` forwards the optional transaction to the verifier, rejects malformed/expired sessions and issues a deep-cloned frozen principal. `authorize` only trusts principals issued by that service instance (private identity/WeakSet or equivalent); caller JSON, object clones, forged roles and contexts from another service cannot authorize. Structural TypeScript types are not authentication.

Rules come from a server-owned reviewed registry, not requests. Unknown transition IDs deny. Local transition roles, global evidence policy, current verified assignment, scope, principal/session validity and exact dual-control role pairs are intersected. No HTTP handler or auth bypass is added; actual Azure AD verification and persisted assignment loading remain gated future adapters. Pure policy tests cannot claim real login or deployed access enforcement.

## Required policy

- Seven human roles; `SYSTEM` only for a trusted service principal with matching verified scope and exact capability `transition:<transitionId>`. Human role claims never impersonate SYSTEM. Services cannot supply either human participant in dual control.
- Assignment must be active, verified, tenant-matching, valid at the injected clock and scope-matching. Invalid dates/unknown scope deny. Package assignments require exact project/package and coverage of every target plot. Project assignments need explicit `allPackages: true` for package actions. Provisional scope must match exact provisional case/plots; it cannot authorize package release.
- Human `authorize(EXECUTE)` applies registry roles and stricter operation policy. `REPLAY` checks current identity/role/scope but does not re-perform execution evidence/dual-control decisions; it cannot grant a new action.
- For `VALIDATE_EVIDENCE`, missing/unknown evidence class denies. Metadata uses local role rules only; regulated classes require uploader != actor and a verified named eligible assignment. Authority/NOC/legal/exemption/waiver: Stakeholder Manager. Structural stamped document: assigned credentialed Third-Party Inspector with active matching authorization. No blanket admin/executive/AOR validator.
- For `RECORD_STAMP`, AOR may record another party's technical act but cannot act as signer. Require independently verified structural validation, assigned credentialed signer, matching tenant/scope, active `INSPECTION_ACTIVE` authorization and current version at commit. Store identities separately; do not substitute actor for signer.
- Dual control requires two **different people**, eligible current assignments and one permitted role pair, all bound to the same command hash, scope hash, epoch and expiry. Reject stale/unverified/duplicate-person approvals and roles outside the pair. Risk acceptance requires two different eligible executives; government exemption includes an executive. Approval facts are server-owned transaction inputs, never accepted as self-certified client JSON.
- Contractor cannot close comments, edit design, waive or freeze; inspector cannot edit design or close lifecycle comments; admin cannot directly set state or bypass evidence. Authorization to record does not independently validate evidence or grant legal authority.

## Verification / TDD

Write tests first, record actual RED, then implementation/GREEN and regression. Cover all seven roles against registry allow/deny (prefer source-derived YAML role matrix with purpose-specific global-policy fixtures), unauthenticated/forged principal, raw JSON and cloned principal, cross-service principal, expired session/assignment, revoked/unverified/wrong tenant, wrong package/plot/project, provisional-to-package, absent wildcard flag, unknown transition, human-SYSTEM spoof, scoped service capability, self-validation per regulated class, correct independent validators, stamp signer vs recorder, missing/stale authorization, every dual-control pair and duplicate/stale identities/hash/epoch, malicious caller payload claims, and replay permissions after assignment change. Returned decision must have stable deny code/reason; exceptions from verification fail closed.

A trusted adapter is a server-code boundary, not a declaration that the real client/AOR has approved named humans. Document the unresolved named assignments and Azure AD/DB adapter work. Do not mark live auth implemented or invent user accounts. Lead will integrate with the command engine using the unchanged shared port and independently verify the seam.
