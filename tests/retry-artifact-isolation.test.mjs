import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function detailsOf(result) { return result?.details ?? result; }
function planText(projectRoot, wikiPath) {
  return [
    "# Implementation plan",
    "",
    "## Ordered implementation tasks",
    "- Exercise retry artifact isolation.",
    "",
    "## Validation checks",
    "- Inspect session state.",
    "",
    "## Stop conditions",
    "- Stop on regression.",
    "",
    "## Expected artifacts",
    "- Session status.",
    "",
    "## Project paths",
    `- projectWikiPath: ${wikiPath}`,
    `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

async function loadTool(root) {
  const supervisorPath = join(root, "runner-supervisor-stub.py");
  await writeFile(supervisorPath, [
    "import json, sys",
    "cmd = sys.argv[-1] if len(sys.argv) else ''",
    "if cmd == 'ping':",
    "    print(json.dumps({'ok': True, 'subreaper': True, 'pid': 4242}))",
    "elif len(sys.argv) >= 3 and sys.argv[-3] == 'launch':",
    "    print(json.dumps({'ok': True, 'pid': 4243, 'pgid': 4243, 'supervisorPid': 4242}))",
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
  const { default: plugin } = await import(`../dist/index.js?retry-artifacts=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  return tool;
}

async function prepareRun(tool, root, project, runId) {
  const checkout = join(root, `${project}-checkout`);
  const projectWikiPath = join(root, "docs", project);
  await mkdir(join(checkout, ".git"), { recursive: true });
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  detailsOf(await tool.execute("request", { action: "request_plan", ...params }, undefined, undefined));
  const recorded = detailsOf(await tool.execute("record", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  return { ...params, dir: recorded.dir };
}

test("implementation retry ignores stale terminal markers", async (t) => {
  const root = join(tmpdir(), `development-cycle-retry-markers-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const tool = await loadTool(root);
  const run = await prepareRun(tool, root, "retry-implementation", "run-retry-implementation");
  const cycleStatusPath = join(run.dir, "status.json");
  const cycleStatus = JSON.parse(await readFile(cycleStatusPath, "utf8"));
  cycleStatus.phase = "implementation_failed";
  await writeFile(cycleStatusPath, JSON.stringify(cycleStatus));
  const sessionDir = join(run.dir, "implementation_session");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "exit-code.txt"), "1\n");
  await writeFile(join(sessionDir, "exited-at.txt"), "2000-01-01T00:00:00Z\n");

  const launched = detailsOf(await tool.execute("retry", { action: "start_implementation", ...run, implementationAdapter: "command" }, undefined, undefined));
  assert.equal(launched.ok, true);
  assert.equal(launched.launchState, "running");
  const session = JSON.parse(await readFile(join(sessionDir, "status.json"), "utf8"));
  assert.equal(session.status, "running");
  assert.equal(session.launchState, "running");
  await assert.rejects(access(join(sessionDir, "exit-code.txt")));
  await assert.rejects(access(join(sessionDir, "exited-at.txt")));
});

test("corrections relaunch ignores stale terminal markers", async (t) => {
  const root = join(tmpdir(), `development-cycle-corrections-markers-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const tool = await loadTool(root);
  const run = await prepareRun(tool, root, "retry-corrections", "run-retry-corrections");
  const cycleStatusPath = join(run.dir, "status.json");
  const cycleStatus = JSON.parse(await readFile(cycleStatusPath, "utf8"));
  cycleStatus.phase = "council_review_needs_corrections";
  cycleStatus.implementationAdapter = "command";
  await writeFile(cycleStatusPath, JSON.stringify(cycleStatus));
  const sessionDir = join(run.dir, "corrections_session");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "exit-code.txt"), "0\n");
  await writeFile(join(sessionDir, "exited-at.txt"), "2000-01-01T00:00:00Z\n");

  const launched = detailsOf(await tool.execute("corrections", { action: "start_corrections", ...run, implementationAdapter: "command", feedbackText: "must fix the remaining issue" }, undefined, undefined));
  assert.equal(launched.ok, true);
  assert.equal(launched.launchState, "running");
  const session = JSON.parse(await readFile(join(sessionDir, "status.json"), "utf8"));
  assert.equal(session.status, "running");
  assert.equal(session.launchState, "running");
  await assert.rejects(access(join(sessionDir, "exit-code.txt")));
  await assert.rejects(access(join(sessionDir, "exited-at.txt")));
});
