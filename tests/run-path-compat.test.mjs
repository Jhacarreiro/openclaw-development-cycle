import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanId } from "../dist/core/ids.js";

test("request_plan uses canonical paths and status finds legacy sanitized runs", async (t) => {
  const root = join(tmpdir(), `development-cycle-run-path-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";

  const { default: plugin } = await import(`../dist/index.js?runpath=${Date.now()}`);
  let registered;
  plugin.register({
    pluginConfig: {},
    registerTool(tool) {
      registered = tool;
    },
  });

  const planned = await registered.execute(
    "run-path-fresh",
    { action: "request_plan", project: "Project / One", projectRoot: process.cwd() },
    undefined,
    undefined,
  );
  assert.equal(planned.details.ok, true);
  const canonicalProject = cleanId("Project / One");
  assert.equal(planned.details.project, canonicalProject);
  assert.equal(planned.details.dir, join(root, "state", "runs", canonicalProject, planned.details.runId));
  assert.notEqual(canonicalProject, "Project-One");
  await access(planned.details.planRequest);
  const planRequest = await readFile(planned.details.planRequest, "utf8");
  assert.match(planRequest, /Development plan request/);

  const legacyRunId = "Legacy-Name-20260716123456000";
  const legacyDir = join(root, "state", "runs", "Legacy-Name", legacyRunId);
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, "status.json"), `${JSON.stringify({ phase: "planned", project: "Legacy-Name", runId: legacyRunId }, null, 2)}\n`);

  const upgraded = await registered.execute(
    "run-path-upgrade",
    { action: "status", project: "Legacy / Name" },
    undefined,
    undefined,
  );
  assert.equal(upgraded.details.ok, true);
  assert.equal(upgraded.details.dir, legacyDir);
  assert.equal(upgraded.details.project, "Legacy-Name");
  assert.equal(upgraded.details.runId, cleanId(legacyRunId));
  assert.equal(upgraded.details.status.phase, "planned");

  const roundTrip = await registered.execute(
    "run-path-roundtrip",
    { action: "status", project: upgraded.details.project },
    undefined,
    undefined,
  );
  assert.equal(roundTrip.details.ok, true);
  assert.equal(roundTrip.details.dir, legacyDir);
  assert.equal(roundTrip.details.project, "Legacy-Name");
});
