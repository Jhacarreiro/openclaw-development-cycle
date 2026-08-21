import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "development-cycle-guard-"));
process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";
// A real gate config pointing at a closed port: sendCycleNotice must attempt
// the POST and fail fast so the error path is exercised for real.
const secretPath = join(root, "gate.conf");
process.env.DEVELOPMENT_CYCLE_EXTERNAL_GATE_SECRET_PATH = secretPath;
process.env.DEVELOPMENT_CYCLE_EXTERNAL_GATE_URL = "http://127.0.0.1:1";
writeFileSync(secretPath, "EXTERNAL_GATE_URL=http://127.0.0.1:1\nEXTERNAL_GATE_TOKEN=test-token\n");

const { default: plugin } = await import(`../dist/index.js?guard=${Date.now()}`);
let registered;
plugin.register({
  pluginConfig: {},
  registerTool(tool) {
    registered = tool;
  },
});

function runDir(project, runId) {
  return join(root, "state", "runs", project, runId);
}

test("request_plan refuses to hijack a live run", async () => {
  const dir = runDir("proj", "proj-20260101");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "status.json"),
    JSON.stringify({ phase: "implementation_launched", project: "proj", runId: "proj-20260101" }),
  );

  const result = await registered.execute("request_plan", { action: "request_plan", project: "proj", runId: "proj-20260101" }, undefined, undefined);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, "active_run_present");
  assert.equal(result.details.phase, "implementation_launched");

  const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert.equal(status.phase, "implementation_launched", "live phase must be untouched");
  assert.equal(status.externalGateNotice, undefined, "no notice attempted for a blocked request");
});

test("request_plan persists a failed external gate notice into status", async () => {
  const result = await registered.execute(
    "request_plan",
    { action: "request_plan", project: "proj2", runId: "proj2-20260101", timeout_ms: 800 },
    undefined,
    undefined,
  );
  assert.equal(result.details.ok, true);
  assert.equal(result.details.phase, "waiting_external_plan");
  assert.equal(result.details.notice.ok, false, "gate POST must fail (closed port)");

  const status = JSON.parse(await readFile(join(runDir("proj2", "proj2-20260101"), "status.json"), "utf8"));
  assert.equal(status.externalGateNotice.ok, false, "notice failure must be persisted");
  assert.ok(status.externalGateNotice.error, "notice error message must be persisted");
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
