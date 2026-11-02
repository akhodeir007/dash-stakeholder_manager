import assert from "node:assert/strict";
import { test } from "node:test";
import { localDockerEndpoint, loopbackPort, testEnvironment, containerArguments, main } from "../../scripts/test-foundation.mjs";

test("accepts a local Unix Docker socket", () => {
  assert.equal(localDockerEndpoint("unix:///var/run/docker.sock"), "unix:///var/run/docker.sock");
});

test("rejects remote, absent and ambiguous Docker endpoints", () => {
  for (const value of ["", undefined, "ssh://host", "tcp://host:2375", "https://host", "unix://"]) {
    assert.throws(() => localDockerEndpoint(value));
  }
});

test("parses only one IPv4 loopback port mapping", () => {
  assert.equal(loopbackPort("127.0.0.1:32768\n"), 32768);
  for (const value of ["0.0.0.0:32768", "[::]:32768", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:32768\n127.0.0.1:32769"]) {
    assert.throws(() => loopbackPort(value));
  }
});

test("does not forward credentials or arbitrary configuration into integration tests", () => {
  const env = testEnvironment({ PATH: "/bin", HOME: "/home/test", DATABASE_URL: "production", DREX_API_KEY: "secret", NODE_OPTIONS: "unsafe", TEST_DATABASE_URL: "foreign" }, "synthetic-local-url");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.TEST_DATABASE_URL, "synthetic-local-url");
  assert.equal(env.NEXT_TELEMETRY_DISABLED, "1");
  assert.equal(env.NODE_ENV, "test");
  for (const key of ["DATABASE_URL", "DREX_API_KEY", "NODE_OPTIONS"]) assert.equal(env[key], undefined);
});

test("container args use isolated tmpfs, auto-removal and loopback; no bind mounts", () => {
  const args = containerArguments("aor-test-unique", "run-unique", "synthetic-password");
  assert.equal(args[0], "run");
  assert.ok(args.includes("--rm"));
  assert.equal(args[args.indexOf("--publish") + 1], "127.0.0.1::5432");
  assert.equal(args[args.indexOf("--tmpfs") + 1], "/var/lib/postgresql/data:rw");
  assert.ok(args.includes("aor.test-run=run-unique"));
  assert.equal(args.some((arg) => ["--volume", "-v", "--mount", "--privileged", "--network=host"].includes(arg)), false);
  assert.match(args.at(-1), /^postgres@sha256:[a-f0-9]{64}$/);
});

test("requires a disposable loopback database and optional single vitest pattern", async () => {
  process.env.TEST_DATABASE_URL = "foreign";
  try { await assert.rejects(main([]), /Unset TEST_DATABASE_URL/); } finally { delete process.env.TEST_DATABASE_URL; }
  await assert.rejects(main(["tests/integration/commands", "extra"]), /accepts only|must be the sole/);
  await assert.rejects(main(["--pattern"]), /accepts only|must be the sole/);
});
