import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("request_plan reuses a legacy project-documentation directory", async (t) => {
  const root = join(tmpdir(), `development-cycle-wiki-path-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";
  const legacyWiki = join(root, "docs", "Project-One");
  await mkdir(legacyWiki, { recursive: true });
  await writeFile(join(legacyWiki, "README.md"), "legacy wiki\n");
  const { default: plugin } = await import(`../dist/index.js?wikipath=${Date.now()}`);
  let registered;
  plugin.register({ pluginConfig: {}, registerTool(tool) { registered = tool; } });
  const planned = await registered.execute(
    "wiki-path-legacy",
    { action: "request_plan", project: "Project / One", projectRoot: process.cwd() },
    undefined,
    undefined,
  );
  assert.equal(planned.details.ok, true, JSON.stringify(planned.details));
  await access(legacyWiki);
  const canonicalWiki = join(root, "docs", cleanId("Project / One"));
  if (canonicalWiki !== legacyWiki) {
    await assert.rejects(access(canonicalWiki));
  }
});


test("project-level status discovers a valid run whose id contains .lock", async (t) => {
  const root = join(tmpdir(), `development-cycle-lock-name-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";

  const project = "foo.lock";
  const projectDir = join(root, "state", "runs", project);
  const runId = "foo.lock-20260904120000000-abc123";
  const runDir = join(projectDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "status.json"), `${JSON.stringify({ phase: "planned", project, runId }, null, 2)}\n`);

  const controlDir = join(projectDir, "newer.lock");
  await mkdir(controlDir, { recursive: true });

  const { default: plugin } = await import(`../dist/index.js?lockname=${Date.now()}`);
  let registered;
  plugin.register({ pluginConfig: {}, registerTool(tool) { registered = tool; } });

  const status = await registered.execute(
    "lock-name-status",
    { action: "status", project },
    undefined,
    undefined,
  );

  assert.equal(status.details.ok, true, JSON.stringify(status.details));
  assert.equal(status.details.runId, runId);
  assert.equal(status.details.dir, runDir);
  assert.equal(status.details.status.phase, "planned");
});

test("explicit raw run ids reopen legacy sanitized state", async (t) => {
  const root = join(tmpdir(), `development-cycle-explicit-legacy-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";

  const legacyProject = "Project-One";
  const legacyRunId = "Run-1";
  const legacyDir = join(root, "state", "runs", legacyProject, legacyRunId);
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, "status.json"), `${JSON.stringify({ phase: "planned", project: legacyProject, runId: legacyRunId }, null, 2)}\n`);

  const { default: plugin } = await import(`../dist/index.js?explicit-legacy=${Date.now()}`);
  let registered;
  plugin.register({ pluginConfig: {}, registerTool(tool) { registered = tool; } });

  const status = await registered.execute(
    "explicit-legacy-status",
    { action: "status", project: "Project / One", runId: "Run #1" },
    undefined,
    undefined,
  );

  assert.equal(status.details.ok, true, JSON.stringify(status.details));
  assert.equal(status.details.dir, legacyDir);
  assert.equal(status.details.project, legacyProject);
  assert.equal(status.details.runId, legacyRunId);
  assert.equal(status.details.status.phase, "planned");
});

test("digest-shaped legacy run aliases do not override the reserved canonical namespace", async (t) => {
  const root = join(tmpdir(), `development-cycle-marker-legacy-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";

  const project = "legacy-marker-project";
  const legacyRunId = `run-id-${"a".repeat(64)}`;
  const legacyDir = join(root, "state", "runs", project, legacyRunId);
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, "status.json"), `${JSON.stringify({ phase: "planned", project, runId: legacyRunId }, null, 2)}\n`);

  const { default: plugin } = await import(`../dist/index.js?marker-legacy=${Date.now()}`);
  let registered;
  plugin.register({ pluginConfig: {}, registerTool(tool) { registered = tool; } });

  const distinctRaw = legacyRunId + " ";
  const status = await registered.execute(
    "marker-legacy-status",
    { action: "status", project, runId: distinctRaw },
    undefined,
    undefined,
  );

  assert.equal(status.details.ok, true, JSON.stringify(status.details));
  assert.notEqual(status.details.dir, legacyDir);
  assert.equal(status.details.runId, cleanId(distinctRaw));
  assert.deepEqual(status.details.status, {});
});

test("project-level status ignores a symlinked candidate project during latest-run discovery", async (t) => {
  const root = join(tmpdir(), `development-cycle-latest-symlink-${process.pid}-${Date.now()}`);
  const outside = join(tmpdir(), `development-cycle-latest-symlink-outside-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";

  const project = "symlink-project";
  const outsideRun = join(outside, "run-20260904120000000-abc123");
  await mkdir(outsideRun, { recursive: true });
  await writeFile(
    join(outsideRun, "status.json"),
    `${JSON.stringify({ phase: "planned", project, runId: "run-20260904120000000-abc123" }, null, 2)}\n`,
  );
  await mkdir(join(root, "state", "runs"), { recursive: true });
  await symlink(outside, join(root, "state", "runs", project), "dir");

  const { default: plugin } = await import(`../dist/index.js?latest-symlink=${Date.now()}`);
  let registered;
  plugin.register({ pluginConfig: {}, registerTool(tool) { registered = tool; } });

  const status = await registered.execute(
    "latest-symlink-status",
    { action: "status", project },
    undefined,
    undefined,
  );

  assert.equal(status.details.ok, true, JSON.stringify(status.details));
  assert.equal(status.details.runId, null);
  assert.equal(status.details.dir, null);
  assert.equal(status.details.status, null);
});

test("lifecycle re-entry preserves the exact legacy project-run pair selected before locking", async (t) => {
  const root = join(tmpdir(), `development-cycle-pair-lock-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED = "false";

  const rawProject = "Project / One";
  const rawRunId = "Run #1";
  const canonicalProject = cleanId(rawProject);
  const legacyProject = "Project-One";
  const legacyRunId = "Run-1";
  const legacyDir = join(root, "state", "runs", legacyProject, legacyRunId);
  const mixedDir = join(root, "state", "runs", canonicalProject, legacyRunId);

  await mkdir(legacyDir, { recursive: true });
  await mkdir(mixedDir, { recursive: true });
  await writeFile(
    join(legacyDir, "status.json"),
    `${JSON.stringify({ phase: "planned", project: legacyProject, runId: legacyRunId, marker: "legacy-pair" }, null, 2)}\n`,
  );
  await writeFile(
    join(mixedDir, "status.json"),
    `${JSON.stringify({ phase: "planned", project: canonicalProject, runId: legacyRunId, marker: "mixed-pair" }, null, 2)}\n`,
  );

  const { default: plugin } = await import(`../dist/index.js?pair-lock=${Date.now()}`);
  let registered;
  plugin.register({ pluginConfig: {}, registerTool(tool) { registered = tool; } });

  const result = await registered.execute(
    "pair-lock-reconcile",
    {
      action: "reconcile",
      project: rawProject,
      runId: rawRunId,
      notifyMain: false,
      autoStopStalled: false,
      autoRunFinalValidation: false,
      autoRunCouncilReview: false,
    },
    undefined,
    undefined,
  );

  assert.equal(result.details.ok, true, JSON.stringify(result.details));
  assert.equal(result.details.dir, legacyDir);
  assert.equal(result.details.project, legacyProject);
  assert.equal(result.details.runId, legacyRunId);
  assert.equal(result.details.status.marker, "legacy-pair");
});
