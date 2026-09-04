import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
function detailsOf(result) { return result?.details ?? result; }
async function git(cwd, ...args) { return String((await execFileAsync("git", args, { cwd })).stdout || "").trim(); }
function planText(projectRoot, wikiPath) {
  return [
    "# Implementation plan", "",
    "## Ordered implementation tasks", "- Produce a reviewed Octopus delivery.", "",
    "## Validation checks", "- Preserve the exact materialized output if only review infrastructure fails.", "",
    "## Stop conditions", "- Never relaunch implementation automatically after a review-infrastructure-only failure.", "",
    "## Expected artifacts", "- Durable review failure and recovery evidence.", "",
    "## Project paths", `- projectWikiPath: ${wikiPath}`, `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

test("review infrastructure failure preserves and resumes the exact Octopus output", async (t) => {
  const root = join(tmpdir(), `development-cycle-review-resume-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const checkout = join(root, "checkout");
  const project = "review-infrastructure-resume";
  const runId = "run-review-infrastructure-resume";
  const projectWikiPath = join(root, "docs", project);
  const supervisorPath = join(root, "runner-supervisor.py");
  const octopusRoot = join(root, "octopus");
  const deliveryMarker = join(root, "delivery-called");

  await mkdir(checkout, { recursive: true });
  await git(checkout, "init");
  await git(checkout, "config", "user.email", "test@example.com");
  await git(checkout, "config", "user.name", "Test Runner");
  await writeFile(join(checkout, "README.md"), "source\n");
  await git(checkout, "add", "README.md");
  await git(checkout, "commit", "-m", "initial");
  await mkdir(join(octopusRoot, "scripts"), { recursive: true });
  await writeFile(join(octopusRoot, "scripts", "orchestrate.sh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(supervisorPath, [
    "import json, os, sys",
    "cmd = sys.argv[-1] if len(sys.argv) else ''",
    "pid = os.getppid()",
    "if cmd == 'ping': print(json.dumps({'ok': True, 'subreaper': True, 'pid': pid}))",
    "elif len(sys.argv) >= 3 and sys.argv[-3] == 'launch': print(json.dumps({'ok': True, 'pid': pid, 'pgid': os.getpgid(pid), 'supervisorPid': pid}))",
    "else: print(json.dumps({'ok': False, 'argv': sys.argv}))",
  ].join("\n"));

  Object.assign(process.env, {
    HOME: home,
    DEVELOPMENT_CYCLE_STATE_ROOT: join(root, "state"),
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false",
    DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED: "false",
    DEVELOPMENT_CYCLE_OCTOPUS_ROOT: octopusRoot,
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_PATH: supervisorPath,
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "runner-supervisor.sock"),
  });

  const { default: plugin } = await import(`../dist/index.js?review-resume=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  detailsOf(await tool.execute("request", { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute("record", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const launched = detailsOf(await tool.execute("launch", { action: "start_implementation", ...params, implementationAdapter: "octopus" }, undefined, undefined));
  assert.equal(launched.ok, true, JSON.stringify(launched));

  const attemptId = launched.implementationAttemptId;
  const outputPath = join(home, ".claude-octopus", "worktrees", "tangle", attemptId, "integration");
  const runBranch = `octopus/run/${attemptId}/integration`;
  await mkdir(join(home, ".claude-octopus", "worktrees", "tangle", attemptId), { recursive: true });
  await git(checkout, "worktree", "add", "-b", runBranch, outputPath);
  await writeFile(join(outputPath, "delivery.txt"), "delivered\n");
  const sourceCommit = await git(checkout, "rev-parse", "HEAD");
  const manifestDir = join(home, ".claude-octopus", "results");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, `.tangle-${attemptId}-git.json`), JSON.stringify({
    sourceRepository: await realpath(checkout), sourceCommit, runBranch, runWorktree: await realpath(outputPath),
  }, null, 2));

  const session = JSON.parse(await readFile(launched.directImplementationStatus, "utf8"));
  await writeFile(session.stdoutPath || session.logs?.stdout, [
    "Earlier provider task timed out and was retried successfully.",
    "Retry progress: 3/3 tasks",
    "SUCCESS: Recorded decision for phase 'validate_tangle_results'",
    "Quality Gate: CHALLENGED (100% of tangle results succeeded)",
    "Proof packet: /tmp/review-proof-packet",
    "+-----------------------------------------------------------------+",
    "|  /octo:review - Multi-LLM Code Review Results                  |",
    "+-----------------------------------------------------------------+",
    "WARNING: No changes found to review",
    "This is NOT a clean review — zero providers returned results.",
  ].join("\n") + "\n");
  await writeFile(session.exitCodePath, "1\n");
  await writeFile(session.exitedAtPath, "2026-09-03T18:30:00Z\n");
  await writeFile(launched.directImplementationStatus, JSON.stringify({
    ...session, status: "failed", launchState: "exited", exitCode: 1, exitedAt: "2026-09-03T18:30:00Z",
  }, null, 2));

  const reconciled = detailsOf(await tool.execute("reconcile", {
    action: "reconcile", ...params, notifyMain: false, autoStopStalled: false, autoRunFinalValidation: false, autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.equal(reconciled.status.phase, "review_infrastructure_failed");
  assert.equal(reconciled.status.failureClass, "review_infrastructure_failed");
  assert.equal(reconciled.status.reviewInfrastructureResumeEligible, true);
  assert.equal(reconciled.status.outputPath, await realpath(outputPath));
  assert.equal(reconciled.status.implementationOutputHandoff.ok, true);
  assert.equal(reconciled.status.implementationOutputHandoff.attemptId, attemptId);
  assert.ok(reconciled.status.reviewInfrastructureFailureEvidence);
  await access(reconciled.status.reviewInfrastructureFailureEvidence);
  await assert.rejects(access(deliveryMarker));

  const directValidation = detailsOf(await tool.execute("validate-too-early", { action: "run_final_validation", ...params }, undefined, undefined));
  assert.equal(directValidation.ok, false);
  assert.equal(directValidation.error, "invalid_phase_transition");

  const resumed = detailsOf(await tool.execute("resume", { action: "resume_finalization", ...params }, undefined, undefined));
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.status.phase, "implementation_delivered");
  assert.equal(resumed.status.outputPath, await realpath(outputPath));
  assert.equal(resumed.status.reviewInfrastructureResumeEligible, false);
  assert.equal(resumed.status.resumedFromPhase, "review_infrastructure_failed");
  assert.ok(resumed.status.reviewInfrastructureRecovery);
  await access(resumed.status.reviewInfrastructureRecovery);
  assert.match(resumed.status.nextAction, /run_final_validation/);
  await assert.rejects(access(deliveryMarker));

  // A second run proves fail-closed behavior when "No changes" coexists with
  // a real provider/auth blocker. It must not become resume-eligible.
  const blockedRunId = `${runId}-auth-blocked`;
  const blockedParams = { ...params, runId: blockedRunId };
  detailsOf(await tool.execute("request-blocked", { action: "request_plan", ...blockedParams }, undefined, undefined));
  detailsOf(await tool.execute("record-blocked", { action: "record_plan", ...blockedParams, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const blockedLaunch = detailsOf(await tool.execute("launch-blocked", { action: "start_implementation", ...blockedParams, implementationAdapter: "octopus" }, undefined, undefined));
  assert.equal(blockedLaunch.ok, true, JSON.stringify(blockedLaunch));
  const blockedAttemptId = blockedLaunch.implementationAttemptId;
  const blockedOutputPath = join(home, ".claude-octopus", "worktrees", "tangle", blockedAttemptId, "integration");
  const blockedRunBranch = `octopus/run/${blockedAttemptId}/integration`;
  await mkdir(join(home, ".claude-octopus", "worktrees", "tangle", blockedAttemptId), { recursive: true });
  await git(checkout, "worktree", "add", "-b", blockedRunBranch, blockedOutputPath);
  await writeFile(join(blockedOutputPath, "delivery.txt"), "blocked-delivery\n");
  await writeFile(join(manifestDir, `.tangle-${blockedAttemptId}-git.json`), JSON.stringify({
    sourceRepository: await realpath(checkout), sourceCommit, runBranch: blockedRunBranch, runWorktree: await realpath(blockedOutputPath),
  }, null, 2));
  const blockedSession = JSON.parse(await readFile(blockedLaunch.directImplementationStatus, "utf8"));
  await writeFile(blockedSession.stdoutPath || blockedSession.logs?.stdout, [
    "Quality Gate: CHALLENGED (100% of tangle results succeeded)",
    "Proof packet: /tmp/review-proof-packet-auth",
    "|  /octo:review - Multi-LLM Code Review Results                  |",
    "WARNING: No changes found to review",
    "ERROR: 401 Unauthorized: Missing bearer or basic authentication in header",
    "This is NOT a clean review — zero providers returned results.",
  ].join("\n") + "\n");
  await writeFile(blockedSession.exitCodePath, "1\n");
  await writeFile(blockedSession.exitedAtPath, "2026-09-03T18:40:00Z\n");
  await writeFile(blockedLaunch.directImplementationStatus, JSON.stringify({
    ...blockedSession, status: "failed", launchState: "exited", exitCode: 1, exitedAt: "2026-09-03T18:40:00Z",
  }, null, 2));
  const blockedReconcile = detailsOf(await tool.execute("reconcile-blocked", {
    action: "reconcile", ...blockedParams, notifyMain: false, autoStopStalled: false, autoRunFinalValidation: false, autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(blockedReconcile.status.phase, "implementation_failed");
  assert.notEqual(blockedReconcile.status.reviewInfrastructureResumeEligible, true);
});
