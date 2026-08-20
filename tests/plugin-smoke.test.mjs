import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
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
  delete process.env.DEVELOPMENT_CYCLE_EXTERNAL_GATE_SECRET_PATH;
  delete process.env.DEVELOPMENT_CYCLE_EXTERNAL_GATE_URL;

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
    { action: "request_plan", project: "fixture", projectRoot: process.cwd() },
    undefined,
    undefined,
  );
  assert.equal(result.details.ok, true);
  assert.equal(result.details.phase, "waiting_external_plan");
  await access(result.details.planRequest);
  const request = await readFile(result.details.planRequest, "utf8");
  assert.match(request, /Development plan request/);
  assert.equal(result.details.notice.reason, "external_gate_not_configured");
});
