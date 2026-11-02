import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { Pool } from "pg";

export interface ParsedTrackerRow {
  readonly sheet: "Preliminary Approvals" | "Package I";
  readonly itemCode: string;
  readonly rawSubmissionDetails: string;
  readonly canonicalEntityId: string;
  readonly sourceAuthority: string;
  readonly responsibleOwner: string;
  readonly references: readonly string[];
  readonly plannedFirstSubmissionDate: string | null;
  readonly actualFirstSubmissionDate: string | null;
  readonly plannedApprovalDate: string | null;
  readonly actualApprovalDate: string | null;
  readonly rawStatus: string;
  readonly normalizedStatus: string;
  readonly remarks: string | null;
  readonly enocActionNote: string | null;
  readonly conflictDetected: boolean;
  readonly quarantined: boolean;
}

export interface ParsedTrackerWorkbook {
  readonly sourceHash: string;
  readonly issuanceDateHeader: string;
  readonly consultantHeader: string;
  readonly sheet1Rows: readonly ParsedTrackerRow[];
  readonly sheet2Rows: readonly ParsedTrackerRow[];
}

export interface TrackerImporterPort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  dryRunImport(workbook: ParsedTrackerWorkbook): Promise<{
    toInsertCount: number;
    unchangedCount: number;
    conflictCount: number;
  }>;
  commitImport(workbook: ParsedTrackerWorkbook): Promise<{
    insertedCount: number;
    unchangedCount: number;
    conflictCount: number;
  }>;
  getPersistedRowCount(): Promise<number>;
}

function readZipEntries(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Invalid ZIP archive: EOCD not found");
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  for (let idx = 0; idx < totalEntries; idx++) {
    if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) break;
    const compressionMethod = buffer.readUInt16LE(cdOffset + 10);
    const compressedSize = buffer.readUInt32LE(cdOffset + 20);
    const fileNameLen = buffer.readUInt16LE(cdOffset + 28);
    const extraLen = buffer.readUInt16LE(cdOffset + 30);
    const commentLen = buffer.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(cdOffset + 42);
    const fileName = buffer.subarray(cdOffset + 46, cdOffset + 46 + fileNameLen).toString("utf8");

    if (fileName.endsWith(".xml")) {
      const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      const xml =
        compressionMethod === 0
          ? compressed.toString("utf8")
          : inflateRawSync(compressed).toString("utf8");
      entries.set(fileName, xml);
    }
    cdOffset += 46 + fileNameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseSharedStrings(xml: string): string[] {
  const result: string[] = [];
  const siMatches = xml.matchAll(/<si>([\s\S]*?)<\/si>/g);
  for (const m of siMatches) {
    const inner = m[1];
    const parts: string[] = [];
    for (const tm of inner.matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)) {
      parts.push(decodeXmlEntities(tm[1]));
    }
    result.push(parts.join(""));
  }
  return result;
}

