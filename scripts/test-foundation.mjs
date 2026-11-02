// Disposable local PostgreSQL runner. Never uses an externally supplied DB URL.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

export const POSTGRES_IMAGE = "postgres@sha256:5db6dac2ef5dcff512f4f00a009c3c332b9f2f28f24277175bf3e4a3d02ef83a";
const root = fileURLToPath(new URL("../", import.meta.url));

export function localDockerEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !/^unix:\/\/\/[^\s]+$/.test(endpoint)) {
    throw new Error("Integration tests require a local Unix-socket Docker endpoint");
  }
  return endpoint;
}

export function loopbackPort(mapping) {
  const match = typeof mapping === "string" && /^127\.0\.0\.1:(\d{1,5})$/.exec(mapping.trim());
  const port = match && Number(match[1]);
  if (!port || port > 65535) throw new Error("Expected one IPv4 loopback Docker port mapping");
  return port;
}

export function testEnvironment(environment, databaseUrl) {
  const result = {};
  for (const key of ["PATH", "HOME", "USER", "TMPDIR", "CI", "FORCE_COLOR"]) {
    if (typeof environment[key] === "string") result[key] = environment[key];
  }
  return { ...result, NODE_ENV: "test", NEXT_TELEMETRY_DISABLED: "1", TEST_DATABASE_URL: databaseUrl };
}

export function containerArguments(name, token, password) {
  if (![name, token].every((value) => typeof value === "string" && /^[a-z0-9][a-z0-9_.-]+$/.test(value))) {
    throw new Error("Invalid disposable-container identity");
  }
  return ["run", "--detach", "--rm", "--name", name, "--label", `aor.test-run=${token}`,
    "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw",
    "--env", "POSTGRES_USER=aor_test", "--env", `POSTGRES_PASSWORD=${password}`,
    "--env", "POSTGRES_DB=aor_test", POSTGRES_IMAGE];
}

function docker(args, timeout = 20_000) {
  return execFileSync("docker", args, { cwd: root, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitForPostgres(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1000, query_timeout: 1000 });
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      try { await pool.query("SELECT 1"); return; }
      catch { await delay(100); }
    }
    throw new Error("Disposable PostgreSQL failed to become ready within 30 seconds");
  } finally { await pool.end(); }
}

async function runTests(databaseUrl, pattern) {
  const args = ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts"];
  if (pattern) args.push(pattern);
  const child = spawn(process.execPath, args, {
    cwd: root, env: testEnvironment(process.env, databaseUrl), stdio: "inherit",
  });
  return await new Promise((resolveExit, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 180_000);
    const killTimeout = setTimeout(() => child.kill("SIGKILL"), 185_000);
    const interrupt = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const clear = () => {
      clearTimeout(timeout); clearTimeout(killTimeout);
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    };
    child.once("error", (error) => { clear(); reject(error); });
    child.once("exit", (code) => { clear(); resolveExit(timedOut ? 1 : (code ?? 1)); });
  });
}

function usage() {
  console.error("Usage: node scripts/test-foundation.mjs [--pattern <vitest-path-pattern>]");
  process.exitCode = 2;
}

export async function main(argv = process.argv.slice(2)) {
  const patternIndex = argv.indexOf("--pattern");
  let pattern;
  if (patternIndex !== -1) {
    if (patternIndex !== 0 || argv.length !== 2) throw new Error("--pattern must be the sole argument with a value");
    pattern = argv[patternIndex + 1];
  } else if (argv.length) throw new Error("This runner accepts only --pattern");
  if (process.env.TEST_DATABASE_URL) throw new Error("Unset TEST_DATABASE_URL: this runner always creates its own disposable database");
  if (process.env.DOCKER_HOST) localDockerEndpoint(process.env.DOCKER_HOST);
  localDockerEndpoint(docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]));
  const token = randomUUID();
  const name = `aor-foundation-${token}`;
  const password = randomBytes(24).toString("hex");
  try {
    docker(containerArguments(name, token, password), 120_000);
    const mapping = docker(["port", name, "5432/tcp"]);
    const port = loopbackPort(mapping.split("\n")[0]);
    const url = `postgresql://aor_test:${password}@127.0.0.1:${port}/aor_test`;
    await waitForPostgres(url);
    console.log("Disposable PostgreSQL 16 ready on loopback; running synthetic integration tests.");
    return await runTests(url, pattern);
  } finally {
    // A matching random owner label is required before stopping anything.
    try {
      if (docker(["inspect", "--format", '{{index .Config.Labels "aor.test-run"}}', name]) === token) {
        docker(["stop", "--time", "5", name], 15_000);
      }
    } catch { /* No matching created container remains; never broaden cleanup. */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2 && !(process.argv.length === 4 && process.argv[2] === "--pattern")) usage();
    else main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
      // Avoid logging command arguments containing even synthetic DB passwords.
      console.error("Disposable integration run failed; verify local Docker, the image and test output.");
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid local test arguments.");
    usage();
  }
}
