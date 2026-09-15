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
    "- Implement the approved scope and stop for human input when required.",
    "",
    "## Validation checks",
    "- Verify intervention resume evidence.",
    "",
    "## Stop conditions",
    "- Stop for a protected or ambiguous decision.",
    "",
    "## Expected artifacts",
    "- Human intervention and resumed implementation evidence.",
    "",
    "## Relevant code paths",
    "- src/example.ts",
    "",
    "## Project paths",
    `- projectWikiPath: ${wikiPath}`,
    `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

test("implementation intervention waits for human and answer resumes the same run", async (t) => {
  const root = join(tmpdir(), `development-cycle-human-intervention-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const supervisorPath = join(root, "runner-supervisor.py");
  await writeFile(supervisorPath, [
    "import json, pathlib, sys",
    "cmd = sys.argv[-1] if len(sys.argv) else ''",
    "if cmd == 'ping':",
    "    print(json.dumps({'ok': True, 'subreaper': True, 'pid': 4242}))",
    "elif len(sys.argv) >= 3 and sys.argv[-3] == 'launch':",
    "    cwd = pathlib.Path(sys.argv[-1])",
    "    (cwd / 'exit-code.txt').write_text('0\\n')",
    "    (cwd / 'exited-at.txt').write_text('2026-09-15T17:00:00Z\\n')",
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
    DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER: "command",
    DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND: "/bin/true",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_PATH: supervisorPath,
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "runner-supervisor.sock"),
  });

  const { default: plugin } = await import(`../dist/index.js?human-intervention=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });

  const project = "human-intervention";
  const runId = "run-human-intervention";
  const projectWikiPath = join(root, "docs", project);
  const params = { project, runId, projectRoot: checkout, projectWikiPath };
  await mkdir(projectWikiPath, { recursive: true });

  detailsOf(await tool.execute("human-intervention", { action: "request_plan", ...params }, undefined, undefined));
  const recorded = detailsOf(await tool.execute("human-intervention", { action: "record_plan", ...params, planText: planText(checkout, projectWikiPath) }, undefined, undefined));
  assert.equal(recorded.ok, true);
  const dir = recorded.dir;
  const sessionDir = join(dir, "implementation_session", "attempts", "delivery-test-intervention");
  const sessionPath = join(sessionDir, "status.json");
  const exitCodePath = join(sessionDir, "exit-code.txt");
  const exitedAtPath = join(sessionDir, "exited-at.txt");
  const stdoutPath = join(sessionDir, "logs", "stdout.log");
  const stderrPath = join(sessionDir, "logs", "stderr.log");
  const interventionPath = join(sessionDir, "intervention.json");
  await mkdir(join(sessionDir, "logs"), { recursive: true });
  await writeFile(exitCodePath, "75\n");
  await writeFile(exitedAtPath, "2026-09-15T16:59:00Z\n");
  await writeFile(stdoutPath, "human decision required\n");
  await writeFile(stderrPath, "\n");
  await writeFile(interventionPath, JSON.stringify({
    schemaVersion: 1,
    id: "choose-auth-mode",
    kind: "human_decision",
    question: "Use option A or option B?",
    context: "Both are safe, but product intent is ambiguous.",
    options: ["A", "B"],
    recommendedOption: "A",
  }, null, 2));
  await writeFile(sessionPath, JSON.stringify({
    status: "running",
    launchState: "running",
    runnerPid: 999999,
    attemptId: "delivery-test-intervention",
    exitCodePath,
    exitedAtPath,
    stdoutPath,
    stderrPath,
    interventionPath,
  }, null, 2));

  const statusPath = join(dir, "status.json");
  const current = JSON.parse(await readFile(statusPath, "utf8"));
  await writeFile(statusPath, JSON.stringify({
    ...current,
    phase: "implementation_launched",
    owner: "implementation",
    projectRoot: checkout,
    projectWikiPath,
    implementationAdapter: "command",
    implementationAttemptId: "delivery-test-intervention",
    directImplementationStatus: sessionPath,
    directImplementationStdout: stdoutPath,
    directImplementationStderr: stderrPath,
  }, null, 2));

  const reconciled = detailsOf(await tool.execute("human-intervention", {
    action: "reconcile", project, runId, projectRoot: checkout,
    notifyMain: false, autoStopStalled: false, autoRunFinalValidation: false, autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.status.phase, "implementation_waiting_human");
  assert.equal(reconciled.status.implementationIntervention.id, "choose-auth-mode");
  assert.equal(reconciled.status.implementationIntervention.question, "Use option A or option B?");
  const durableIntervention = JSON.parse(await readFile(join(dir, "implementation_intervention.json"), "utf8"));
  assert.equal(durableIntervention.status, "pending");

  const directStart = detailsOf(await tool.execute("human-intervention", {
    action: "start_implementation", ...params, implementationAdapter: "command",
  }, undefined, undefined));
  assert.equal(directStart.ok, false);
  assert.equal(directStart.error, "intervention_answer_required");

  const answered = detailsOf(await tool.execute("human-intervention", {
    action: "answer_intervention", ...params,
    interventionId: "choose-auth-mode",
    interventionResponse: "Choose A; preserve the existing API shape.",
    implementationAdapter: "command",
  }, undefined, undefined));
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.equal(answered.runId, runId);
  assert.equal(answered.phase, "implementation_launched");
  assert.notEqual(answered.implementationAttemptId, "delivery-test-intervention");

  const response = JSON.parse(await readFile(join(dir, "implementation_intervention_response.json"), "utf8"));
  assert.equal(response.id, "choose-auth-mode");
  assert.equal(response.response, "Choose A; preserve the existing API shape.");
  const request = await readFile(join(dir, "implementation_request.md"), "utf8");
  assert.match(request, /HUMAN_INTERVENTION_RESOLUTION/);
  assert.match(request, /Choose A; preserve the existing API shape\./);
  const finalStatus = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(finalStatus.implementationInterventionResolved.id, "choose-auth-mode");
  assert.equal(finalStatus.implementationInterventionResolved.response, "Choose A; preserve the existing API shape.");
});
