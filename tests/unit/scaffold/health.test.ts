import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GET } from "../../../src/app/api/health/route";
import { runtimeDefaults } from "../../../src/config/runtime";

const expected = {
  status: "scaffold",
  workflowReady: false,
  integrations: {
    mepsWriteback: false,
    hostedDocumentProcessing: false,
    drexMode: "OFF",
  },
};

describe("scaffold liveness and offline defaults", () => {
  it("returns exactly the fixed non-sensitive health schema", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(expected);
  });

  it("exposes immutable defaults and isolates response objects", async () => {
    expect(Object.isFrozen(runtimeDefaults)).toBe(true);
    expect(Object.isFrozen(runtimeDefaults.integrations)).toBe(true);
    expect(() => {
      (runtimeDefaults.integrations as { mepsWriteback: boolean }).mepsWriteback = true;
    }).toThrow();

    const first = await GET();
    const firstBody = await first.json();
    firstBody.integrations.mepsWriteback = true;
    expect(await (await GET()).json()).toEqual(expected);
    expect(runtimeDefaults).toEqual(expected);
  });
});

describe("local-only commands and environment escalation resistance", () => {
  it("keeps dev and start bound to loopback with telemetry disabled", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const command of ["dev", "start"]) {
      expect(packageJson.scripts[command]).toContain("NEXT_TELEMETRY_DISABLED=1");
      expect(packageJson.scripts[command]).toContain("--hostname 127.0.0.1");
    }
  });

  it("does not allow environment values to enable scaffold integrations", async () => {
    vi.stubEnv("MEPS_WRITEBACK_ENABLED", "true");
    vi.stubEnv("HOSTED_DOCUMENT_PROCESSING_ENABLED", "true");
    vi.stubEnv("DREX_MODE", "ON");
    vi.resetModules();

    try {
      const { runtimeDefaults: defaultsUnderEscalation } = await import("../../../src/config/runtime");
      expect(defaultsUnderEscalation).toEqual(expected);
      expect(Object.isFrozen(defaultsUnderEscalation)).toBe(true);
      expect(Object.isFrozen(defaultsUnderEscalation.integrations)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
