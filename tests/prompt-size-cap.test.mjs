import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const FALLBACK_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_CAP_ENV = [
  "DEVELOPMENT_CYCLE_MAX_PROMPT_BYTES",
  "DEVELOPMENT_CYCLE_MAX_RUNNER_TIMEOUT_SECONDS",
  "DEVELOPMENT_CYCLE_MAX_TOOL_TEXT_BYTES",
];

let importNonce = 0;

function applyPluginEnv(root, extra = {}) {
  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";
  for (const name of MAX_CAP_ENV) delete process.env[name];
  Object.assign(process.env, extra);
}

async function loadRegisteredTool() {
  const { default: plugin } = await import(`../dist/index.js?cap=${Date.now()}-${++importNonce}`);
  let registered;
  plugin.register({
    pluginConfig: {},
    registerTool(tool) {
      registered = tool;
    },
  });
  assert.equal(registered?.name, "development_cycle");
  return registered;
}

async function executeTool(registered, callId, params) {
  return registered.execute(callId, params, undefined, undefined);
}

async function recordForcedPlan(registered, { project, runId, planText = "tiny approved plan" }) {
  const recorded = await executeTool(registered, `record-${project}-${runId}`, {
    action: "record_plan",
    project,
    runId,
    projectRoot: process.cwd(),
    planText,
    force: true,
  });
  assert.equal(recorded.details.ok, true);
  assert.equal(recorded.details.phase, "plan_ready_for_implementation");
  return recorded.details;
}

test("overflowing MAX_PROMPT_BYTES env falls back to a finite 2 MiB cap", async (t) => {
  const root = join(tmpdir(), `development-cycle-prompt-cap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  applyPluginEnv(root, {
    DEVELOPMENT_CYCLE_MAX_PROMPT_BYTES: "9".repeat(400),
  });

  const registered = await loadRegisteredTool();

  await recordForcedPlan(registered, { project: "cap-prompt-small", runId: "run-small" });
  const small = await executeTool(registered, "start-small", {
    action: "start_implementation",
    project: "cap-prompt-small",
    runId: "run-small",
    projectRoot: process.cwd(),
    planText: "x".repeat(400),
  });
  assert.notEqual(small.details.error, "prompt_too_large");
  assert.notEqual(small.details.maxPromptBytes, Infinity);
  assert.ok(small.details.maxPromptBytes === undefined || Number.isFinite(small.details.maxPromptBytes));

  await recordForcedPlan(registered, { project: "cap-prompt-large", runId: "run-large" });
  const large = await executeTool(registered, "start-large", {
    action: "start_implementation",
    project: "cap-prompt-large",
    runId: "run-large",
    projectRoot: process.cwd(),
    planText: "P".repeat(FALLBACK_PROMPT_BYTES + 1024),
  });
  assert.equal(large.details.ok, false);
  assert.equal(large.details.error, "prompt_too_large");
  assert.ok(Number.isFinite(large.details.maxPromptBytes));
  assert.equal(large.details.maxPromptBytes, FALLBACK_PROMPT_BYTES);
  assert.notEqual(large.details.maxPromptBytes, Infinity);
});

test("non-finite timeoutSeconds is rejected with timeout_not_finite", async (t) => {
  const root = join(tmpdir(), `development-cycle-timeout-cap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  applyPluginEnv(root);

  const registered = await loadRegisteredTool();
  await recordForcedPlan(registered, { project: "cap-timeout", runId: "run-timeout" });
  const result = await executeTool(registered, "start-timeout", {
    action: "start_implementation",
    project: "cap-timeout",
    runId: "run-timeout",
    projectRoot: process.cwd(),
    planText: "tiny approved plan",
    timeoutSeconds: Infinity,
  });
  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, "timeout_not_finite");
});

test("tool-text cap rejects oversized request_plan direction", async (t) => {
  const root = join(tmpdir(), `development-cycle-tool-text-cap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  applyPluginEnv(root, {
    DEVELOPMENT_CYCLE_MAX_TOOL_TEXT_BYTES: "1024",
  });

  const registered = await loadRegisteredTool();
  const result = await executeTool(registered, "plan-too-large", {
    action: "request_plan",
    project: "fixture",
    projectRoot: process.cwd(),
    direction: "d".repeat(2000),
  });
  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, "direction_too_large");
  assert.equal(result.details.maxBytes, 1024);
});

test("request_plan still succeeds with default caps", async (t) => {
  const root = join(tmpdir(), `development-cycle-prompt-cap-sanity-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  applyPluginEnv(root);

  const registered = await loadRegisteredTool();
  const result = await executeTool(registered, "plan-sanity", {
    action: "request_plan",
    project: "fixture",
    projectRoot: process.cwd(),
    direction: "Create a short implementation plan.",
  });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.phase, "waiting_external_plan");
});
