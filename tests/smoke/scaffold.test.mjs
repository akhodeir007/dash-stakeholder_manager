// Local HTTP smoke checks only; never connects to live permitting services.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../../", import.meta.url));
let server;
let base;
let startupLog = "";

before(async () => {
  assert.ok(existsSync(`${root}.next/BUILD_ID`), "Run npm run build before HTTP smoke tests");
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = (chunk) => { startupLog = (startupLog + chunk.toString()).slice(-4000); };
  server.stdout.on("data", record);
  server.stderr.on("data", record);
  let spawnError;
  server.on("error", (error) => { spawnError = error; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (spawnError || server.exitCode !== null) {
      throw new Error(`Local scaffold server exited: ${spawnError ?? startupLog}`);
    }
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Startup readiness is bounded; this is not polling an agent job.
    }
    await delay(100);
  }
  throw new Error(`Local scaffold did not become live within 30 seconds: ${startupLog}`);
}, { timeout: 35_000 });

after(async () => {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => server.kill("SIGKILL"), 2000);
    server.once("exit", () => { clearTimeout(force); resolve(); });
    server.kill("SIGTERM");
  });
});

test("HTTP health is liveness only and does not echo request data", async () => {
  const response = await fetch(`${base}/api/health?token=synthetic-smoke-marker`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), {
    status: "scaffold",
    workflowReady: false,
    integrations: { mepsWriteback: false, hostedDocumentProcessing: false, drexMode: "OFF" },
  });
});

test("HTTP health rejects a mutating method", async () => {
  const response = await fetch(`${base}/api/health`, { method: "POST" });
  assert.equal(response.status, 405);
});

test("root page states that permitting is unimplemented", async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /permitting workflow is not implemented/i);
  assert.equal(response.headers.get("x-powered-by"), null);
});

test("workspace source documents are not public web assets", async () => {
  for (const name of [
    "Al-Amerah_Phase_1_Integrated_Permitting_Strategy F.pdf",
    "20260831 - AOR Al Amerah- Submission Tracker Sheet.xlsx",
  ]) {
    const response = await fetch(`${base}/${encodeURIComponent(name)}`);
    assert.equal(response.status, 404, `${name} must not be served`);
  }
});
