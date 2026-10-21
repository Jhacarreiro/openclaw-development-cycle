import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { writeCanonicalRoutingConfig } from "./helpers/octopus-routing.mjs";

const execFileAsync = promisify(execFile);
function detailsOf(result) { return result?.details ?? result; }
async function git(cwd, ...args) { return String((await execFileAsync("git", args, { cwd })).stdout || "").trim(); }
function planText(projectRoot, wikiPath) {
  return [
    "# Implementation plan", "",
    "## Ordered implementation tasks", "- Deliver the change.", "",
    "## Validation checks", "- Reconcile the exact attempt output manifest.", "",
    "## Stop conditions", "- Stop when no materialized output exists.", "",
    "## Expected artifacts", "- The delivered worktree.", "",
    "## Project paths", `- projectWikiPath: ${wikiPath}`, `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

// Octopus finishes a run cleanly (exit 0) after its own review converged; the
// cycle then reconciles it with the given stderr.
async function reconcileCompletedOctopusRun(t, stderrLines, { intervention } = {}) {
  const root = join(tmpdir(), `development-cycle-octopus-completed-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  writeCanonicalRoutingConfig(home);
  const checkout = join(root, "checkout");
  const project = "octopus-completed-run";
  const runId = "run-octopus-completed";
  const projectWikiPath = join(root, "docs", project);
  const supervisorPath = join(root, "runner-supervisor.py");
  const octopusRoot = join(root, "octopus");
  await mkdir(checkout, { recursive: true });
  await git(checkout, "init");
  await git(checkout, "config", "user.email", "test@example.com");
  await git(checkout, "config", "user.name", "Test Runner");
  await writeFile(join(checkout, "README.md"), "source\n");
  await git(checkout, "add", "README.md");
  await git(checkout, "commit", "-m", "initial");
  await mkdir(join(octopusRoot, "scripts"), { recursive: true });
  await writeFile(join(octopusRoot, "scripts", "orchestrate.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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
  const { default: plugin } = await import(`../dist/index.js?octopus-completed=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  detailsOf(await tool.execute("request", { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute("record", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const launched = detailsOf(await tool.execute("launch", { action: "start_implementation", ...params, implementationAdapter: "octopus" }, undefined, undefined));
  const attemptId = launched.implementationAttemptId;
  const outputPath = join(home, ".claude-octopus", "worktrees", "tangle", attemptId, "integration");
  const runBranch = `octopus/run/${attemptId}/integration`;
  await mkdir(join(home, ".claude-octopus", "worktrees", "tangle", attemptId), { recursive: true });
  await git(checkout, "worktree", "add", "-b", runBranch, outputPath);
  await writeFile(join(outputPath, "delivered.txt"), "delivered\n");
  const manifestDir = join(home, ".claude-octopus", "results");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, `.tangle-${attemptId}-git.json`), JSON.stringify({
    sourceRepository: await realpath(checkout),
    sourceCommit: await git(checkout, "rev-parse", "HEAD"),
    runBranch,
    runWorktree: await realpath(outputPath),
  }, null, 2));
  const session = JSON.parse(await readFile(launched.directImplementationStatus, "utf8"));
  await writeFile(session.stderrPath, [...stderrLines, ""].join("\n"));
  await writeFile(session.exitCodePath, "0\n");
  await writeFile(session.exitedAtPath, "2026-10-20T16:17:18Z\n");
  await writeFile(launched.directImplementationStatus, JSON.stringify({ ...session, status: "completed", launchState: "exited", exitCode: 0, exitedAt: "2026-10-20T16:17:18Z" }, null, 2));
  if (intervention) await writeFile(join(dirname(launched.directImplementationStatus), "intervention.json"), JSON.stringify(intervention, null, 2));

  const reconcile = async (extra = {}) => detailsOf(await tool.execute("reconcile", {
    action: "reconcile", ...params, notifyMain: false, autoStopStalled: false, autoRunFinalValidation: false, autoRunCouncilReview: false, ...extra,
  }, undefined, undefined));
  const reconciled = await reconcile();
  return Object.assign(reconciled.status, { reconcile, statusPath: join(root, "state", "runs", project, runId, "status.json") });
}

test("A run Octopus completed after its review converged goes on to final validation despite review warnings about timed-out providers", async (t) => {
  const status = await reconcileCompletedOctopusRun(t, [
    // Octopus reports how many reviewers were missing,
    // failed or timed out, including when that count is zero.
    "\u001b[0;34m[2026-10-20 16:47:29]\u001b[0m \u001b[1;33mWARN\u001b[0m: Contextual code review warning: Round 1 was partial: 0 provider(s) missing/failed/timed out, 1 provider output(s) had possible unparsed findings.",
    "\u001b[0;34m[2026-10-20 17:17:18]\u001b[0m \u001b[0;32mINFO\u001b[0m: Contextual code review findings: /tmp/review-findings.json (normal=0)",
    "\u001b[0;34m[2026-10-20 17:17:18]\u001b[0m \u001b[0;32mINFO\u001b[0m: Tangle run completed; preserving isolated branch and worktree for review: octopus/run/x/integration",
  ]);
  assert.equal(status.phase, "implementation_delivered", JSON.stringify(status));
  assert.equal(status.failureClass ?? null, null, JSON.stringify(status));
  assert.match(status.nextAction, /final validation/);
});

test("A run whose council review passed is delivered by reconcile itself when automatic delivery is on", async (t) => {
  const delivered = await reconcileCompletedOctopusRun(t, [
    "\u001b[0;34m[2026-10-20 17:17:18]\u001b[0m \u001b[0;32mINFO\u001b[0m: Tangle run completed; preserving isolated branch and worktree for review: octopus/run/x/integration",
  ]);
  const status = JSON.parse(await readFile(delivered.statusPath, "utf8"));
  // Validation and council review already passed; their own tests cover how the run gets here.
  await writeFile(delivered.statusPath, JSON.stringify({ ...status, phase: "council_validated", councilDecision: "go", nextAction: "Council review passed; write/read one-pager and close or deploy." }, null, 2));
  assert.equal((await delivered.reconcile()).status.phase, "council_validated");
  assert.equal((await delivered.reconcile({ autoFinalizeDelivery: true })).status.phase, "closed_success");
});

test("A council-validated run is not delivered once a newer run of the project has started", async (t) => {
  const validated = await reconcileCompletedOctopusRun(t, [
    "\u001b[0;34m[2026-10-20 17:17:18]\u001b[0m \u001b[0;32mINFO\u001b[0m: Tangle run completed; preserving isolated branch and worktree for review: octopus/run/x/integration",
  ]);
  const status = JSON.parse(await readFile(validated.statusPath, "utf8"));
  await writeFile(validated.statusPath, JSON.stringify({ ...status, phase: "council_validated", councilDecision: "go" }, null, 2));
  const newer = join(validated.statusPath, "..", "..", "octopus-completed-run-20991231000000000-zzzzzz");
  await mkdir(newer, { recursive: true });
  await writeFile(join(newer, "status.json"), JSON.stringify({ phase: "waiting_external_plan" }));
  assert.equal((await validated.reconcile({ autoFinalizeDelivery: true })).status.phase, "council_validated");
});

test("A decision the implementation left on a clean exit is recorded and keeps the delivery PR from merging itself", async (t) => {
  const delivered = await reconcileCompletedOctopusRun(t, [
    "\u001b[0;34m[2026-10-20 17:17:18]\u001b[0m \u001b[0;32mINFO\u001b[0m: Tangle run completed; preserving isolated branch and worktree for review: octopus/run/x/integration",
  ], { intervention: {
    schemaVersion: 1, id: "stronger-operator-authentication", kind: "human_decision",
    question: "Which stronger operator-approval authentication should replace the interim relay check?",
    options: ["operator_one_time_tokens", "gateway_verified_sender_evidence", "none"],
  } });
  assert.equal(delivered.phase, "implementation_delivered", JSON.stringify(delivered));
  assert.equal(delivered.pendingDecision?.id, "stronger-operator-authentication");
  assert.equal(delivered.pendingDecision?.status, "pending");
  const status = JSON.parse(await readFile(delivered.statusPath, "utf8"));
  await writeFile(delivered.statusPath, JSON.stringify({ ...status, phase: "council_validated", councilDecision: "go" }, null, 2));
  await delivered.reconcile({ autoFinalizeDelivery: true });
  const request = JSON.parse(await readFile(join(dirname(delivered.statusPath), "repository_delivery_request.json"), "utf8"));
  assert.equal(request.autoMerge, false);
  assert.deepEqual(request.pendingDecisions.map((decision) => decision.id), ["stronger-operator-authentication"]);
});
