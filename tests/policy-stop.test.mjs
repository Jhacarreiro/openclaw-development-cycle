import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("failure-policy cancellation cannot act on a retry-only warning", async t => {
  const root = await mkdtemp(join(tmpdir(), "cycle-policy-stop-")); t.after(() => rm(root, { recursive: true, force: true }));
  const saved = { ...process.env }; t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, { DEVELOPMENT_CYCLE_STATE_ROOT: join(root, "state"), DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"), DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false", DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false" });
  const { default: plugin } = await import(`../dist/index.js?stop=${Date.now()}`); let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  const planned = (await tool.execute("plan", { action: "request_plan", project: "fixture", projectRoot: process.cwd() }, undefined, undefined)).details;
  for (const staleRecommendation of [false, true]) {
  await writeFile(join(planned.dir, "status.json"), JSON.stringify({ ...planned.status, project: "fixture", runId: planned.runId, phase: "implementation_running", failureAutoStopRecommended: staleRecommendation, failureSafeToAutoRetry: false }));
  const result = (await tool.execute("stop", { action: "stop_implementation", project: "fixture", runId: planned.runId, stopIntent: "failure-policy", stopReason: "warning" }, undefined, undefined)).details;
  assert.equal(result.error, "automatic_stop_not_recommended"); assert.equal(result.phase, "implementation_running");
  }
});
