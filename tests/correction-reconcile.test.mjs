import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function detailsOf(result) { return result?.details ?? result; }

async function loadTool(root) {
  Object.assign(process.env, {
    DEVELOPMENT_CYCLE_STATE_ROOT: join(root, "state"),
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false",
    DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED: "false",
  });
  const { default: plugin } = await import(`../dist/index.js?correction-reconcile=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  return tool;
}

for (const [exitCode, expectedPhase] of [[0, "corrections_completed"], [7, "corrections_failed"]]) {
  test(`correction reconcile exit ${exitCode} maps to ${expectedPhase}`, async (t) => {
    const root = join(tmpdir(), `development-cycle-correction-reconcile-${exitCode}-${process.pid}-${Date.now()}`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const checkout = join(root, "checkout");
    await mkdir(join(checkout, ".git"), { recursive: true });
    const tool = await loadTool(root);
    const project = `correction-reconcile-${exitCode}`;
    const runId = `run-${project}`;
    const requested = detailsOf(await tool.execute("request", { action: "request_plan", project, runId, projectRoot: checkout }, undefined, undefined));
    const dir = requested.dir;
    const statusPath = join(dir, "status.json");
    const sessionDir = join(dir, "corrections_session");
    const sessionPath = join(sessionDir, "status.json");
    const exitCodePath = join(sessionDir, "exit-code.txt");
    const exitedAtPath = join(sessionDir, "exited-at.txt");
    const stdoutPath = join(sessionDir, "stdout.log");
    const stderrPath = join(sessionDir, "stderr.log");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(exitCodePath, `${exitCode}\n`);
    await writeFile(exitedAtPath, "2026-08-29T08:00:00Z\n");
    await writeFile(sessionPath, JSON.stringify({
      status: "running",
      launchState: "running",
      runnerPid: 4243,
      exitCodePath,
      exitedAtPath,
      stdoutPath,
      stderrPath,
    }, null, 2));
    const current = JSON.parse(await readFile(statusPath, "utf8"));
    await writeFile(statusPath, JSON.stringify({
      ...current,
      phase: "corrections_launched",
      owner: "implementation",
      directCorrectionsStatus: sessionPath,
      correctionsStdout: stdoutPath,
      correctionsStderr: stderrPath,
    }, null, 2));

    const reconciled = detailsOf(await tool.execute("reconcile", {
      action: "reconcile",
      project,
      runId,
      projectRoot: checkout,
      notifyMain: false,
      autoStopStalled: false,
      autoRunFinalValidation: false,
      autoRunCouncilReview: false,
    }, undefined, undefined));

    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.status.phase, expectedPhase);
    assert.equal(reconciled.status.directCorrectionsStatus, sessionPath);
    assert.equal(reconciled.status.directImplementationStatus ?? null, null);
    if (exitCode === 0) {
      assert.equal(reconciled.status.externalValidation, "");
      assert.equal(reconciled.status.councilReviewSummary, "");
      assert.equal(reconciled.status.councilReviewNeedsCorrections, null);
    } else {
      assert.match(reconciled.status.error, /exited non-zero: 7/i);
    }
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    assert.equal(session.status, exitCode === 0 ? "completed" : "failed");
    assert.equal(session.launchState, "exited");
    assert.equal(session.exitCode, exitCode);
  });
}
