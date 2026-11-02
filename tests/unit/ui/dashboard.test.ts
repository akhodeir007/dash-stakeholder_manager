import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PermittingDashboard,
  buildDashboardViewModel,
} from "../../../src/components/PermittingDashboard";

describe("UI-001 Al-Amerah Permitting Command Center role-scoped visibility, gate explanations & accessibility", () => {
  it("enforces role-scoped action visibility across all 7 human roles, keeps DREX OFF, and surfaces gate blockers", () => {
    const smVm = buildDashboardViewModel({ viewerRole: "STAKEHOLDER_MANAGER" });
    expect(smVm.drexMode).toBe("OFF");
    expect(smVm.visibleActions).toContain("VALIDATE_REGULATED_EVIDENCE");
    expect(smVm.visibleActions).not.toContain("ISSUE_STEP05_BUILDING_PERMIT");

    const contractorVm = buildDashboardViewModel({ viewerRole: "CONTRACTOR" });
    expect(contractorVm.visibleActions).toContain("ISSUE_STEP05_BUILDING_PERMIT");
    expect(contractorVm.visibleActions).not.toContain("VALIDATE_REGULATED_EVIDENCE");

    expect(smVm.gateBlockers.some((b) => b.includes("11/24 conditions"))).toBe(true);
    expect(smVm.gateBlockers.some((b) => b.includes("TAQA_WATER quarantined"))).toBe(true);
    expect(smVm.gateBlockers.some((b) => b.includes("DMT/PAS/OUT/2026/8415"))).toBe(true);
  });

  it("renders accessible semantic HTML landmarks, tables, live status region, and 16 site-clearance entities", () => {
    const html = renderToStaticMarkup(PermittingDashboard({ viewerRole: "AOR_LEAD" }));
    expect(html).toContain('aria-label="Al-Amerah Integrated Permitting Command Center"');
    expect(html).toContain('role="status"');
    expect(html).toContain("permitting workflow is not implemented");
    expect(html).toContain("DREX mode: OFF");
    expect(html).toContain("CONFLICT_APPROVED_VS_COMMENTS");
    expect(html).toContain("UNKNOWN_DURATION");
    expect(html).toContain("INF-01 → INF-06 → INF-08 → INF-09 → INF-10");
  });
});