function parseWorksheetCells(xml: string, sharedStrings: string[]): Map<number, Record<string, string>> {
  const rows = new Map<number, Record<string, string>>();
  for (const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(rm[1]);
    const rowBody = rm[2];
    const cells: Record<string, string> = {};
    for (const cm of rowBody.matchAll(/<c\b([^/>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const cellBody = cm[2];
      const rMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      if (!rMatch) continue;
      const col = rMatch[1];
      const tMatch = attrs.match(/\bt="([^"]+)"/);
      const vMatch = cellBody.match(/<v>([\s\S]*?)<\/v>/);
      if (!vMatch) continue;
      const rawVal = vMatch[1];
      const textVal =
        tMatch && tMatch[1] === "s"
          ? (sharedStrings[Number(rawVal)] ?? "")
          : decodeXmlEntities(rawVal);
      if (textVal.trim().length > 0) {
        cells[col] = textVal.trim();
      }
    }
    if (Object.keys(cells).length > 0) {
      rows.set(rowNum, cells);
    }
  }
  return rows;
}

const ENTITY_CANONICAL_MAP: Record<string, string> = {
  ADNOC: "ADNOC",
  TABREED: "TABREED",
  DU: "DU_TELECOM",
  ETISALAT: "EAND_ETISALAT",
  "ADSSC AD": "ADSSC",
  ADSCC: "ADSSC",
  MCC: "ADMCC",
  EAD: "EAD",
  "GHQ Military and Telecom": "GHQ_MILITARY_TELECOM",
  "ADPC Ports": "ADPC_PORTS",
  ENEC: "ENEC",
  "AAM Roads": "AAM_ROADS",
  "ADAC Air Navigation Service": "ADAC_ANS",
  "Zones Corp": "ZONES_CORP",
  DCT: "DCT",
  "TAQA distribution - Water": "TAQA_WATER",
  "TAQA distribution - Electrical": "TAQA_ELECTRICITY",
};

function normalizeItemCode(raw: string): string {
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  return num.toFixed(2);
}

function normalizeStatus(rawStatus: string, canonicalEntityId: string): {
  normalizedStatus: string;
  conflictDetected: boolean;
  quarantined: boolean;
} {
  if (canonicalEntityId === "TAQA_WATER") {
    // Strategy PDF reports TAQA Water as Approved while Tracker Row 40 reports Comments / Resubmission Required
    return {
      normalizedStatus: "CONFLICT_APPROVED_VS_COMMENTS",
      conflictDetected: true,
      quarantined: true,
    };
  }
  const s = rawStatus.trim().toLowerCase();
  if (s === "approved") {
    return { normalizedStatus: "APPROVED", conflictDetected: false, quarantined: true };
  }
  if (s.includes("comments") || s.includes("resubmission")) {
    return { normalizedStatus: "MODIFICATION_REQUIRED", conflictDetected: false, quarantined: true };
  }
  if (s === "not required") {
    return { normalizedStatus: "NOT_REQUIRED_SEED", conflictDetected: false, quarantined: false };
  }
  return { normalizedStatus: "NOT_SUBMITTED", conflictDetected: false, quarantined: true };
}

function extractSheetRows(
  sheetName: "Preliminary Approvals" | "Package I",
  cellMap: Map<number, Record<string, string>>,
): ParsedTrackerRow[] {
  const rows: ParsedTrackerRow[] = [];
  for (const [, cells] of cellMap.entries()) {
    const rawCode = cells.A;
    const details = cells.B;
    if (!rawCode || !details || !/^\d+\.\d+/.test(rawCode)) continue;
    const itemCode = normalizeItemCode(rawCode);
    const canonicalEntityId =
      ENTITY_CANONICAL_MAP[details] ??
      details
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
    const rawRefs = cells.E ? cells.E.split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean) : [];
    const rawStatus = cells.N ?? "not submitted";
    const { normalizedStatus, conflictDetected, quarantined } = normalizeStatus(
      rawStatus,
      canonicalEntityId,
    );

    rows.push(
      Object.freeze({
        sheet: sheetName,
        itemCode,
        rawSubmissionDetails: details,
        canonicalEntityId,
        sourceAuthority: cells.C ?? "",
        responsibleOwner: cells.D ?? "",
        references: Object.freeze(rawRefs),
        plannedFirstSubmissionDate: cells.F && cells.F !== "Planned" ? cells.F : null,
        actualFirstSubmissionDate: cells.G && cells.G !== "Actual" ? cells.G : null,
        plannedApprovalDate: cells.J && cells.J !== "Planned" ? cells.J : null,
        actualApprovalDate: cells.K && cells.K !== "Actual" ? cells.K : null,
        rawStatus,
        normalizedStatus,
        remarks: cells.O ?? null,
        enocActionNote: cells.P ?? null,
        conflictDetected,
        quarantined,
      }),
    );
  }
  return rows;
}

export function parseSubmissionTrackerWorkbook(filePath: string): ParsedTrackerWorkbook {
  const buf = readFileSync(filePath);
  const sourceHash = createHash("sha256").update(buf).digest("hex");
  const entries = readZipEntries(buf);
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml") ?? "");
  const sheet1Map = parseWorksheetCells(entries.get("xl/worksheets/sheet1.xml") ?? "", sharedStrings);
  const sheet2Map = parseWorksheetCells(entries.get("xl/worksheets/sheet2.xml") ?? "", sharedStrings);

  const headerCell = sheet1Map.get(1)?.A ?? "";
  const dateMatch = headerCell.match(/DATE OF ISSUANCE:\s*([0-9/]+)/i);
  const consultantMatch = headerCell.match(/CONSULTANT\s*:\s*(.+)/i);

  const sheet1Rows = extractSheetRows("Preliminary Approvals", sheet1Map);
  const sheet2Rows = extractSheetRows("Package I", sheet2Map);

  return Object.freeze({
    sourceHash,
    issuanceDateHeader: dateMatch ? dateMatch[1].trim() : "",
    consultantHeader: consultantMatch ? consultantMatch[1].trim() : "",
    sheet1Rows: Object.freeze(sheet1Rows),
    sheet2Rows: Object.freeze(sheet2Rows),
  });
}

export function createTrackerImporter(options: {
  connectionString: string;
  schema: string;
  tenantId: string;
  projectId: string;
}): TrackerImporterPort {
  const { connectionString, schema, tenantId, projectId } = options;
  const pool = new Pool({ connectionString, max: 4 });

  return {
    async initialize() {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "${schema}".imported_tracker_rows (
          tenant_id text NOT NULL,
          project_id uuid NOT NULL,
          sheet_name text NOT NULL,
          item_code text NOT NULL,
          canonical_entity_id text NOT NULL,
          raw_submission_details text NOT NULL,
          references_json jsonb NOT NULL,
          normalized_status text NOT NULL,
          conflict_detected boolean NOT NULL,
          quarantined boolean NOT NULL,
          planned_first_submission_date text,
          actual_first_submission_date text,
          planned_approval_date text,
          actual_approval_date text,
          row_hash text NOT NULL,
          source_hash text NOT NULL,
          PRIMARY KEY (tenant_id, project_id, sheet_name, item_code)
        );
      `);
    },

    async close() {
      await pool.end();
    },

    async dryRunImport(workbook) {
      const allRows = [...workbook.sheet1Rows, ...workbook.sheet2Rows];
      let toInsertCount = 0;
      let unchangedCount = 0;
      let conflictCount = 0;
      for (const row of allRows) {
        if (row.conflictDetected) conflictCount += 1;
        const rowHash = createHash("sha256").update(JSON.stringify(row)).digest("hex");
        const existing = await pool.query<{ row_hash: string }>(
          `SELECT row_hash FROM "${schema}".imported_tracker_rows
           WHERE tenant_id = $1 AND project_id = $2 AND sheet_name = $3 AND item_code = $4`,
          [tenantId, projectId, row.sheet, row.itemCode],
        );
        if (existing.rowCount === 0 || existing.rows[0].row_hash !== rowHash) {
          toInsertCount += 1;
        } else {
          unchangedCount += 1;
        }
      }
      return { toInsertCount, unchangedCount, conflictCount };
    },

    async commitImport(workbook) {
      const allRows = [...workbook.sheet1Rows, ...workbook.sheet2Rows];
      let insertedCount = 0;
      let unchangedCount = 0;
      let conflictCount = 0;
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        for (const row of allRows) {
          if (row.conflictDetected) conflictCount += 1;
          const rowHash = createHash("sha256").update(JSON.stringify(row)).digest("hex");
          const existing = await client.query<{ row_hash: string }>(
            `SELECT row_hash FROM "${schema}".imported_tracker_rows
             WHERE tenant_id = $1 AND project_id = $2 AND sheet_name = $3 AND item_code = $4`,
            [tenantId, projectId, row.sheet, row.itemCode],
          );
          if ((existing.rowCount ?? 0) > 0 && existing.rows[0].row_hash === rowHash) {
            unchangedCount += 1;
            continue;
          }
          await client.query(
            `INSERT INTO "${schema}".imported_tracker_rows (
              tenant_id, project_id, sheet_name, item_code, canonical_entity_id,
              raw_submission_details, references_json, normalized_status,
              conflict_detected, quarantined, planned_first_submission_date,
              actual_first_submission_date, planned_approval_date, actual_approval_date,
              row_hash, source_hash
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16)
            ON CONFLICT (tenant_id, project_id, sheet_name, item_code) DO UPDATE
              SET row_hash = EXCLUDED.row_hash, normalized_status = EXCLUDED.normalized_status`,
            [
              tenantId,
              projectId,
              row.sheet,
              row.itemCode,
              row.canonicalEntityId,
              row.rawSubmissionDetails,
              JSON.stringify(row.references),
              row.normalizedStatus,
              row.conflictDetected,
              row.quarantined,
              row.plannedFirstSubmissionDate,
              row.actualFirstSubmissionDate,
              row.plannedApprovalDate,
              row.actualApprovalDate,
              rowHash,
              workbook.sourceHash,
            ],
          );
          insertedCount += 1;
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      return { insertedCount, unchangedCount, conflictCount };
    },

    async getPersistedRowCount() {
      const res = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM "${schema}".imported_tracker_rows WHERE tenant_id = $1 AND project_id = $2`,
        [tenantId, projectId],
      );
      return Number(res.rows[0]?.cnt ?? 0);
    },
  };
}
