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
