import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { writeCanonicalRoutingConfig } from "./helpers/octopus-routing.mjs";

const execFileAsync = promisify(execFile);
function detailsOf(result) { return result?.details ?? result; }
async function git(cwd, ...args) { return String((await execFileAsync("git", args, { cwd })).stdout || "").trim(); }
function planText(projectRoot, wikiPath) {
  return [
    "# Implementation plan", "",
    "## Ordered implementation tasks", "- Produce a partial Octopus delivery when possible.", "",
    "## Validation checks", "- Reconcile the exact attempt output manifest.", "",
    "## Stop conditions", "- Stop when no materialized output exists.", "",
    "## Expected artifacts", "- Partial output only when a validated worktree exists.", "",
    "## Project paths", `- projectWikiPath: ${wikiPath}`, `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

// Runs a failed Octopus attempt that left a partial worktree and the given
// stderr, then reconciles it; returns the run status and the delivery request.
// With `corrections`, the attempt is a council corrections run instead.
async function reconcileFailedOctopusRun(t, stderrLines, { corrections = false } = {}) {
  const root = join(tmpdir(), `development-cycle-octopus-nonconvergence-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  writeCanonicalRoutingConfig(home);
  const checkout = join(root, "checkout");
  const project = "octopus-review-nonconvergence";
  const runId = "run-octopus-review-nonconvergence";
  const projectWikiPath = join(root, "docs", project);
  const supervisorPath = join(root, "runner-supervisor.py");
  const octopusRoot = join(root, "octopus");
  const deliveryCommand = join(root, "delivery-runner.sh");
  const deliveryMarker = join(root, "delivery-called.json");
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
  await writeFile(deliveryCommand, `#!/bin/sh\ncp "$1" "${deliveryMarker}"\nprintf '%s\\n' '{"ok":true,"merged":false,"url":"https://example.invalid/pr/1"}'\n`, { mode: 0o755 });
  Object.assign(process.env, {
    HOME: home,
    DEVELOPMENT_CYCLE_STATE_ROOT: join(root, "state"),
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false",
    DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED: "true",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_COMMAND: deliveryCommand,
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ARGS_JSON: "[]",
    DEVELOPMENT_CYCLE_OCTOPUS_ROOT: octopusRoot,
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_PATH: supervisorPath,
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "runner-supervisor.sock"),
  });
  const { default: plugin } = await import(`../dist/index.js?octopus-nonconvergence=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  const requested = detailsOf(await tool.execute("request", { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute("record", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const launched = detailsOf(await tool.execute("launch", { action: "start_implementation", ...params, implementationAdapter: "octopus" }, undefined, undefined));
  const attemptId = launched.implementationAttemptId;
  const outputPath = join(home, ".claude-octopus", "worktrees", "tangle", attemptId, "integration");
  const runBranch = `octopus/run/${attemptId}/integration`;
  await mkdir(join(home, ".claude-octopus", "worktrees", "tangle", attemptId), { recursive: true });
  await git(checkout, "worktree", "add", "-b", runBranch, outputPath);
  await writeFile(join(outputPath, "partial.txt"), "partial delivery\n");
  const manifestDir = join(home, ".claude-octopus", "results");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, `.tangle-${attemptId}-git.json`), JSON.stringify({
    sourceRepository: await realpath(checkout),
    sourceCommit: await git(checkout, "rev-parse", "HEAD"),
    runBranch,
    runWorktree: await realpath(outputPath),
  }, null, 2));
  const findingsPath = join(manifestDir, "review-findings-1-octopus-tangle-review-marker.test.json");
  await writeFile(findingsPath, JSON.stringify({ findings: [
    { file: "src/workflow.ts", line: 370, severity: "normal", category: "auth", title: "Publish never checks the hash-bound approval", detail: "Compare the approval hash before posting." },
    { file: "src/db.ts", line: 12, severity: "normal", category: "data-exposure", title: "Database files are created without O_NOFOLLOW", detail: "" },
    { file: "src/cli.ts", line: 5, severity: "nit", category: "usability", title: "Option values that begin with -- are rejected", detail: "" },
  ] }));
  const session = JSON.parse(await readFile(launched.directImplementationStatus, "utf8"));
  await writeFile(session.stderrPath, [...stderrLines(findingsPath), ""].join("\n"));
  await writeFile(session.exitCodePath, "8\n");
  await writeFile(session.exitedAtPath, "2026-08-30T06:30:00Z\n");
  await writeFile(launched.directImplementationStatus, JSON.stringify({ ...session, status: "failed", launchState: "exited", exitCode: 8, exitedAt: "2026-08-30T06:30:00Z" }, null, 2));
  if (corrections) {
    const statusPath = join(requested.dir, "status.json");
    const current = JSON.parse(await readFile(statusPath, "utf8"));
    await writeFile(statusPath, JSON.stringify({
      ...current,
      phase: "corrections_launched",
      owner: "implementation",
      correctionsAttemptId: attemptId,
      directCorrectionsStatus: launched.directImplementationStatus,
      councilReviewFindings: ["Medium: The council finding these corrections were asked to fix. (`src/old.ts`)"],
    }, null, 2));
  }

  const reconciled = detailsOf(await tool.execute("reconcile", {
    action: "reconcile", ...params, notifyMain: false, autoStopStalled: false, autoRunFinalValidation: false, autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(reconciled.status.phase, "closed_partial", JSON.stringify(reconciled.status));
  assert.equal(reconciled.automaticRepositoryDelivery.delivery.classification, "partial");
  const request = JSON.parse(await readFile(deliveryMarker, "utf8"));
  assert.equal(request.projectRoot, await realpath(outputPath));
  return { status: reconciled.status, request };
}

const remainingBlockingFindings = [
  "Publish never checks the hash-bound approval (src/workflow.ts:370): Compare the approval hash before posting.",
  "Database files are created without O_NOFOLLOW (src/db.ts:12)",
];

test("Octopus review that hits the correction ceiling delivers partial output with one follow-up per remaining blocking finding", async (t) => {
  const { status, request } = await reconcileFailedOctopusRun(t, (findingsPath) => [
    // The reviewed code handles EACCES; that text in the log must not reclassify the run as a local runtime fault.
    "\u001b[0;34m[2026-10-15 07:50:00]\u001b[0m INFO: review_run: finding mentions EACCES when chmod fails",
    `\u001b[0;34m[2026-10-15 08:12:12]\u001b[0m \u001b[0;31mERROR\u001b[0m: Correction loop hit the absolute round ceiling (10) with 2 blocking finding(s) remaining: ${findingsPath} — raise or disable with OCTOPUS_TANGLE_CORRECTION_HARD_CAP (0 = no ceiling)`,
  ]);
  assert.equal(status.failureClass, "review_non_convergence");
  assert.deepEqual(request.findings, remainingBlockingFindings);
});

test("Octopus that gives up on corrections after a review left blocking findings delivers those findings as follow-ups", async (t) => {
  const { status, request } = await reconcileFailedOctopusRun(t, (findingsPath) => [
    `\u001b[0;34m[2026-10-19 02:38:43]\u001b[0m \u001b[0;32mINFO\u001b[0m: Contextual code review findings: ${findingsPath} (normal=2)`,
    "\u001b[0;34m[2026-10-19 02:38:43]\u001b[0m \u001b[0;32mINFO\u001b[0m: Step 5: Applying contextual review corrections (round=1, role=implementer, strategy=delta, stall_window=1800s)",
    "\u001b[0;34m[2026-10-19 03:08:47]\u001b[0m \u001b[1;33mWARN\u001b[0m: Correction round 1 stalled; partial writes changed=0",
    "\u001b[0;34m[2026-10-19 03:08:47]\u001b[0m \u001b[0;31mERROR\u001b[0m: Tangle retry supervision failed after correction; stopping before further review or delivery",
    "\u001b[0;34m[2026-10-19 03:08:47]\u001b[0m \u001b[1;33mWARN\u001b[0m: Tangle run failed; preserving isolated branch and worktree for inspection: octopus/run/x/integration",
  ]);
  assert.equal(status.failureClass, "review_non_convergence");
  assert.equal(status.reviewNonConvergence.roundCeiling, 1);
  assert.deepEqual(request.findings, remainingBlockingFindings);
});

test("A run that fails for another reason after a review is classified by that failure and opens no issue from the cycle's own advice", async (t) => {
  const { status, request } = await reconcileFailedOctopusRun(t, (findingsPath) => [
    `\u001b[0;34m[2026-10-19 02:13:00]\u001b[0m \u001b[0;32mINFO\u001b[0m: Contextual code review findings: ${findingsPath} (normal=2)`,
    "\u001b[0;34m[2026-10-19 02:14:30]\u001b[0m \u001b[0;31mERROR\u001b[0m: Permission denied writing the provider history",
    "\u001b[0;34m[2026-10-19 02:14:33]\u001b[0m \u001b[0;31mERROR\u001b[0m: Quality gate FAILED with 66%. Aborting workflow.",
    "\u001b[0;34m[2026-10-19 03:08:47]\u001b[0m \u001b[1;33mWARN\u001b[0m: Tangle run failed; preserving isolated branch and worktree for inspection: octopus/run/x/integration",
  ]);
  assert.equal(status.failureClass, "local_runtime_fault");
  assert.deepEqual(request.findings, []);
});

test("Council corrections whose review does not converge deliver the corrected branch and open issues only for what is left", async (t) => {
  const { status, request } = await reconcileFailedOctopusRun(t, (findingsPath) => [
    `\u001b[0;34m[2026-10-21 18:24:49]\u001b[0m \u001b[0;31mERROR\u001b[0m: Correction loop hit the absolute round ceiling (3) with 2 blocking finding(s) remaining: ${findingsPath} — raise or disable with OCTOPUS_TANGLE_CORRECTION_HARD_CAP (0 = no ceiling)`,
  ], { corrections: true });
  assert.equal(status.failureClass, "review_non_convergence");
  assert.deepEqual(request.findings, remainingBlockingFindings);
});
