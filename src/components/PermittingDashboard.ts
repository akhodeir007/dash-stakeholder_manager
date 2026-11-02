import React, { createElement as h } from "react";
import type { Role } from "../contracts/foundation";
import { INFRA_STEPS_DAG, computeCriticalPath } from "../domain/infrastructure";
import { SITE_CLEARANCE_ENTITIES_SEED } from "../domain/meps";
import { WORKSTREAM_CATALOGUE } from "../domain/packages";
import { THIRD_PARTY_SOURCE_TRUTH } from "../domain/third-party";

export interface DashboardViewModel {
  readonly viewerRole: Role;
  readonly drexMode: "OFF" | "SHADOW" | "ADVISORY" | "ASSISTED";
  readonly dependencyEpoch: number;
  readonly revalidationStatus: "CLEAR" | "REQUIRED";
  readonly dmpConditionsRecorded: number;
  readonly dmpConditionsRequired: 24;
  readonly visibleActions: readonly string[];
  readonly gateBlockers: readonly string[];
}

const ROLE_ACTIONS: Readonly<Record<Role, readonly string[]>> = {
  SYSTEM_ADMIN: ["APPEND_ADMIN_CORRECTION", "APPROVE_DUAL_CONTROL_WAIVER"],
  STAKEHOLDER_MANAGER: [
    "VALIDATE_REGULATED_EVIDENCE",
    "EVALUATE_RELIANCE",
    "CREATE_GATE_SNAPSHOT",
    "PUBLISH_EXECUTIVE_REPORT",
  ],
  AOR_LEAD: [
    "UPLOAD_EVIDENCE_VERSION",
    "RECORD_AUTHORITY_FACT",
    "SUBMIT_MEPS_PACKAGE",
    "RECORD_TECHNICAL_STAMP",
  ],
  THIRD_PARTY_INSPECTOR: ["VALIDATE_STRUCTURAL_DOCUMENT", "ACTIVATE_INSPECTION_SCOPE"],
  CLIENT_EXECUTIVE: ["APPROVE_BASELINE_FREEZE", "ACCEPT_CRITICAL_RISK_DUAL_CONTROL"],
  DISCIPLINE_LEAD: ["DRAFT_COMMENT_RESPONSE", "SUBMIT_SOIL_REPORT_FOR_STAMP"],
  CONTRACTOR: ["PREPARE_MEPS_REGISTRATION_DRAFT", "ISSUE_STEP05_BUILDING_PERMIT"],
  SYSTEM: ["RUN_ESCALATION_RULES", "EVALUATE_EXPIRY_BOUNDARIES"],
};

export function buildDashboardViewModel(input?: {
  viewerRole?: Role;
  dependencyEpoch?: number;
  revalidationStatus?: "CLEAR" | "REQUIRED";
  dmpConditionsRecorded?: number;
  thirdPartyState?: string;
}): DashboardViewModel {
  const viewerRole = input?.viewerRole ?? "STAKEHOLDER_MANAGER";
  const dependencyEpoch = input?.dependencyEpoch ?? 0;
  const revalidationStatus = input?.revalidationStatus ?? "REQUIRED";
  const dmpConditionsRecorded = input?.dmpConditionsRecorded ?? 11;
  const thirdPartyState = input?.thirdPartyState ?? "APPOINTMENT_UNDER_PROCESS";

  const gateBlockers: string[] = [];
  if (dmpConditionsRecorded < 24) {
    gateBlockers.push(
      `DMP Attachment 1 incomplete (${dmpConditionsRecorded}/24 conditions transcribed; 13 missing from strategy extract)`,
    );
  }
  const taqaConflict = SITE_CLEARANCE_ENTITIES_SEED.find((e) => e.id === "TAQA_WATER");
  if (taqaConflict?.seedStatus === "CONFLICT_APPROVED_VS_COMMENTS") {
    gateBlockers.push(
      "TAQA_WATER quarantined: Strategy PDF reports APPROVED vs Tracker Sheet 1 Row 40 reports Comments / Resubmission Required",
    );
  }
  if (thirdPartyState !== "INSPECTION_ACTIVE") {
    gateBlockers.push(
      `Third-party structural authorization (${THIRD_PARTY_SOURCE_TRUTH.dmtLetterRef}) is in ${thirdPartyState}; conditional no-objection does not unlock stamps or plan review until INSPECTION_ACTIVE`,
    );
  }
  if (revalidationStatus === "REQUIRED") {
    gateBlockers.push(
      `Project dependency epoch ${dependencyEpoch} requires fresh independent verification before Step 04 release`,
    );
  }

  return Object.freeze({
    viewerRole,
    drexMode: "OFF",
    dependencyEpoch,
    revalidationStatus,
    dmpConditionsRecorded,
    dmpConditionsRequired: 24,
    visibleActions: ROLE_ACTIONS[viewerRole],
    gateBlockers: Object.freeze(gateBlockers),
  });
}

