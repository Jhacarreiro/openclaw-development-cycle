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
    "- Prove fast-exit state preservation.",
    "",
    "## Validation checks",
    "- Inspect persisted status.",
    "",
    "## Stop conditions",
    "- Stop after proof.",
    "",
    "## Expected artifacts",
    "- status.json",
    "",
    "## Project paths",
    `- projectWikiPath: ${wikiPath}`,
    `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

test("immediate runner exit cannot be resurrected as running", async (t) => {
  const root = join(tmpdir(), `development-cycle-fast-exit-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const supervisorPath = join(root, "runner-supervisor-fast-exit.py");
  await writeFile(supervisorPath, [
    "import json, pathlib, sys",
    "cmd = sys.argv[-1] if len(sys.argv) else ''",
    "if cmd == 'ping':",
    "    print(json.dumps({'ok': True, 'subreaper': True, 'pid': 4242}))",
    "elif len(sys.argv) >= 3 and sys.argv[-3] == 'launch':",
    "    cwd = pathlib.Path(sys.argv[-1])",
    "    (cwd / 'exit-code.txt').write_text('0\\n')",
    "    (cwd / 'exited-at.txt').write_text('2026-08-29T08:00:00Z\\n')",
    "    print(json.dumps({'ok': True, 'pid': 4243, 'pgid': 4243, 'supervisorPid': 4242}))",
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

  const { default: plugin } = await import(`../dist/index.js?fast-exit=${Date.now()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(registered) { tool = registered; } });

  const project = "fast-exit";
  const runId = "run-fast-exit";
  const projectWikiPath = join(root, "docs", project);
  const params = { project, runId, projectRoot: checkout, projectWikiPath };

  detailsOf(await tool.execute("fast-exit", { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute("fast-exit", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  const launched = detailsOf(await tool.execute("fast-exit", { action: "start_implementation", ...params, implementationAdapter: "command" }, undefined, undefined));

  assert.equal(launched.ok, true, JSON.stringify(launched));
  assert.equal(launched.launchState, "exited");
  const session = JSON.parse(await readFile(join(launched.dir, "implementation_session", "status.json"), "utf8"));
  assert.equal(session.status, "completed");
  assert.equal(session.launchState, "exited");
  assert.equal(session.exitCode, 0);
  assert.notEqual(session.status, "running");
});
