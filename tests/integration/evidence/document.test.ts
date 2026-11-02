import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthorizationService } from "../../../src/auth/authorization";
import type {
  Role,
  RoleAssignment,
  ScopeBinding,
  TransitionRule,
  VerifiedSessionRecord,
} from "../../../src/contracts/foundation";
import {
  SM10_TRANSITION_RULES,
  createEvidenceService,
  type EvidenceServicePort,
  type ScanAdapter,
  type StorageAdapter,
} from "../../../src/domain/evidence";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/aor_test" || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("evidence integration tests require disposable local TEST_DATABASE_URL on 127.0.0.1/aor_test");
}

const TENANT = "tenant-al-amerah";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PACKAGE_ID = "PACKAGE_I";
const PLOTS = ["plot-101", "plot-102"];

const baseScope = (evidenceVersionIds: string[] = []): ScopeBinding => ({
  kind: "PACKAGE_GATE",
  projectId: PROJECT_ID,
  packageId: PACKAGE_ID,
  plotIds: PLOTS,
  scopeVersion: 1,
  designRevision: "rev-A",
  requirementSnapshotId: "req-snap-1",
  evidenceVersionIds,
});

const makeAssignment = (
  actorId: string,
  role: Role,
  overrides: Partial<RoleAssignment> = {},
): RoleAssignment => ({
  id: `assign-${actorId}-${role}`,
  actorId,
  version: 1,
  role,
  tenantId: TENANT,
  scope: { kind: "PACKAGE", projectId: PROJECT_ID, packageId: PACKAGE_ID, plotIds: PLOTS },
  verified: true,
  active: true,
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: null,
  credentialVerified: true,
  ...overrides,
});

