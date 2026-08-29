import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function detailsOf(result) { return result?.details ?? result; }
function planText(projectRoot, wikiPath) {
  return [
    "# Implementation plan",
    "",
    "## Ordered implementation tasks",
    "- Exercise repeated corrections attempts.",
    "",
    "## Validation checks",
    "- Reconcile each attempt independently.",
    "",
    "## Stop conditions",
    "- Stop on stale-session reuse.",
    "",
    "## Expected artifacts",
    "- Correction session status.",
    "",
    "## Project paths",
    `- projectWikiPath: ${wikiPath}`,
    `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

test("second correction launch failure cannot reuse first correction success", async (t) => {
  const root = join(tmpdir(), `development-cycle-second-correction-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const executable = join(root, "implementation-command.sh");
  const supervisorPath = join(root, "runner-supervisor.py");
  await mkdir(join(checkout, ".git"), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  await writeFile(supervisorPath, [
    "import json, sys",
    "cmd = sys.argv[-1] if len(sys.argv) else ''",
    "if cmd == 'ping':",
    "    print(json.dumps({'ok': True, 'subreaper': True, 'pid': 4242}))",
    "elif len(sys.argv) >= 3 and sys.argv[-3] == 'launch':",
    "    print(json.dumps({'ok': True, 'pid': 4243, 'pgid': 4243, 'supervisorPid': 4242}))",
    "else:",
    "    print(json.dumps({'ok': False, 'argv': sys.argv}))",
    "",
  ].join("\n"));

  Object.assign(process.env, {
    DEVELOPMENT_CYCLE_STATE_ROOT: join(root, "state"),
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false",
    DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED: "false",
    DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND: executable,
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_PATH: supervisorPath,
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "runner-supervisor.sock"),
  });

  const { default: plugin } = await import(`../dist/index.js?second-correction=${Date.now()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });

  const project = "second-correction";
  const runId = "run-second-correction";
  const projectWikiPath = join(root, "docs", project);
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  detailsOf(await tool.execute("request", { action: "request_plan", ...params }, undefined, undefined));
  const recorded = detailsOf(await tool.execute("record", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const cycleStatusPath = join(recorded.dir, "status.json");
  let cycle = JSON.parse(await readFile(cycleStatusPath, "utf8"));
  await writeFile(cycleStatusPath, JSON.stringify({ ...cycle, phase: "needs_corrections", owner: "main" }, null, 2));

  const first = detailsOf(await tool.execute("first-correction", {
    action: "start_corrections",
    ...params,
    implementationAdapter: "command",
    feedbackText: "first correction",
  }, undefined, undefined));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.directCorrectionsStatus);
  const firstSession = JSON.parse(await readFile(first.directCorrectionsStatus, "utf8"));
  await writeFile(firstSession.exitCodePath, "0\n");
  await writeFile(firstSession.exitedAtPath, "2026-08-29T11:00:00Z\n");

  const firstReconcile = detailsOf(await tool.execute("first-reconcile", {
    action: "reconcile", ...params,
    notifyMain: false,
    autoStopStalled: false,
    autoRunFinalValidation: false,
    autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(firstReconcile.status.phase, "corrections_completed");
  assert.equal(firstReconcile.status.directCorrectionsStatus, first.directCorrectionsStatus);

  cycle = JSON.parse(await readFile(cycleStatusPath, "utf8"));
  await writeFile(cycleStatusPath, JSON.stringify({ ...cycle, phase: "needs_corrections", owner: "main" }, null, 2));
  await rm(executable, { force: true });

  const second = detailsOf(await tool.execute("second-correction", {
    action: "start_corrections",
    ...params,
    implementationAdapter: "command",
    feedbackText: "second correction",
  }, undefined, undefined));
  assert.equal(second.ok, false);
  assert.equal(second.phase, "corrections_failed");

  const afterSecond = JSON.parse(await readFile(cycleStatusPath, "utf8"));
  assert.equal(afterSecond.phase, "corrections_failed");
  assert.equal(afterSecond.directCorrectionsStatus, null);
  assert.equal(afterSecond.directCorrectionsStdout, null);
  assert.equal(afterSecond.directCorrectionsStderr, null);
  assert.equal(afterSecond.correctionsStdout, null);
  assert.equal(afterSecond.correctionsStderr, null);
  assert.match(afterSecond.error, /implementation_executable_missing_or_not_executable/);

  const secondReconcile = detailsOf(await tool.execute("second-reconcile", {
    action: "reconcile", ...params,
    notifyMain: false,
    autoStopStalled: false,
    autoRunFinalValidation: false,
    autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(secondReconcile.status.phase, "corrections_failed");
  assert.equal(secondReconcile.status.directCorrectionsStatus, null);
  assert.match(secondReconcile.status.error, /implementation_executable_missing_or_not_executable/);
});
