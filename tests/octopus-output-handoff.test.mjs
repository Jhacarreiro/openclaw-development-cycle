import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
function detailsOf(result) { return result?.details ?? result; }
function planText(projectRoot, wikiPath) {
  return [
    "# Implementation plan",
    "",
    "## Ordered implementation tasks",
    "- Produce an isolated Octopus delivery worktree.",
    "",
    "## Validation checks",
    "- Reconcile the exact attempt output manifest.",
    "",
    "## Stop conditions",
    "- Stop if source, branch, or worktree identity does not match.",
    "",
    "## Expected artifacts",
    "- Validated outputPath handoff.",
    "",
    "## Project paths",
    `- projectWikiPath: ${wikiPath}`,
    `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd })).stdout || "").trim();
}

test("Octopus reconcile promotes the exact Tangle worktree manifest to outputPath", async (t) => {
  const root = join(tmpdir(), `development-cycle-octopus-output-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const checkout = join(root, "checkout");
  const project = "octopus-output-handoff";
  const runId = "run-octopus-output-handoff";
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
    "if cmd == 'ping':",
    "    print(json.dumps({'ok': True, 'subreaper': True, 'pid': pid}))",
    "elif len(sys.argv) >= 3 and sys.argv[-3] == 'launch':",
    "    print(json.dumps({'ok': True, 'pid': pid, 'pgid': os.getpgid(pid), 'supervisorPid': pid}))",
    "else:",
    "    print(json.dumps({'ok': False, 'argv': sys.argv}))",
    "",
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

  const { default: plugin } = await import(`../dist/index.js?octopus-output=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  detailsOf(await tool.execute("request", { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute("record", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const launched = detailsOf(await tool.execute("launch", { action: "start_implementation", ...params, implementationAdapter: "octopus" }, undefined, undefined));
  assert.equal(launched.ok, true, JSON.stringify(launched));
  const attemptId = launched.implementationAttemptId;
  assert.ok(attemptId);

  const outputPath = join(home, ".claude-octopus", "worktrees", "tangle", attemptId, "integration");
  const runBranch = `octopus/run/${attemptId}/integration`;
  await mkdir(join(home, ".claude-octopus", "worktrees", "tangle", attemptId), { recursive: true });
  await git(checkout, "worktree", "add", "-b", runBranch, outputPath);
  await writeFile(join(outputPath, "delivery.txt"), "delivered\n");
  const sourceCommit = await git(checkout, "rev-parse", "HEAD");
  const manifestDir = join(home, ".claude-octopus", "results");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, `.tangle-${attemptId}-git.json`), JSON.stringify({
    sourceRepository: await realpath(checkout),
    sourceCommit,
    runBranch,
    runWorktree: await realpath(outputPath),
  }, null, 2));

  const session = JSON.parse(await readFile(launched.directImplementationStatus, "utf8"));
  await writeFile(session.exitCodePath, "0\n");
  await writeFile(session.exitedAtPath, "2026-08-29T19:30:00Z\n");
  await writeFile(launched.directImplementationStatus, JSON.stringify({
    ...session,
    status: "completed",
    launchState: "exited",
    exitCode: 0,
    exitedAt: "2026-08-29T19:30:00Z",
  }, null, 2));

  const reconciled = detailsOf(await tool.execute("reconcile", {
    action: "reconcile", ...params,
    notifyMain: false,
    autoStopStalled: false,
    autoRunFinalValidation: false,
    autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.equal(reconciled.status.phase, "implementation_delivered");
  assert.equal(reconciled.status.outputPath, await realpath(outputPath));
  assert.equal(reconciled.status.implementationOutputHandoff.ok, true);
  assert.equal(reconciled.status.implementationOutputHandoff.attemptId, attemptId);
  assert.equal(reconciled.status.implementationOutputHandoff.runBranch, runBranch);
});


test("Octopus reconcile refuses a manifest whose branch does not match the attempt", async (t) => {
  const root = join(tmpdir(), `development-cycle-octopus-output-bad-branch-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const checkout = join(root, "checkout");
  const project = "octopus-output-bad-branch";
  const runId = "run-octopus-output-bad-branch";
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
  const { default: plugin } = await import(`../dist/index.js?octopus-output-bad=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  detailsOf(await tool.execute("request-bad", { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute("record-bad", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const launched = detailsOf(await tool.execute("launch-bad", { action: "start_implementation", ...params, implementationAdapter: "octopus" }, undefined, undefined));
  const attemptId = launched.implementationAttemptId;
  const outputPath = join(home, ".claude-octopus", "worktrees", "tangle", attemptId, "integration");
  const actualBranch = `octopus/run/${attemptId}/integration`;
  await mkdir(join(home, ".claude-octopus", "worktrees", "tangle", attemptId), { recursive: true });
  await git(checkout, "worktree", "add", "-b", actualBranch, outputPath);
  const manifestDir = join(home, ".claude-octopus", "results");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, `.tangle-${attemptId}-git.json`), JSON.stringify({
    sourceRepository: await realpath(checkout),
    sourceCommit: await git(checkout, "rev-parse", "HEAD"),
    runBranch: `octopus/run/${attemptId}-wrong/integration`,
    runWorktree: await realpath(outputPath),
  }, null, 2));
  const session = JSON.parse(await readFile(launched.directImplementationStatus, "utf8"));
  await writeFile(session.exitCodePath, "0\n");
  await writeFile(session.exitedAtPath, "2026-08-29T19:40:00Z\n");
  await writeFile(launched.directImplementationStatus, JSON.stringify({ ...session, status: "completed", launchState: "exited", exitCode: 0, exitedAt: "2026-08-29T19:40:00Z" }, null, 2));
  const reconciled = detailsOf(await tool.execute("reconcile-bad", { action: "reconcile", ...params, notifyMain: false, autoStopStalled: false, autoRunFinalValidation: false, autoRunCouncilReview: false }, undefined, undefined));
  assert.equal(reconciled.status.phase, "implementation_failed");
  assert.equal(reconciled.status.error, "octopus_output_handoff_failed");
  assert.equal(reconciled.status.outputPath ?? null, null);
  assert.equal(reconciled.status.implementationOutputHandoff.ok, false);
  assert.equal(reconciled.status.implementationOutputHandoff.error, "octopus_output_branch_mismatch");
});
