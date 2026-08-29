import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function detailsOf(result) { return result?.details ?? result; }
function planText(projectRoot, wikiPath) {
  return [
    "# Implementation plan",
    "",
    "## Ordered implementation tasks",
    "- Exercise immutable attempt isolation.",
    "",
    "## Validation checks",
    "- Reconcile only the active attempt.",
    "",
    "## Stop conditions",
    "- Stop on cross-attempt state contamination.",
    "",
    "## Expected artifacts",
    "- Per-attempt runner status.",
    "",
    "## Project paths",
    `- projectWikiPath: ${wikiPath}`,
    `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

test("late finalization from an old implementation attempt cannot complete the new attempt", async (t) => {
  const root = join(tmpdir(), `development-cycle-late-attempt-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const project = "late-attempt-isolation";
  const runId = "run-late-attempt-isolation";
  const projectWikiPath = join(root, "docs", project);
  const supervisorPath = join(root, "runner-supervisor.py");
  await mkdir(join(checkout, ".git"), { recursive: true });
  await writeFile(supervisorPath, [
    "import json, os, sys",
    "cmd = sys.argv[-1] if len(sys.argv) else ''",
    "pid = os.getppid()",
    "if cmd == 'ping':",
    "    print(json.dumps({'ok': True, 'subreaper': True, 'pid': pid}))",
    "elif len(sys.argv) >= 3 and sys.argv[-3] == 'launch':",
    "    print(json.dumps({'ok': True, 'pid': pid, 'pgid': os.getpgid(pid), 'supervisorPid': pid}))",
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
    DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND: "/bin/true",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_PATH: supervisorPath,
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "runner-supervisor.sock"),
  });

  const { default: plugin } = await import(`../dist/index.js?late-attempt=${Date.now()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  detailsOf(await tool.execute("request", { action: "request_plan", ...params }, undefined, undefined));
  const recorded = detailsOf(await tool.execute("record", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const cycleStatusPath = join(recorded.dir, "status.json");

  const first = detailsOf(await tool.execute("first", { action: "start_implementation", ...params, implementationAdapter: "command" }, undefined, undefined));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.implementationAttemptId);
  assert.ok(first.directImplementationStatus);
  assert.match(first.directImplementationStatus, /implementation_session\/attempts\//);

  let cycle = JSON.parse(await readFile(cycleStatusPath, "utf8"));
  cycle.phase = "implementation_failed";
  cycle.owner = "main";
  await writeFile(cycleStatusPath, JSON.stringify(cycle, null, 2));

  const second = detailsOf(await tool.execute("second", { action: "start_implementation", ...params, implementationAdapter: "command" }, undefined, undefined));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.implementationAttemptId, first.implementationAttemptId);
  assert.notEqual(second.directImplementationStatus, first.directImplementationStatus);
  assert.match(second.directImplementationStatus, /implementation_session\/attempts\//);

  // Simulate the old runner finalizing after the new attempt is already active.
  const firstSession = JSON.parse(await readFile(first.directImplementationStatus, "utf8"));
  await writeFile(firstSession.exitCodePath, "0\n");
  await writeFile(firstSession.exitedAtPath, "2026-08-29T15:30:00Z\n");
  await writeFile(first.directImplementationStatus, JSON.stringify({
    ...firstSession,
    status: "completed",
    launchState: "exited",
    exitCode: 0,
    exitedAt: "2026-08-29T15:30:00Z",
  }, null, 2));

  const activeBeforeReconcile = JSON.parse(await readFile(second.directImplementationStatus, "utf8"));
  assert.equal(activeBeforeReconcile.status, "running");
  assert.equal(activeBeforeReconcile.attemptId, second.implementationAttemptId);

  const reconciled = detailsOf(await tool.execute("reconcile-active", {
    action: "reconcile", ...params,
    notifyMain: false,
    autoStopStalled: false,
    autoRunFinalValidation: false,
    autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.status.phase, "implementation_launched");
  assert.equal(reconciled.status.implementationAttemptId, second.implementationAttemptId);
  assert.equal(reconciled.status.directImplementationStatus, second.directImplementationStatus);

  // Secondary defense: even a stale/corrupted pointer cannot make the old attempt authoritative.
  cycle = JSON.parse(await readFile(cycleStatusPath, "utf8"));
  await writeFile(cycleStatusPath, JSON.stringify({
    ...cycle,
    phase: "implementation_launched",
    implementationAttemptId: second.implementationAttemptId,
    directImplementationStatus: first.directImplementationStatus,
  }, null, 2));

  const mismatch = detailsOf(await tool.execute("reconcile-mismatch", {
    action: "reconcile", ...params,
    notifyMain: false,
    autoStopStalled: false,
    autoRunFinalValidation: false,
    autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(mismatch.status.phase, "implementation_launched");
  assert.equal(mismatch.status.runnerAttemptMismatch.activeAttemptId, second.implementationAttemptId);
  assert.equal(mismatch.status.runnerAttemptMismatch.observedAttemptId, first.implementationAttemptId);

  // Repeat the same late-finalization race for corrections attempts.
  const correctionProject = "late-correction-attempt-isolation";
  const correctionRunId = "run-late-correction-attempt-isolation";
  const correctionWikiPath = join(root, "docs", correctionProject);
  const correctionParams = { project: correctionProject, runId: correctionRunId, projectRoot: checkout, projectWikiPath: correctionWikiPath };
  detailsOf(await tool.execute("correction-request", { action: "request_plan", ...correctionParams }, undefined, undefined));
  const correctionRecorded = detailsOf(await tool.execute("correction-record", {
    action: "record_plan",
    ...correctionParams,
    planText: planText(checkout, correctionWikiPath),
  }, undefined, undefined));
  const correctionCyclePath = join(correctionRecorded.dir, "status.json");
  let correctionCycle = JSON.parse(await readFile(correctionCyclePath, "utf8"));
  await writeFile(correctionCyclePath, JSON.stringify({
    ...correctionCycle,
    phase: "council_review_needs_corrections",
    owner: "main",
    implementationAdapter: "command",
  }, null, 2));

  const firstCorrection = detailsOf(await tool.execute("first-correction", {
    action: "start_corrections",
    ...correctionParams,
    implementationAdapter: "command",
    feedbackText: "first correction attempt",
  }, undefined, undefined));
  assert.equal(firstCorrection.ok, true, JSON.stringify(firstCorrection));
  assert.ok(firstCorrection.correctionsAttemptId);
  assert.ok(firstCorrection.directCorrectionsStatus);
  assert.match(firstCorrection.directCorrectionsStatus, /corrections_session\/attempts\//);

  correctionCycle = JSON.parse(await readFile(correctionCyclePath, "utf8"));
  await writeFile(correctionCyclePath, JSON.stringify({
    ...correctionCycle,
    phase: "council_review_needs_corrections",
    owner: "main",
  }, null, 2));

  const secondCorrection = detailsOf(await tool.execute("second-correction", {
    action: "start_corrections",
    ...correctionParams,
    implementationAdapter: "command",
    feedbackText: "second correction attempt",
  }, undefined, undefined));
  assert.equal(secondCorrection.ok, true, JSON.stringify(secondCorrection));
  assert.notEqual(secondCorrection.correctionsAttemptId, firstCorrection.correctionsAttemptId);
  assert.notEqual(secondCorrection.directCorrectionsStatus, firstCorrection.directCorrectionsStatus);

  const firstCorrectionSession = JSON.parse(await readFile(firstCorrection.directCorrectionsStatus, "utf8"));
  await writeFile(firstCorrectionSession.exitCodePath, "0\n");
  await writeFile(firstCorrectionSession.exitedAtPath, "2026-08-29T15:45:00Z\n");
  await writeFile(firstCorrection.directCorrectionsStatus, JSON.stringify({
    ...firstCorrectionSession,
    status: "completed",
    launchState: "exited",
    exitCode: 0,
    exitedAt: "2026-08-29T15:45:00Z",
  }, null, 2));

  const activeCorrection = JSON.parse(await readFile(secondCorrection.directCorrectionsStatus, "utf8"));
  assert.equal(activeCorrection.status, "running");
  assert.equal(activeCorrection.attemptId, secondCorrection.correctionsAttemptId);

  const correctionReconciled = detailsOf(await tool.execute("reconcile-active-correction", {
    action: "reconcile", ...correctionParams,
    notifyMain: false,
    autoStopStalled: false,
    autoRunFinalValidation: false,
    autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(correctionReconciled.status.phase, "corrections_launched");
  assert.equal(correctionReconciled.status.correctionsAttemptId, secondCorrection.correctionsAttemptId);
  assert.equal(correctionReconciled.status.directCorrectionsStatus, secondCorrection.directCorrectionsStatus);

  correctionCycle = JSON.parse(await readFile(correctionCyclePath, "utf8"));
  await writeFile(correctionCyclePath, JSON.stringify({
    ...correctionCycle,
    phase: "corrections_launched",
    correctionsAttemptId: secondCorrection.correctionsAttemptId,
    directCorrectionsStatus: firstCorrection.directCorrectionsStatus,
  }, null, 2));

  const correctionMismatch = detailsOf(await tool.execute("reconcile-correction-mismatch", {
    action: "reconcile", ...correctionParams,
    notifyMain: false,
    autoStopStalled: false,
    autoRunFinalValidation: false,
    autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(correctionMismatch.status.phase, "corrections_launched");
  assert.equal(correctionMismatch.status.runnerAttemptMismatch.activeAttemptId, secondCorrection.correctionsAttemptId);
  assert.equal(correctionMismatch.status.runnerAttemptMismatch.observedAttemptId, firstCorrection.correctionsAttemptId);
});
