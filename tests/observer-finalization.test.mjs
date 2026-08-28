import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

function detailsOf(result) {
  return result?.details ?? result;
}

function planText(projectRoot, wikiPath) {
  return [
    "# Implementation plan",
    "",
    "## Ordered implementation tasks",
    "- Implement the approved scope.",
    "",
    "## Validation checks",
    "- Run the focused regression tests.",
    "",
    "## Stop conditions",
    "- Stop if validation fails.",
    "",
    "## Expected artifacts",
    "- Observer finalization evidence.",
    "",
    "## Project paths",
    `- projectWikiPath: ${wikiPath}`,
    `- projectRoot: ${projectRoot}`,
  ].join("\n");
}

async function helperEvents(logPath) {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

async function loadTool(root, { failTerminal = false } = {}) {
  // main's pinned-root security accepts only projectRoots that look like a
  // git checkout; hand every test a fake one instead of the bare tmp root.
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const helperPath = join(root, "observe-helper.cjs");
  const helperLog = join(root, "observer-helper.log");
  const failFlag = join(root, "fail-terminal.flag");
  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "true";
  process.env.DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_HELPER_PATH = helperPath;
  process.env.DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND = join(root, "missing-adapter");

  if (failTerminal) await writeFile(failFlag, "1\n");
  await writeFile(
    helperPath,
    [
      '"use strict";',
      'const { appendFileSync, existsSync, readFileSync } = require("node:fs");',
      "const file = process.argv[2];",
      "const payload = JSON.parse(readFileSync(file, \"utf8\"));",
      "const id = payload.id || `obs-${Date.now().toString(16)}`;",
      'const terminal = ["failed", "completed", "stopped"].includes(String(payload.status || ""));',
      `const logPath = ${JSON.stringify(helperLog)};`,
      `const failFlag = ${JSON.stringify(failFlag)};`,
      "appendFileSync(logPath, JSON.stringify({ id, status: payload.status || \"ready\", hasId: Boolean(payload.id), terminal }) + \"\\n\");",
      "if (existsSync(failFlag) && payload.id && terminal) {",
      "  process.stdout.write(JSON.stringify({ status: {} }));",
      "} else {",
      "  process.stdout.write(JSON.stringify({ status: { id } }));",
      "}",
      "",
    ].join("\n"),
  );

  const { default: plugin } = await import(`../dist/index.js?observer-finalization=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({
    pluginConfig: {},
    registerTool(registered) {
      tool = registered;
    },
  });
  return { checkout, tool, helperLog };
}

test("finalizeObserverSessions covers runner-missing and launch-failure terminals", () => {
  const finalizeFn = source.slice(
    source.indexOf("async function finalizeObserverSessions"),
    source.indexOf("async function refreshLaunchedImplementationStatus"),
  );
  assert.match(finalizeFn, /result\.ok !== true/);
  assert.match(finalizeFn, /observer_update_unsuccessful/);
  assert.doesNotMatch(finalizeFn, /observer is optional/);

  const runnerMissing = source.slice(source.indexOf("if (!runnerAlive)"), source.indexOf("if (heartbeatAgeMs"));
  assert.match(runnerMissing, /finalizeObserverSessions\(dir, status, "failed"\)/);
  assert.match(runnerMissing, /observerFinalization/);

  const launchFailures = [...source.matchAll(/if \(!launch\.ok\) \{[\s\S]*?return \{ ok: false/g)].map((match) => match[0]);
  assert.equal(launchFailures.length, 3);
  for (const block of launchFailures) {
    assert.match(block, /finalizeObserverSessions/);
    assert.match(block, /observerFinalization/);
  }
});

test("launch failure finalizes the observer root and persists the result", async (t) => {
  const root = join(tmpdir(), `development-cycle-observer-launch-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const { tool, helperLog, checkout } = await loadTool(root);

  const project = "launch-fail";
  const runId = "run-launch";
  const projectRoot = checkout;
  const projectWikiPath = join(root, "docs", project);
  const params = { project, runId, projectRoot, projectWikiPath };

  const requested = detailsOf(await tool.execute("observer-finalization", { action: "request_plan", ...params }, undefined, undefined));
  assert.equal(requested.ok, true);
  const recorded = detailsOf(await tool.execute("observer-finalization", { action: "record_plan", ...params, planText: planText(projectRoot, projectWikiPath) }, undefined, undefined));
  assert.equal(recorded.ok, true);

  const launched = detailsOf(await tool.execute("observer-finalization", { action: "start_implementation", ...params, implementationAdapter: "command" }, undefined, undefined));
  assert.equal(launched.ok, false);
  assert.equal(launched.phase, "implementation_failed");
  assert.ok(launched.observerObservationId);

  const status = JSON.parse(await readFile(join(launched.dir, "status.json"), "utf8"));
  assert.equal(status.phase, "implementation_failed");
  assert.equal(status.observerFinalization.ok, true);
  assert.equal(status.observerFinalization.terminal, "failed");
  assert.equal(status.observerFinalization.results[0].id, launched.observerObservationId);

  const events = await helperEvents(helperLog);
  assert.equal(events.some((event) => event.status === "ready" && !event.hasId), true);
  assert.equal(events.some((event) => event.status === "failed" && event.hasId && event.id === launched.observerObservationId), true);
});

test("unsuccessful observer finalization is persisted on cycle status", async (t) => {
  const root = join(tmpdir(), `development-cycle-observer-surface-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const { tool, helperLog, checkout } = await loadTool(root, { failTerminal: true });

  const project = "surface-fail";
  const runId = "run-surface";
  const projectRoot = checkout;
  const projectWikiPath = join(root, "docs", project);
  const params = { project, runId, projectRoot, projectWikiPath };

  detailsOf(await tool.execute("observer-finalization", { action: "request_plan", ...params }, undefined, undefined));
  detailsOf(await tool.execute("observer-finalization", { action: "record_plan", ...params, planText: planText(projectRoot, projectWikiPath) }, undefined, undefined));
  const launched = detailsOf(await tool.execute("observer-finalization", { action: "start_implementation", ...params, implementationAdapter: "command" }, undefined, undefined));
  assert.equal(launched.ok, false);
  assert.equal(launched.phase, "implementation_failed");

  const status = JSON.parse(await readFile(join(launched.dir, "status.json"), "utf8"));
  assert.equal(status.observerFinalization.ok, false);
  assert.equal(status.observerFinalization.terminal, "failed");
  assert.equal(status.observerFinalization.results[0].ok, false);
  assert.equal(status.observerFinalization.results[0].result.ok, false);

  const events = await helperEvents(helperLog);
  assert.equal(events.some((event) => event.status === "failed" && event.terminal), true);
});

test("runner disappearance finalizes observer roots during reconcile", async (t) => {
  const root = join(tmpdir(), `development-cycle-observer-missing-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const { tool, helperLog, checkout } = await loadTool(root);

  const project = "runner-missing";
  const runId = "run-missing";
  const projectRoot = checkout;
  const projectWikiPath = join(root, "docs", project);
  const params = { project, runId, projectRoot, projectWikiPath };

  const requested = detailsOf(await tool.execute("observer-finalization", { action: "request_plan", ...params }, undefined, undefined));
  assert.equal(requested.ok, true);
  const recorded = detailsOf(await tool.execute("observer-finalization", { action: "record_plan", ...params, planText: planText(projectRoot, projectWikiPath) }, undefined, undefined));
  assert.equal(recorded.ok, true);

  const dir = recorded.dir;
  const sessionDir = join(dir, "implementation_session");
  const sessionPath = join(sessionDir, "status.json");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify({
    status: "running",
    launchState: "running",
    runnerPid: 2147483646,
    stdoutPath: join(dir, "implementation_delivery_stdout.txt"),
    stderrPath: join(dir, "implementation_delivery_stderr.txt"),
  }, null, 2)}\n`);

  const current = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  await writeFile(join(dir, "status.json"), `${JSON.stringify({
    ...current,
    phase: "implementation_launched",
    owner: "implementation",
    observerObservationId: "obs-missing-runner",
    directImplementationStatus: sessionPath,
    implementationStdout: join(dir, "implementation_delivery_stdout.txt"),
    implementationStderr: join(dir, "implementation_delivery_stderr.txt"),
  }, null, 2)}\n`);

  const reconciled = detailsOf(await tool.execute("observer-finalization", {
    action: "reconcile",
    ...params,
    notifyMain: false,
    autoStopStalled: false,
    autoRunFinalValidation: false,
    autoRunCouncilReview: false,
  }, undefined, undefined));
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.status.phase, "implementation_failed");
  assert.equal(reconciled.status.error, "implementation_runner_process_missing");
  assert.equal(reconciled.status.observerFinalization.ok, true);
  assert.equal(reconciled.status.observerFinalization.terminal, "failed");
  assert.equal(reconciled.status.observerFinalization.results[0].id, "obs-missing-runner");

  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  assert.equal(session.status, "interrupted");
  assert.equal(session.launchState, "runner_missing");

  const events = await helperEvents(helperLog);
  assert.equal(events.some((event) => event.id === "obs-missing-runner" && event.status === "failed"), true);
});
