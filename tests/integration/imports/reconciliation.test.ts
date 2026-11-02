import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTrackerImporter,
  parseSubmissionTrackerWorkbook,
  type TrackerImporterPort,
} from "../../../src/imports";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("imports tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const WORKBOOK_PATH = resolve(process.cwd(), "20260831 - AOR Al Amerah- Submission Tracker Sheet.xlsx");

describe("INTEGRATE-001 Al-Amerah Submission Tracker .xlsx parser, dry-run diff & idempotent PostgreSQL commit", () => {
  const importers: TrackerImporterPort[] = [];
  let importer: TrackerImporterPort;

  afterAll(async () => {
    for (const imp of importers) await imp.close();
  });

  beforeEach(async () => {
    const schema = `imp_${randomUUID().replace(/-/g, "")}`;
    importer = createTrackerImporter({
      connectionString: url!,
      schema,
      tenantId: "tenant-al-amerah",
      projectId: "50000000-0000-4000-8000-000000000001",
    });
    importers.push(importer);
    await importer.initialize();
  });

  it("parses the real 20260831 Al-Amerah Submission Tracker workbook without modifying the source file, preserves null dates, aliases, active/legacy refs, and quarantines TAQA_WATER conflict", async () => {
    const beforeHash = createHash("sha256").update(readFileSync(WORKBOOK_PATH)).digest("hex");
    const parsed = parseSubmissionTrackerWorkbook(WORKBOOK_PATH);

    expect(parsed.consultantHeader).toContain("Engineering Consultants Group");
    expect(parsed.issuanceDateHeader).toBe("19/07/2026");
    expect(parsed.sheet1Rows.length).toBeGreaterThanOrEqual(23);
    expect(parsed.sheet2Rows.length).toBeGreaterThanOrEqual(11);

    // Every planned/actual date in the source workbook is null (never coerced to 1970-01-01 or 0)
    for (const row of [...parsed.sheet1Rows, ...parsed.sheet2Rows]) {
      expect(row.plannedFirstSubmissionDate).toBeNull();
      expect(row.actualFirstSubmissionDate).toBeNull();
      expect(row.plannedApprovalDate).toBeNull();
      expect(row.actualApprovalDate).toBeNull();
    }

    // Verify canonical entity mapping & aliases (ADSSC AD -> ADSSC, MCC -> ADMCC)
    const adsscRow = parsed.sheet1Rows.find((r) => r.canonicalEntityId === "ADSSC")!;
    expect(adsscRow.rawSubmissionDetails).toBe("ADSSC AD");
    expect(adsscRow.references).toEqual(["B2-SC-A-2026-001525", "B2-SC-A-2026-001625"]);

    const admccRow = parsed.sheet1Rows.find((r) => r.canonicalEntityId === "ADMCC")!;
    expect(admccRow.rawSubmissionDetails).toBe("MCC");

    // Verify TAQA_WATER conflict detection (strategy APPROVED vs tracker Comments / Resubmission Required)
    const taqaWater = parsed.sheet1Rows.find((r) => r.canonicalEntityId === "TAQA_WATER")!;
    expect(taqaWater.conflictDetected).toBe(true);
    expect(taqaWater.quarantined).toBe(true);
    expect(taqaWater.enocActionNote).toContain("Design ENOC to be provided by AECOM");

    // Dry-run diff does not write to PostgreSQL
    const dryRun = await importer.dryRunImport(parsed);
    expect(dryRun.toInsertCount).toBe(parsed.sheet1Rows.length + parsed.sheet2Rows.length);
    expect(await importer.getPersistedRowCount()).toBe(0);

    // Commit import persists all rows and is idempotent on replay
    const firstCommit = await importer.commitImport(parsed);
    expect(firstCommit.insertedCount).toBe(parsed.sheet1Rows.length + parsed.sheet2Rows.length);
    expect(firstCommit.conflictCount).toBeGreaterThanOrEqual(1);

    const secondCommit = await importer.commitImport(parsed);
    expect(secondCommit.insertedCount).toBe(0);
    expect(secondCommit.unchangedCount).toBe(parsed.sheet1Rows.length + parsed.sheet2Rows.length);

    // Verify source .xlsx file was never written to or mutated
    const afterHash = createHash("sha256").update(readFileSync(WORKBOOK_PATH)).digest("hex");
    expect(afterHash).toBe(beforeHash);
  });
});