export function PermittingDashboard(props?: { viewerRole?: Role }): React.ReactElement {
  const vm = buildDashboardViewModel({ viewerRole: props?.viewerRole });
  const cp = computeCriticalPath(new Set());

  return h(
    "main",
    {
      "aria-label": "Al-Amerah Integrated Permitting Command Center",
      style: { fontFamily: "system-ui, sans-serif", maxWidth: "1200px", margin: "0 auto", padding: "1.5rem" },
    },
    h(
      "header",
      { style: { borderBottom: "2px solid #1e293b", paddingBottom: "1rem", marginBottom: "1.5rem" } },
      h("h1", null, "AOR Al-Amerah Phase 1 Integrated Permitting Command Center"),
      h(
        "p",
        { role: "status", "aria-live": "polite" },
        `Local synthetic mode: live external permitting workflow is not implemented pending Sprint 0 / release gates (DREX mode: ${vm.drexMode}).`,
      ),
      h(
        "div",
        { style: { display: "flex", gap: "1rem", flexWrap: "wrap", fontSize: "0.9rem" } },
        h("span", null, h("strong", null, "Active Role: "), vm.viewerRole),
        h("span", null, h("strong", null, "Dependency Epoch: "), String(vm.dependencyEpoch)),
        h("span", null, h("strong", null, "Revalidation Overlay: "), vm.revalidationStatus),
        h(
          "span",
          null,
          h("strong", null, "DMP Certificate: "),
          `MPD-230126-0505 (${vm.dmpConditionsRecorded}/${vm.dmpConditionsRequired} conditions)`,
        ),
        h("span", null, h("strong", null, "MEPS Reg: "), THIRD_PARTY_SOURCE_TRUTH.form22Ref),
      ),
    ),
    h(
      "section",
      {
        "aria-labelledby": "gate-blockers-heading",
        style: {
          marginBottom: "1.5rem",
          padding: "1rem",
          backgroundColor: "#fff7ed",
          border: "1px solid #fdba74",
          borderRadius: "6px",
        },
      },
      h("h2", { id: "gate-blockers-heading", style: { marginTop: 0 } }, "Step 04 Package I Gate & Stale-State Explanations"),
      h(
        "ul",
        null,
        vm.gateBlockers.map((b) => h("li", { key: b }, b)),
      ),
    ),
    h(
      "section",
      { "aria-labelledby": "role-actions-heading", style: { marginBottom: "1.5rem" } },
      h("h2", { id: "role-actions-heading" }, `Role-Scoped Permitted Actions (${vm.viewerRole})`),
      h(
        "ul",
        { style: { display: "flex", gap: "0.75rem", flexWrap: "wrap", listStyle: "none", padding: 0 } },
        vm.visibleActions.map((act) =>
          h(
            "li",
            {
              key: act,
              style: {
                padding: "0.35rem 0.75rem",
                backgroundColor: "#e2e8f0",
                borderRadius: "4px",
                fontFamily: "monospace",
              },
            },
            act,
          ),
        ),
      ),
    ),
    h(
      "section",
      { "aria-labelledby": "site-clearance-heading", style: { marginBottom: "1.5rem" } },
      h(
        "h2",
        { id: "site-clearance-heading" },
        "MEPS Step 02 — 16 Site Clearance Authorities (Active: B2-SC-A-2026-001625 / Legacy: B2-SC-A-2026-001525)",
      ),
      h(
        "div",
        { style: { overflowX: "auto" } },
        h(
          "table",
          { style: { width: "100%", borderCollapse: "collapse", textAlign: "left" } },
          h(
            "thead",
            null,
            h(
              "tr",
              { style: { borderBottom: "2px solid #cbd5e1" } },
              h("th", null, "Authority"),
              h("th", null, "Alias"),
              h("th", null, "Required"),
              h("th", null, "References"),
              h("th", null, "Seed / Reconciliation Status"),
              h("th", null, "SLA Duration"),
            ),
          ),
          h(
            "tbody",
            null,
            SITE_CLEARANCE_ENTITIES_SEED.map((ent) =>
              h(
                "tr",
                { key: ent.id, style: { borderBottom: "1px solid #e2e8f0" } },
                h("td", null, ent.id),
                h("td", null, ent.alias ?? "—"),
                h("td", null, ent.required ? "REQUIRED" : "NOT_REQUIRED_SEED"),
                h("td", null, ent.refs.join(", ")),
                h("td", null, ent.seedStatus),
                h("td", null, "UNKNOWN_DURATION (null tracker dates)"),
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      "section",
      { "aria-labelledby": "infra-dag-heading", style: { marginBottom: "1.5rem" } },
      h(
        "h2",
        { id: "infra-dag-heading" },
        `Infrastructure 10-Step DAG & Critical Path (${cp.maxWeeks} max weeks: ${cp.path.join(" → ")})`,
      ),
      h(
        "ul",
        null,
        INFRA_STEPS_DAG.map((step) =>
          h(
            "li",
            { key: step.id },
            h("strong", null, step.id),
            ` (${step.outputState}) — lead time ${step.leadTimeWeeks[0]}–${step.leadTimeWeeks[1]} wks`,
            step.dependsOn.length > 0 ? ` | depends on: ${step.dependsOn.join(", ")}` : " | root step",
            step.crossLink ? ` | cross-link: ${step.crossLink}` : "",
          ),
        ),
      ),
    ),
    h(
      "section",
      { "aria-labelledby": "workstreams-heading" },
      h(
        "h2",
        { id: "workstreams-heading" },
        `MEPS Step 03 Preparatory Catalogue (${WORKSTREAM_CATALOGUE.catalogue.length} items; Step 03A Active: ${WORKSTREAM_CATALOGUE.step03aCurrentRequirements.join(", ")})`,
      ),
      h("p", null, `Step 03B separate submission planned: ${String(WORKSTREAM_CATALOGUE.step03bSeparateSubmission)}`),
    ),
  );
}