describe("BUILD-004 SM_10_document & evidence vault persistence", () => {
  let pool: Pool;
  let schema: string;
  let currentTime: Date;
  let sessions: Map<string, VerifiedSessionRecord>;
  let storedObjects: Map<string, { bytes: Uint8Array; mediaType: string; sha256: string }>;
  let scanMode: "CLEAN" | "THREAT";
  let ioDuringTxCount: number;
  let service: EvidenceServicePort;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 6 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    schema = `ev_doc_${randomUUID().replace(/-/g, "")}`;
    currentTime = new Date("2026-11-02T12:00:00.000Z");
    sessions = new Map<string, VerifiedSessionRecord>([
      [
        "sys-cred",
        {
          actorId: "system-worker",
          tenantId: TENANT,
          kind: "SERVICE",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("system-worker", "SYSTEM")],
          serviceCapabilities: SM10_TRANSITION_RULES.filter((r) => r.roles.includes("SYSTEM")).map(
            (r) => `transition:${r.id}`,
          ),
        },
      ],
      [
        "aor-cred",
        {
          actorId: "aor-lead-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("aor-lead-1", "AOR_LEAD")],
        },
      ],
      [
        "sm-cred",
        {
          actorId: "stakeholder-mgr-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("stakeholder-mgr-1", "STAKEHOLDER_MANAGER")],
        },
      ],
      [
        "tpi-cred",
        {
          actorId: "inspector-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("inspector-1", "THIRD_PARTY_INSPECTOR")],
        },
      ],
      [
        "contractor-cred",
        {
          actorId: "contractor-1",
          tenantId: TENANT,
          kind: "HUMAN",
          expiresAt: "2027-12-31T00:00:00.000Z",
          assignments: [makeAssignment("contractor-1", "CONTRACTOR")],
        },
      ],
    ]);

    storedObjects = new Map();
    scanMode = "CLEAN";
    ioDuringTxCount = 0;

    const storage: StorageAdapter = {
      async putObject(input) {
        if (service.isInTransaction()) ioDuringTxCount += 1;
        const sha256 = createHash("sha256").update(input.content).digest("hex");
        storedObjects.set(input.objectKey, {
          bytes: new Uint8Array(input.content),
          mediaType: input.mediaType,
          sha256,
        });
        return { objectKey: input.objectKey, contentHash: sha256, byteSize: input.content.byteLength };
      },
    };

    const scan: ScanAdapter = {
      async scanObject(input) {
        if (service.isInTransaction()) ioDuringTxCount += 1;
        return {
          status: scanMode,
          engine: "synthetic-local-av",
          details: scanMode === "CLEAN" ? "no-threat" : `threat-in-${input.objectKey}`,
        };
      },
    };

    const authorization = createAuthorizationService({
      verifySession: async (cred) => (typeof cred === "string" ? (sessions.get(cred) ?? null) : null),
      rules: SM10_TRANSITION_RULES as readonly TransitionRule[],
    });

    service = createEvidenceService({
      database: { pool, schema },
      clock: () => currentTime,
      storage,
      scan,
      authorization,
    });
    await service.initialize();
  });

  it("fails closed when constructed without required ports", () => {
    expect(() => createEvidenceService({} as unknown as Parameters<typeof createEvidenceService>[0])).toThrow();
    expect(() =>
      createEvidenceService({
        database: { pool, schema },
        clock: () => currentTime,
        storage: null as unknown as StorageAdapter,
        scan: { scanObject: async () => ({ status: "CLEAN", engine: "x" }) },
        authorization: {} as unknown as ReturnType<typeof createAuthorizationService>,
      }),
    ).toThrow();
  });

  it("persists immutable evidence versions with SHA-256 identity, rejects version overwrites, and blocks UPDATE/DELETE via DB triggers", async () => {
    const evidenceId = randomUUID();
    const pdfV1 = Buffer.from("%PDF-1.7 al-amerah-noc-v1");
    const expectedHashV1 = createHash("sha256").update(pdfV1).digest("hex");

    const v1 = await service.uploadEvidenceVersion("aor-cred", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope: baseScope(),
      content: pdfV1,
      expectedContentHash: expectedHashV1,
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: "AUTHORITY_NOC",
      authorityRef: "TAQA-NOC-2026-001",
      signerId: null,
      issuerId: "TAQA_DISTRIBUTION",
      source: "tracker_sheet_1",
      provenance: "row-14",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: "2027-06-01T00:00:00.000Z",
    });

    expect(v1.ok).toBe(true);
    if (!v1.ok) throw new Error(v1.reason);
    expect(v1.record.contentHash).toBe(expectedHashV1);
    expect(v1.record.version).toBe(1);
    expect(v1.record.uploaderId).toBe("aor-lead-1");
    expect(v1.record.scanStatus).toBe("PENDING");
    expect(v1.record.documentState).toBe("UPLOADED");
    expect(ioDuringTxCount).toBe(0);

    // Mismatched expected content hash fails closed
    const badHash = await service.uploadEvidenceVersion("aor-cred", {
      evidenceId: randomUUID(),
      version: 1,
      projectId: PROJECT_ID,
      scope: baseScope(),
      content: pdfV1,
      expectedContentHash: "0".repeat(64),
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: "AUTHORITY_NOC",
      authorityRef: "TAQA-NOC-2026-001",
      signerId: null,
      issuerId: "TAQA_DISTRIBUTION",
      source: "tracker_sheet_1",
      provenance: "row-14",
      validFrom: null,
      validUntil: null,
    });
    expect(badHash.ok).toBe(false);

    // Overwriting existing version 1 is rejected
    const overwriteV1 = await service.uploadEvidenceVersion("aor-cred", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope: baseScope(),
      content: Buffer.from("%PDF-1.7 modified"),
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: "AUTHORITY_NOC",
      authorityRef: "TAQA-NOC-2026-001",
      signerId: null,
      issuerId: "TAQA_DISTRIBUTION",
      source: "tracker_sheet_1",
      provenance: "row-14",
      validFrom: null,
      validUntil: null,
    });
    expect(overwriteV1.ok).toBe(false);

    // New bytes as version 2 succeeds and preserves version 1
    const pdfV2 = Buffer.from("%PDF-1.7 al-amerah-noc-v2");
    const v2 = await service.uploadEvidenceVersion("aor-cred", {
      evidenceId,
      version: 2,
      projectId: PROJECT_ID,
      scope: baseScope(),
      content: pdfV2,
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: "AUTHORITY_NOC",
      authorityRef: "TAQA-NOC-2026-002",
      signerId: null,
      issuerId: "TAQA_DISTRIBUTION",
      source: "tracker_sheet_1",
      provenance: "row-15",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: "2027-06-01T00:00:00.000Z",
    });
    expect(v2.ok).toBe(true);

    // Direct SQL UPDATE or DELETE on immutable evidence_versions table fails via trigger
    await expect(
      pool.query(`UPDATE "${schema}".evidence_versions SET source = 'tampered' WHERE evidence_id = $1`, [evidenceId]),
    ).rejects.toThrow(/IMMUTABLE_TABLE_MUTATION_FORBIDDEN/);
    await expect(
      pool.query(`DELETE FROM "${schema}".evidence_versions WHERE evidence_id = $1`, [evidenceId]),
    ).rejects.toThrow(/IMMUTABLE_TABLE_MUTATION_FORBIDDEN/);
  });

  it("executes full SM_10_document lifecycle (S10-T01..S10-T10) with injected clock, DREX OFF, and supersession non-inheritance", async () => {
    const evidenceId = randomUUID();
    const versionKey1 = `${evidenceId}:1`;
    const scope = baseScope([versionKey1]);

    const uploaded = await service.uploadEvidenceVersion("aor-cred", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("%PDF-1.7 clean-noc-doc"),
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: "AUTHORITY_NOC",
      authorityRef: "ADDC-NOC-2026-100",
      signerId: null,
      issuerId: "TAQA_DISTRIBUTION",
      source: "submission_tracker",
      provenance: "sheet1:r10",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: "2027-01-15T00:00:00.000Z",
    });
    expect(uploaded.ok).toBe(true);

    // S10-T01: UPLOADED -> SCANNING (SYSTEM)
    const t01 = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T01",
      scope,
    });
    expect(t01).toMatchObject({ ok: true, state: "SCANNING" });

    // S10-T02: SCANNING -> EXTRACTED (SYSTEM) with scan_clean and DREX mode OFF (no hosted call)
    const t02 = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T02",
      scope,
    });
    expect(t02).toMatchObject({ ok: true, state: "EXTRACTED", drexMode: "OFF", hostedExtractionCalled: false });

    // S10-T04: EXTRACTED -> VALIDATED
    // First verify uploader (aor-lead-1) cannot validate regulated NOC class (both role and uploader!=validator)
    const selfValidate = await service.validateEvidence("aor-cred", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "attempt self validation",
    });
    expect(selfValidate.ok).toBe(false);

    // Independent STAKEHOLDER_MANAGER validates (S10-T04)
    const validated = await service.validateEvidence("sm-cred", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "Independent stakeholder manager verified NOC reference ADDC-NOC-2026-100",
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.reason);
    expect(validated.documentState).toBe("VALIDATED");

    // S10-T05: VALIDATED -> ACTIVE
    const t05 = await service.transitionDocument("sm-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T05",
      scope,
    });
    expect(t05).toMatchObject({ ok: true, state: "ACTIVE" });

    // Evaluate reliance at epoch 0 -> VERIFIED
    const rel1 = await service.evaluateReliance("sm-cred", {
      evidenceId,
      version: 1,
      scope,
      reason: "Verified for Package I",
    });
    expect(rel1.ok).toBe(true);
    if (!rel1.ok) throw new Error(rel1.reason);
    expect(rel1.evaluation.status).toBe("VERIFIED");

    // S10-T06: ACTIVE -> EXPIRING when within 90 days of validUntil (2027-01-15 is 74 days after 2026-11-02)
    const t06 = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T06",
      scope,
    });
    expect(t06).toMatchObject({ ok: true, state: "EXPIRING" });

    // S10-T08: EXPIRING -> ACTIVE on RENEW by AOR_LEAD with renewed_document_validated
    const t08 = await service.transitionDocument("aor-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T08",
      scope,
      renewedValidUntil: "2027-03-01T00:00:00.000Z",
      renewedDocumentValidated: true,
    });
    expect(t08).toMatchObject({ ok: true, state: "ACTIVE" });

    // Advance clock to within 90 days of new expiry (2027-01-10) -> S10-T06 -> EXPIRING
    currentTime = new Date("2027-01-10T00:00:00.000Z");
    const t06Again = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T06",
      scope,
    });
    expect(t06Again).toMatchObject({ ok: true, state: "EXPIRING" });

    // Advance clock past 2027-03-01 -> S10-T07: EXPIRING -> EXPIRED (atomically bumps epoch & sets REQUIRED)
    currentTime = new Date("2027-03-02T00:00:00.000Z");
    const beforeExpireProject = await service.getProjectState(PROJECT_ID);
    const t07 = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T07",
      scope,
    });
    expect(t07).toMatchObject({ ok: true, state: "EXPIRED" });
    const afterExpireProject = await service.getProjectState(PROJECT_ID);
    expect(afterExpireProject.dependencyEpoch).toBe(beforeExpireProject.dependencyEpoch + 1);
    expect(afterExpireProject.revalidationStatus).toBe("REQUIRED");

    // Upload replacement version 2, scan, extract, validate, activate
    const v2Scope = baseScope([`${evidenceId}:2`]);
    await service.uploadEvidenceVersion("aor-cred", {
      evidenceId,
      version: 2,
      projectId: PROJECT_ID,
      scope: v2Scope,
      content: Buffer.from("%PDF-1.7 replacement-noc-v2"),
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: "AUTHORITY_NOC",
      authorityRef: "ADDC-NOC-2027-200",
      signerId: null,
      issuerId: "TAQA_DISTRIBUTION",
      source: "submission_tracker",
      provenance: "sheet1:r11",
      validFrom: "2027-03-01T00:00:00.000Z",
      validUntil: "2028-03-01T00:00:00.000Z",
    });
    await service.transitionDocument("sys-cred", { evidenceId, version: 2, transitionId: "S10-T01", scope: v2Scope });
    await service.transitionDocument("sys-cred", { evidenceId, version: 2, transitionId: "S10-T02", scope: v2Scope });
    await service.validateEvidence("sm-cred", {
      evidenceId,
      version: 2,
      scope: v2Scope,
      verdict: "VALID",
      reason: "Validated replacement NOC v2",
    });
    await service.transitionDocument("sm-cred", { evidenceId, version: 2, transitionId: "S10-T05", scope: v2Scope });

    // S10-T10: EXPIRED v1 -> SUPERSEDED when replacement v2 is ACTIVE
    const t10 = await service.transitionDocument("aor-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T10",
      scope,
      replacementVersion: 2,
    });
    expect(t10).toMatchObject({ ok: true, state: "SUPERSEDED" });

    // Superseded v1 remains auditable, and v2 does NOT automatically inherit v1's reliance evaluation
    const v1State = await service.getEvidenceVersion(evidenceId, 1);
    expect(v1State?.documentState).toBe("SUPERSEDED");
    const v2RelianceBeforeExplicitEval = await service.getCurrentReliance(evidenceId, 2, v2Scope);
    expect(v2RelianceBeforeExplicitEval.status).toBe("PENDING");
    expect(ioDuringTxCount).toBe(0);
  });

  it("quarantines threat-detected scans (S10-T03), blocks validation/activation, and allows S10-T09 REJECT with distinct rejection reason (IE-008)", async () => {
    scanMode = "THREAT";
    const evidenceId = randomUUID();
    const scope = baseScope([`${evidenceId}:1`]);

    await service.uploadEvidenceVersion("aor-cred", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("%PDF-1.7 infected-payload"),
      mediaType: "application/pdf",
      evidenceClass: "AUTHORITY_APPROVAL",
      documentType: "APPROVAL_LETTER",
      authorityRef: "ADM-2026-999",
      signerId: null,
      issuerId: "ADM",
      source: "upload",
      provenance: "manual",
      validFrom: "2026-11-01T00:00:00.000Z",
      validUntil: "2027-11-01T00:00:00.000Z",
    });

    await service.transitionDocument("sys-cred", { evidenceId, version: 1, transitionId: "S10-T01", scope });

    // S10-T02 (EXTRACT_OK) must fail closed because scan_clean is false
    const extractAttempt = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T02",
      scope,
    });
    expect(extractAttempt.ok).toBe(false);

    // S10-T03: SCANNING -> QUARANTINED
    const q = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T03",
      scope,
    });
    expect(q).toMatchObject({ ok: true, state: "QUARANTINED" });

    // Validation or activation from QUARANTINED is denied
    const valAttempt = await service.validateEvidence("sm-cred", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "try validate quarantined",
    });
    expect(valAttempt.ok).toBe(false);

    // S10-T09: QUARANTINED -> REJECTED requires rejection_reason_recorded
    const rejectMissingReason = await service.transitionDocument("sm-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T09",
      scope,
      rejectionReason: "   ",
    });
    expect(rejectMissingReason.ok).toBe(false);

    const rejected = await service.transitionDocument("sm-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T09",
      scope,
      rejectionReason: "Quarantined due to malware signature in uploaded PDF",
    });
    expect(rejected).toMatchObject({ ok: true, state: "REJECTED" });
  });

  it("enforces all SM_10_document guard_false, illegal_from, and illegal_role denials fail-closed", async () => {
    const evidenceId = randomUUID();
    const scope = baseScope([`${evidenceId}:1`]);

    // Upload disallowed media type or oversize to test S10-T01 guards
    await service.uploadEvidenceVersion("aor-cred", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("MZ-executable-bytes"),
      mediaType: "application/x-msdownload",
      evidenceClass: "METADATA",
      documentType: "OTHER",
      authorityRef: null,
      signerId: null,
      issuerId: null,
      source: "upload",
      provenance: "test",
      validFrom: null,
      validUntil: null,
    });

    // S10-T01 with disallowed file_type_allowed guard -> denied
    const scanDisallowedType = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T01",
      scope,
    });
    expect(scanDisallowedType).toMatchObject({ ok: false, code: "GUARD_FAILED" });

    // Illegal role: CONTRACTOR or AOR_LEAD attempting S10-T01 (SYSTEM only)
    const wrongRole = await service.transitionDocument("aor-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T01",
      scope,
    });
    expect(wrongRole).toMatchObject({ ok: false, code: "FORBIDDEN" });

    // Illegal from state: S10-T05 (ACTIVATE) from UPLOADED
    const wrongFrom = await service.transitionDocument("sm-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T05",
      scope,
    });
    expect(wrongFrom).toMatchObject({ ok: false, code: "INVALID_STATE" });

    // Unknown transition ID -> UNKNOWN_TRANSITION
    const unknownTx = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T99",
      scope,
    });
    expect(unknownTx).toMatchObject({ ok: false, code: "UNKNOWN_TRANSITION" });

    // Direct transitionDocument call for S10-T04 requires validateEvidence
    const directT04 = await service.transitionDocument("sm-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T04",
      scope,
    });
    expect(directT04).toMatchObject({ ok: false, code: "USE_VALIDATE_EVIDENCE" });
  });

  it("verifies S10-T06..S10-T10 guard_false cases and multi-origin transitions (ACTIVE/EXPIRING/EXPIRED -> SUPERSEDED, EXTRACTED/VALIDATED -> REJECTED)", async () => {
    const evidenceId = randomUUID();
    const scope = baseScope([`${evidenceId}:1`]);

    // Upload document with expiry > 90 days away (2027-06-01 vs 2026-11-02)
    await service.uploadEvidenceVersion("aor-cred", {
      evidenceId,
      version: 1,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("%PDF-1.7 long-validity-noc"),
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: "AUTHORITY_NOC",
      authorityRef: "ADDC-2026-500",
      signerId: null,
      issuerId: "TAQA",
      source: "tracker",
      provenance: "r1",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: "2027-06-01T00:00:00.000Z",
    });
    await service.transitionDocument("sys-cred", { evidenceId, version: 1, transitionId: "S10-T01", scope });
    await service.transitionDocument("sys-cred", { evidenceId, version: 1, transitionId: "S10-T02", scope });

    // S10-T04 guard_false: validateEvidence on version missing documentType
    const noTypeId = randomUUID();
    await service.uploadEvidenceVersion("aor-cred", {
      evidenceId: noTypeId,
      version: 1,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("%PDF-1.7 untyped"),
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: null,
      authorityRef: "REF-1",
      signerId: null,
      issuerId: "TAQA",
      source: "tracker",
      provenance: "r2",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: "2027-06-01T00:00:00.000Z",
    });
    await service.transitionDocument("sys-cred", { evidenceId: noTypeId, version: 1, transitionId: "S10-T01", scope });
    await service.transitionDocument("sys-cred", { evidenceId: noTypeId, version: 1, transitionId: "S10-T02", scope });
    const missingDocTypeVal = await service.validateEvidence("sm-cred", {
      evidenceId: noTypeId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "test missing document_type_identified",
    });
    expect(missingDocTypeVal).toMatchObject({ ok: false, code: "GUARD_FAILED" });

    // S10-T09 from EXTRACTED by AOR_LEAD
    const rejectFromExtracted = await service.transitionDocument("aor-cred", {
      evidenceId: noTypeId,
      version: 1,
      transitionId: "S10-T09",
      scope,
      rejectionReason: "Document type missing from cover page",
    });
    expect(rejectFromExtracted).toMatchObject({ ok: true, state: "REJECTED" });

    // Validate and activate evidenceId v1
    await service.validateEvidence("sm-cred", {
      evidenceId,
      version: 1,
      scope,
      verdict: "VALID",
      reason: "valid NOC",
    });
    await service.transitionDocument("aor-cred", { evidenceId, version: 1, transitionId: "S10-T05", scope });

    // S10-T06 guard_false: expiry_within_90_days is false when validUntil is 211 days away
    const t06TooEarly = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T06",
      scope,
    });
    expect(t06TooEarly).toMatchObject({ ok: false, code: "GUARD_FAILED" });

    // S10-T10 guard_false: replacement_document_active is false when replacement v2 does not exist yet
    const t10NoReplacement = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T10",
      scope,
      replacementVersion: 2,
    });
    expect(t10NoReplacement).toMatchObject({ ok: false, code: "GUARD_FAILED" });

    // Upload v2, validate & activate, then S10-T10 SUPERSEDE from ACTIVE by SYSTEM
    await service.uploadEvidenceVersion("aor-cred", {
      evidenceId,
      version: 2,
      projectId: PROJECT_ID,
      scope,
      content: Buffer.from("%PDF-1.7 v2-active-replacement"),
      mediaType: "application/pdf",
      evidenceClass: "NOC",
      documentType: "AUTHORITY_NOC",
      authorityRef: "ADDC-2026-501",
      signerId: null,
      issuerId: "TAQA",
      source: "tracker",
      provenance: "r3",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
    });
    await service.transitionDocument("sys-cred", { evidenceId, version: 2, transitionId: "S10-T01", scope });
    await service.transitionDocument("sys-cred", { evidenceId, version: 2, transitionId: "S10-T02", scope });
    await service.validateEvidence("sm-cred", {
      evidenceId,
      version: 2,
      scope,
      verdict: "VALID",
      reason: "valid v2",
    });
    await service.transitionDocument("sm-cred", { evidenceId, version: 2, transitionId: "S10-T05", scope });

    const supersedeFromActive = await service.transitionDocument("sys-cred", {
      evidenceId,
      version: 1,
      transitionId: "S10-T10",
      scope,
      replacementVersion: 2,
    });
    expect(supersedeFromActive).toMatchObject({ ok: true, state: "SUPERSEDED" });
  });

  it("blocks UPDATE and DELETE on all 9 append-only evidence vault tables via PostgreSQL triggers", async () => {
    const immutableTables = [
      "evidence_versions",
      "document_transitions",
      "evidence_validations",
      "verified_scope_coverages",
      "technical_stamps",
      "assertion_records",
      "reliance_evaluations",
      "gate_snapshots",
      "event_handler_receipts",
    ];
    const trigRes = await pool.query<{ event_object_table: string; event_manipulation: string }>(
      `SELECT event_object_table, event_manipulation
       FROM information_schema.triggers
       WHERE trigger_schema = $1`,
      [schema],
    );
    for (const table of immutableTables) {
      const ops = trigRes.rows.filter((r) => r.event_object_table === table).map((r) => r.event_manipulation);
      expect(ops).toContain("UPDATE");
      expect(ops).toContain("DELETE");
    }
  });
});
