import assert from "node:assert/strict";
import test from "node:test";
import { loadDevelopmentCycleConfig } from "../dist/config.js";
import { buildImplementationLaunchSpec } from "../dist/adapters/implementation.js";

const config = () => ({
  ...loadDevelopmentCycleConfig({ HOME: "/tmp/example-home" }).implementation,
  adapter: "octopus", octopusRoot: "/opt/octopus",
});
const input = () => ({
  project: "example", runId: "run-1", attemptId: "attempt-1", mode: "delivery",
  projectRoot: "/tmp/example/repo", requestPath: "/tmp/example/run/request.json",
  promptPath: "/tmp/example/run/prompt.txt", prompt: "Read /unapproved/secret.txt",
  projectWikiPath: "/tmp/example/docs", runRoot: "/tmp/example/run",
  planPath: "/tmp/attached/approved.md",
});

test("read config defaults to contextual, allows strict and rejects typos", () => {
  assert.equal(config().octopusReadScopeMode, "contextual");
  assert.equal(loadDevelopmentCycleConfig({
    DEVELOPMENT_CYCLE_OCTOPUS_READ_SCOPE_MODE: "strict",
  }).implementation.octopusReadScopeMode, "strict");
  assert.throws(() => loadDevelopmentCycleConfig({
    DEVELOPMENT_CYCLE_OCTOPUS_READ_SCOPE_MODE: "unrestricted",
  }), /invalid_octopus_read_scope_mode/);
});

test("launcher supplies scoped metadata, not prompt paths", () => {
  const spec = buildImplementationLaunchSpec(config(), input());
  assert.equal(spec.env.OCTOPUS_TANGLE_READ_SCOPE_MODE, "contextual");
  assert.deepEqual(spec.env.OCTOPUS_TANGLE_CONTEXTUAL_READ_ROOTS.split("\n"), [
    "/tmp/example/repo", "/tmp/example/docs", "/tmp/example/run",
    "/tmp/attached/approved.md", "/tmp/example/run/request.json", "/tmp/example/run/prompt.txt",
  ]);
  assert.equal(spec.env.OCTOPUS_CODEX_SANDBOX, "danger-full-access");
  assert.equal(spec.env.OCTOPUS_TANGLE_WRITE_SCOPE_MODE, "adaptive");
  assert.ok(!spec.env.OCTOPUS_TANGLE_CONTEXTUAL_READ_ROOTS.includes("/unapproved"));
  assert.ok(!spec.env.OCTOPUS_TANGLE_CONTEXTUAL_READ_ROOTS.split("\n").includes("/tmp/attached"));
});

test("per-run strict override clears external roots without changing writes", () => {
  const spec = buildImplementationLaunchSpec(config(), { ...input(), readScopeMode: "strict" });
  assert.equal(spec.env.OCTOPUS_TANGLE_READ_SCOPE_MODE, "strict");
  assert.equal(spec.env.OCTOPUS_TANGLE_CONTEXTUAL_READ_ROOTS, "");
  assert.equal(spec.env.OCTOPUS_TANGLE_WRITE_SCOPE_MODE, "adaptive");
});

test("per-run contextual override works for correction launches", () => {
  const spec = buildImplementationLaunchSpec({ ...config(), octopusReadScopeMode: "strict" },
    { ...input(), readScopeMode: "contextual", mode: "corrections" });
  assert.equal(spec.env.OCTOPUS_TANGLE_READ_SCOPE_MODE, "contextual");
  assert.ok(spec.env.OCTOPUS_TANGLE_CONTEXTUAL_READ_ROOTS.includes("/tmp/example/docs"));
});

test("launcher rejects invalid mode and injected or relative context", () => {
  assert.throws(() => buildImplementationLaunchSpec(config(),
    { ...input(), readScopeMode: "typo" }), /invalid_octopus_read_scope_mode/);
  assert.throws(() => buildImplementationLaunchSpec(config(),
    { ...input(), projectWikiPath: "/tmp/docs\n/" }), /invalid_octopus_contextual_read_path/);
  assert.throws(() => buildImplementationLaunchSpec(config(),
    { ...input(), planPath: "relative.md" }), /invalid_octopus_contextual_read_path/);
});
