import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function detailsOf(result) { return result?.details ?? result; }
async function waitForPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}
function planText(projectRoot, wikiPath) {
  return [
    "# Implementation plan", "", "## Ordered implementation tasks", "- Prove lifecycle action serialization.", "",
    "## Validation checks", "- Reconcile reads state only after the launch action commits.", "",
    "## Stop conditions", "- Stop on stale lifecycle publication.", "",
    "## Expected artifacts", "- Serialized lifecycle state.", "", "## Project paths",
    `- projectWikiPath: ${wikiPath}`, `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

test("reconcile cannot overlap a retry lifecycle action", async (t) => {
  const root = join(tmpdir(), `development-cycle-lifecycle-lock-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const marker = join(root, "launch-entered");
  const gate = join(root, "release-launch");
  const supervisorPath = join(root, "runner-supervisor.py");
  await mkdir(join(checkout, ".git"), { recursive: true });
  await writeFile(supervisorPath, [
    "import json, os, sys, time",
    `marker = ${JSON.stringify(marker)}`,
    `gate = ${JSON.stringify(gate)}`,
    "cmd = sys.argv[-1] if len(sys.argv) else ''",
    "pid = os.getppid()",
    "if cmd == 'ping':",
    "    print(json.dumps({'ok': True, 'subreaper': True, 'pid': pid}))",
    "elif len(sys.argv) >= 3 and sys.argv[-3] == 'launch':",
    "    open(marker, 'w').write('entered')",
    "    deadline = time.time() + 5",
    "    while not os.path.exists(gate) and time.time() < deadline: time.sleep(0.01)",
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

  const { default: plugin } = await import(`../dist/index.js?lifecycle-lock=${Date.now()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  const project = "lifecycle-lock";
  const runId = "run-lifecycle-lock";
  const projectWikiPath = join(root, "docs", project);
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  detailsOf(await tool.execute("request", { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute("record", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));

  const launching = tool.execute("launch", { action: "start_implementation", ...params, implementationAdapter: "command" }, undefined, undefined);
  await waitForPath(marker);

  let reconcileSettled = false;
  const reconciling = tool.execute("reconcile", {
    action: "reconcile", ...params,
    notifyMain: false,
    autoStopStalled: false,
    autoRunFinalValidation: false,
    autoRunCouncilReview: false,
  }, undefined, undefined).then((value) => { reconcileSettled = true; return value; });

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(reconcileSettled, false, "reconcile must wait while launch owns the lifecycle lock");
  await writeFile(gate, "go");

  const launched = detailsOf(await launching);
  assert.equal(launched.ok, true, JSON.stringify(launched));
  const reconciled = detailsOf(await reconciling);
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.equal(reconciled.status.phase, "implementation_launched");
  assert.equal(reconciled.status.implementationAttemptId, launched.implementationAttemptId);
  assert.equal(reconciled.status.directImplementationStatus, launched.directImplementationStatus);

  const durable = JSON.parse(await readFile(join(launched.dir, "status.json"), "utf8"));
  assert.equal(durable.phase, "implementation_launched");
  assert.equal(durable.implementationAttemptId, launched.implementationAttemptId);
});
