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
    "- Implement the approved scope.",
    "",
    "## Validation checks",
    "- Run focused regression tests.",
    "",
    "## Stop conditions",
    "- Stop if validation fails.",
    "",
    "## Expected artifacts",
    "- Launch-state evidence.",
    "",
    "## Project paths",
    `- projectWikiPath: ${wikiPath}`,
    `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

test("invalid supervisor pid persists a terminal failed implementation session", async (t) => {
  const root = join(tmpdir(), `development-cycle-invalid-supervisor-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const supervisorPath = join(root, "runner-supervisor-invalid.py");
  await writeFile(supervisorPath, [
    "import json, sys",
    "cmd = sys.argv[-1] if len(sys.argv) else ''",
    "if cmd == 'ping':",
    "    print(json.dumps({'ok': True, 'subreaper': True, 'pid': 4242}))",
    "elif len(sys.argv) >= 3 and sys.argv[-3] == 'launch':",
    "    print(json.dumps({'ok': True, 'pid': 0, 'pgid': 0, 'supervisorPid': 4242}))",
    "else:",
    "    print(json.dumps({'ok': False, 'argv': sys.argv}))",
    "",
  ].join("\n"));

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND = "/bin/true";
  process.env.DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_PATH = supervisorPath;
  process.env.DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET = join(root, "runner-supervisor.sock");

  const { default: plugin } = await import(`../dist/index.js?invalid-supervisor=${Date.now()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(registered) { tool = registered; } });

  const project = "invalid-supervisor";
  const runId = "run-invalid-supervisor";
  const projectWikiPath = join(root, "docs", project);
  const params = { project, runId, projectRoot: checkout, projectWikiPath };

  detailsOf(await tool.execute("invalid-supervisor", { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute("invalid-supervisor", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const launched = detailsOf(await tool.execute("invalid-supervisor", { action: "start_implementation", ...params, implementationAdapter: "command" }, undefined, undefined));

  assert.equal(launched.ok, false);
  assert.equal(launched.phase, "implementation_failed");
  assert.ok(launched.directImplementationStatus);
  const session = JSON.parse(await readFile(launched.directImplementationStatus, "utf8"));
  assert.equal(session.status, "failed");
  assert.equal(session.launchState, "launch_failed");
  assert.equal(session.runnerPid, null);
  assert.equal(session.processGroupId, null);
  assert.match(session.error, /supervised_runner_pid_invalid/);
});

test("malformed supervisor output persists a terminal failed implementation session", async (t) => {
  const root = join(tmpdir(), `development-cycle-malformed-supervisor-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const supervisorPath = join(root, "runner-supervisor-malformed.py");
  await writeFile(supervisorPath, [
    "import json, sys",
    "cmd = sys.argv[-1] if len(sys.argv) else ''",
    "if cmd == 'ping':",
    "    print(json.dumps({'ok': True, 'subreaper': True, 'pid': 4242}))",
    "elif len(sys.argv) >= 3 and sys.argv[-3] == 'launch':",
    "    print('not-json')",
    "else:",
    "    print(json.dumps({'ok': False, 'argv': sys.argv}))",
    "",
  ].join("\n"));

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND = "/bin/true";
  process.env.DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_PATH = supervisorPath;
  process.env.DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET = join(root, "runner-supervisor.sock");

  const { default: plugin } = await import(`../dist/index.js?malformed-supervisor=${Date.now()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(registered) { tool = registered; } });

  const project = "malformed-supervisor";
  const runId = "run-malformed-supervisor";
  const projectWikiPath = join(root, "docs", project);
  const params = { project, runId, projectRoot: checkout, projectWikiPath };

  detailsOf(await tool.execute("malformed-supervisor", { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute("malformed-supervisor", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const launched = detailsOf(await tool.execute("malformed-supervisor", { action: "start_implementation", ...params, implementationAdapter: "command" }, undefined, undefined));

  assert.equal(launched.ok, false);
  assert.equal(launched.phase, "implementation_failed");
  assert.ok(launched.directImplementationStatus);
  const session = JSON.parse(await readFile(launched.directImplementationStatus, "utf8"));
  assert.equal(session.status, "failed");
  assert.equal(session.launchState, "launch_failed");
  assert.equal(session.runnerPid, null);
  assert.equal(session.processGroupId, null);
  assert.match(session.error, /supervised_runner_output_invalid/);
});
