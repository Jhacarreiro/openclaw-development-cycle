import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
    "# Implementation plan",
    "",
    "## Ordered implementation tasks",
    "- Produce a partial Octopus delivery when possible.",
    "",
    "## Validation checks",
    "- Reconcile the exact attempt output manifest.",
    "",
    "## Stop conditions",
    "- Stop when no materialized output exists.",
    "",
    "## Expected artifacts",
    "- Partial output only when a validated worktree exists.",
    "",
    "## Project paths",
    `- projectWikiPath: ${wikiPath}`,
    `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

async function setup(t, label) {
  const root = join(tmpdir(), `development-cycle-octopus-failure-${label}-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  writeCanonicalRoutingConfig(home);
  const checkout = join(root, "checkout");
  const project = `octopus-failure-${label}`;
  const runId = `run-octopus-failure-${label}`;
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

  const { default: plugin } = await import(`../dist/index.js?octopus-failure-delivery=${label}-${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  detailsOf(await tool.execute(`request-${label}`, { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute(`record-${label}`, { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const launched = detailsOf(await tool.execute(`launch-${label}`, { action: "start_implementation", ...params, implementationAdapter: "octopus" }, undefined, undefined));
  assert.equal(launched.ok, true, JSON.stringify(launched));
  return { root, home, checkout, project, runId, projectWikiPath, tool, params, launched, deliveryMarker };
}

async function forceNonZero(launched) {
  const session = JSON.parse(await readFile(launched.directImplementationStatus, "utf8"));
  await writeFile(session.exitCodePath, "8\n");
  await writeFile(session.exitedAtPath, "2026-08-30T06:30:00Z\n");
  await writeFile(launched.directImplementationStatus, JSON.stringify({ ...session, status: "failed", launchState: "exited", exitCode: 8, exitedAt: "2026-08-30T06:30:00Z" }, null, 2));
}

test("failed Octopus attempt without output suppresses automatic repository delivery", async (t) => {
  const ctx = await setup(t, "no-output");
  await forceNonZero(ctx.launched);
  const reconciled = detailsOf(await ctx.tool.execute("reconcile-no-output", {
    action: "reconcile", ...ctx.params, notifyMain: false, autoStopStalled: false, autoRunFinalValidation: false, autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(reconciled.status.phase, "implementation_failed");
  assert.equal(reconciled.status.outputPath ?? null, null);
  assert.equal(reconciled.status.implementationOutputHandoff.ok, false);
  assert.equal(reconciled.status.implementationOutputHandoff.error, "octopus_output_manifest_missing");
  assert.equal(reconciled.status.repositoryDeliverySuppressed.reason, "octopus_output_path_missing");
  assert.equal(reconciled.automaticRepositoryDelivery, null);
  await assert.rejects(access(ctx.deliveryMarker));

  const finalized = detailsOf(await ctx.tool.execute("finalize-no-output", { action: "finalize_delivery", ...ctx.params }, undefined, undefined));
  assert.equal(finalized.ok, false);
  assert.equal(finalized.phase, "closed_invalid");
  assert.equal(finalized.delivery.reason, "octopus_output_path_missing");
  await assert.rejects(access(ctx.deliveryMarker));
  const request = JSON.parse(await readFile(join(reconciled.dir, "repository_delivery_request.json"), "utf8"));
  assert.equal(request.projectRoot, "");
  assert.equal(request.sourceProjectRoot, ctx.checkout);
  assert.equal(request.outputPath, null);
  assert.equal(request.classification, "invalid");
});

async function preservedAttempt(ctx, { attemptId = ctx.launched.implementationAttemptId, pristine = false, foreign = false, reviewVerification = "unknown" } = {}) {
  const outputPath = join(ctx.home, ".claude-octopus", "worktrees", "tangle", attemptId, "integration");
  const runBranch = `octopus/run/${attemptId}/integration`;
  const baseline = await git(ctx.checkout, "rev-parse", "HEAD");
  await mkdir(join(outputPath, ".."), { recursive:true });
  if (foreign) {
    await git(ctx.checkout, "clone", "--quiet", ctx.checkout, outputPath);
    await git(outputPath, "checkout", "-b", runBranch);
  } else await git(ctx.checkout, "worktree", "add", "-b", runBranch, outputPath);
  if (!pristine) await writeFile(join(outputPath, "partial.txt"), "preserve completed work\n");
  const results = join(ctx.home, ".claude-octopus", "results");
  await mkdir(results, { recursive:true });
  await writeFile(join(results, `.tangle-${attemptId}-git.json`), JSON.stringify({ sourceRepository:ctx.checkout, sourceCommit:baseline, runWorktree:outputPath, runBranch, reviewVerification }));
  return { outputPath, baseline };
}

async function stoppedState(ctx, patch = {}) {
  await forceNonZero(ctx.launched);
  const before = detailsOf(await ctx.tool.execute("read-state", { action:"status", ...ctx.params }, undefined, undefined));
  const path = join(before.dir, "status.json");
  await writeFile(path, JSON.stringify({ ...before.status, phase:"stopped", exitCode:143, outputPath:null, ...patch }));
}

async function reconcile(ctx) {
  return detailsOf(await ctx.tool.execute("recover", { action:"reconcile", ...ctx.params, notifyMain:false, autoStopStalled:false, autoRunFinalValidation:false, autoRunCouncilReview:false }, undefined, undefined));
}

test("a stopped attempt recovers dirty work and publishes a partial draft without restarting", async t => {
  const ctx = await setup(t, "stopped-progress");
  const { outputPath, baseline } = await preservedAttempt(ctx);
  await stoppedState(ctx, { validationEvidence:{ old:true } });
  const out = await reconcile(ctx);
  assert.equal(out.status.phase, "closed_partial");
  assert.equal(out.status.outputRecovery.sourcePhase, "stopped");
  assert.equal(out.status.outputPath, outputPath);
  assert.equal(out.status.validationEvidence, null);
  assert.equal(out.automaticFollowUp, null);
  const request = JSON.parse(await readFile(ctx.deliveryMarker, "utf8"));
  assert.equal(request.draft, true); assert.equal(request.autoMerge, false);
  assert.equal(request.preservedBaseline, baseline);
  assert.equal(request.findings.length, 3);
  assert.match(request.findings.join("\n"), /acceptance criterion/);
  assert.equal(await readFile(join(outputPath,"partial.txt"),"utf8"), "preserve completed work\n");
});

test("an unchanged attempt stays pristine even when the canonical checkout advances", async t => {
  const ctx = await setup(t, "pristine-manifest");
  await preservedAttempt(ctx, { pristine:true });
  await writeFile(join(ctx.checkout,"source-update.txt"),"unrelated source update\n");
  await git(ctx.checkout,"add","source-update.txt"); await git(ctx.checkout,"commit","-m","source update");
  await stoppedState(ctx);
  const out = await reconcile(ctx);
  assert.equal(out.status.outputRecovery.error, "octopus_output_pristine");
  assert.equal(out.status.outputPath, null);
  await assert.rejects(access(ctx.deliveryMarker));
});

test("committed work is inventoried relative to the captured baseline", async t => {
  const ctx = await setup(t, "committed-progress");
  const { outputPath, baseline } = await preservedAttempt(ctx);
  await git(outputPath,"add","partial.txt"); await git(outputPath,"commit","-m","preserved progress");
  await stoppedState(ctx);
  const out = await reconcile(ctx);
  assert.equal(out.status.outputRecovery.committedProgress, true);
  assert.equal(out.status.outputRecovery.dirtyProgress, false);
  assert.equal(out.status.outputRecovery.baseline, baseline);
  assert.equal(out.status.phase, "closed_partial");
});

test("a similarly named branch in another repository cannot replace the linked worktree", async t => {
  const ctx = await setup(t, "foreign-progress");
  await preservedAttempt(ctx, { foreign:true });
  await stoppedState(ctx);
  const out = await reconcile(ctx);
  assert.equal(out.status.outputRecovery.error, "octopus_output_repository_mismatch");
  await assert.rejects(access(ctx.deliveryMarker));
});

test("recovery uses the current corrections attempt after a stop", async t => {
  const ctx = await setup(t, "corrections-stop");
  await preservedAttempt(ctx);
  const latest = await preservedAttempt(ctx, { attemptId:"corrections-current" });
  await stoppedState(ctx, { correctionsAttemptId:"corrections-current" });
  const out = await reconcile(ctx);
  assert.equal(out.status.outputPath, latest.outputPath);
  assert.equal(out.status.outputRecovery.attemptId, "corrections-current");
});

test("incomplete verification opens validation work instead of candidate-defect issues", async t => {
  const ctx = await setup(t, "unverified-progress");
  await preservedAttempt(ctx, { reviewVerification:"incomplete" });
  await stoppedState(ctx, { councilReviewFindings:["Speculative defect"], reviewNonConvergence:{ ok:true, remaining:[{ title:"Unverified candidate" }] } });
  const out = await reconcile(ctx);
  const request = JSON.parse(await readFile(ctx.deliveryMarker,"utf8"));
  assert.equal(out.status.failureClass,"review_infrastructure_failed");
  assert.equal(request.findings.length,3);
  assert.match(request.findings.join("\n"),/Complete independent review/);
  assert.doesNotMatch(request.findings.join("\n"),/Speculative defect|Unverified candidate/);
  assert.equal(out.automaticFollowUp,null);
});

test("application rate-limit review prose cannot cancel progress; incomplete review still preserves remaining validation", async t => {
  const ctx = await setup(t,"causal-replay");
  await preservedAttempt(ctx,{reviewVerification:"incomplete"});
  const session = JSON.parse(await readFile(ctx.launched.directImplementationStatus,"utf8"));
  await writeFile(session.stdoutPath,"Review finding: matching has no concurrency or rate limits. HTTP 429 handling belongs to the application.\n");
  const active = await reconcile(ctx);
  assert.equal(active.status.phase,"implementation_launched");
  assert.notEqual(active.status.failureClass,"rate_limited");
  assert.equal(active.automaticRepositoryDelivery,null);
  const policyStop = detailsOf(await ctx.tool.execute("policy-stop",{action:"stop_implementation",...ctx.params,stopIntent:"failure-policy"},undefined,undefined));
  assert.equal(policyStop.error,"automatic_stop_not_recommended");
  await forceNonZero(ctx.launched);
  const partial = await reconcile(ctx);
  assert.equal(partial.status.phase,"closed_partial");
  assert.equal(partial.status.failureClass,"review_infrastructure_failed");
  assert.equal(partial.automaticFollowUp,null);
  const request = JSON.parse(await readFile(ctx.deliveryMarker,"utf8"));
  assert.equal(request.draft,true);
  assert.match(request.findings.join("\n"),/Complete independent review/);
});
