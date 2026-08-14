import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("plugin registers the generic tool and dispatches request_plan", async (t) => {
  const root = join(tmpdir(), `development-cycle-plugin-smoke-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";

  const { default: plugin } = await import(`../dist/index.js?smoke=${Date.now()}`);
  let registered;
  plugin.register({
    pluginConfig: {},
    registerTool(tool) {
      registered = tool;
    },
  });

  assert.equal(registered?.name, "development_cycle");
  const actionSchema = registered.parameters.properties.action;
  const serialized = JSON.stringify(actionSchema);
  for (const action of ["start_implementation", "stop_implementation", "record_delivery", "start_corrections"]) {
    assert.match(serialized, new RegExp(action));
  }
  for (const legacy of ["handoff_to_octopus", "stop_octopus", "record_octopus_delivery", "send_corrections_to_octopus"]) {
    assert.doesNotMatch(serialized, new RegExp(legacy));
  }

  const result = await registered.execute(
    "smoke-call",
    { action: "request_plan", project: "fixture", projectRoot: process.cwd(), notifyExternalGate: false },
    undefined,
    undefined,
  );
  assert.equal(result.details.ok, true);
  assert.equal(result.details.phase, "waiting_external_plan");
  await access(result.details.planRequest);
  const request = await readFile(result.details.planRequest, "utf8");
  assert.match(request, /Development plan request/);
  assert.equal(result.details.notice.reason, "external_gate_notice_disabled");


  const stale = {
    ...JSON.parse(await readFile(join(result.details.dir, "status.json"), "utf8")),
    phase: "implementation_failed",
    ok: false,
    error: "observer_root_session_creation_failed",
    reason: "old observer failure",
    failureClass: "runtime_observation_blocker",
  };
  await writeFile(join(result.details.dir, "status.json"), JSON.stringify(stale, null, 2));

  const rerequested = await registered.execute(
    "smoke-rerequest",
    {
      action: "request_plan",
      project: "fixture",
      runId: result.details.runId,
      projectRoot: process.cwd(),
      projectWikiPath: join(root, "docs"),
      notifyExternalGate: false,
    },
    undefined,
    undefined,
  );
  assert.equal(rerequested.details.ok, true);
  const rerequestedStatus = JSON.parse(await readFile(join(result.details.dir, "status.json"), "utf8"));
  assert.equal(rerequestedStatus.phase, "waiting_external_plan");
  assert.equal(rerequestedStatus.ok, true);
  assert.equal(rerequestedStatus.error, null);
  assert.equal(rerequestedStatus.reason, null);
  assert.equal(rerequestedStatus.failureClass, null);

  const planText = `# Approved plan

## Project paths
projectRoot: ${process.cwd()}
projectWikiPath: ${join(root, "docs")}

## Ordered implementation
1. No-op fixture change.

## Validation checks
Run tests.

## Stop conditions
Stop on failure.

## Expected artifacts
Fixture evidence.`;

  const rearmed = await registered.execute(
    "smoke-rearm",
    {
      action: "record_plan",
      project: "fixture",
      runId: result.details.runId,
      projectRoot: process.cwd(),
      projectWikiPath: join(root, "docs"),
      planText,
      force: true,
    },
    undefined,
    undefined,
  );
  assert.equal(rearmed.details.ok, true);
  const rearmedStatus = JSON.parse(await readFile(join(result.details.dir, "status.json"), "utf8"));
  assert.equal(rearmedStatus.phase, "plan_ready_for_implementation");
  assert.equal(rearmedStatus.ok, true);
  assert.equal(rearmedStatus.error, null);
  assert.equal(rearmedStatus.reason, null);
  assert.equal(rearmedStatus.failureClass, null);
});
