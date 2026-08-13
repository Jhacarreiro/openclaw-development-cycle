import assert from "node:assert/strict";
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

async function collectObservationFiles(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectObservationFiles(full, acc);
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("observer_observation_") && entry.name.endsWith(".json")) {
      acc.push(full);
    }
  }
  return acc;
}

test("concurrent observer observations produce distinct files and are processed by the helper", async (t) => {
  const root = join(tmpdir(), `development-cycle-observer-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));

  const stateRoot = join(root, "state");
  const docsRoot = join(root, "docs");
  const helperPath = join(root, "observe-helper.cjs");
  const adapterPath = join(root, "fake-adapter.sh");

  await mkdir(root, { recursive: true });
  await writeFile(
    helperPath,
    [
      '"use strict";',
      'const { appendFileSync, readFileSync } = require("node:fs");',
      "const file = process.argv[2];",
      "const payload = JSON.parse(readFileSync(file, \"utf8\"));",
      "const id = payload.id || `obs-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;",
      "const runId = payload.runId || payload.developmentCycle?.runId || \"\";",
      "appendFileSync(`${file}.log`, `${file}|${id}|${payload.status || \"ready\"}|${runId}\\n`);",
      "process.stdout.write(JSON.stringify({ status: { id } }));",
      "",
    ].join("\n"),
  );
  await writeFile(adapterPath, "#!/bin/sh\nexit 0\n");
  await chmod(adapterPath, 0o755);

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = stateRoot;
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = docsRoot;
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "true";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_HELPER_PATH = helperPath;
  process.env.DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND = adapterPath;
  process.env.DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET = join(root, "supervisor.sock");

  const { default: plugin } = await import(`../dist/index.js?observer=${Date.now()}`);
  let tool;
  plugin.register({
    pluginConfig: {},
    registerTool(t) {
      tool = t;
    },
  });

  async function runCycle(project, runId) {
    const params = {
      project,
      runId,
      projectRoot: root,
      projectWikiPath: join(docsRoot, project),
    };
    const planText = [
      "# Implementation plan",
      "",
      "## Ordered implementation tasks",
      "- Implement the approved scope.",
      "",
      "## Validation checks",
      "- Run the focused regression tests.",
      "",
      "## Stop conditions",
      "- Stop if validation fails or a protected path is reached.",
      "",
      "## Expected artifacts",
      "- Distinct observer observation files for concurrent runs.",
      "",
      "## Project paths",
      `- projectWikiPath: ${params.projectWikiPath}`,
      `- projectRoot: ${params.projectRoot}`,
    ].join("\n");

    await tool.execute("observer-test", { action: "request_plan", ...params }, undefined, undefined);
    await tool.execute("observer-test", { action: "record_plan", ...params, planText }, undefined, undefined);
    return tool.execute(
      "observer-test",
      { action: "start_implementation", ...params, implementationAdapter: "command" },
      undefined,
      undefined,
    );
  }

  const [first, second] = await Promise.all([runCycle("proj-a", "run-a"), runCycle("proj-b", "run-b")]);

  assert.equal(first.details.ok, true);
  assert.equal(first.details.phase, "implementation_launched");
  assert.equal(second.details.ok, true);
  assert.equal(second.details.phase, "implementation_launched");
  assert.notEqual(first.details.observerObservationId, second.details.observerObservationId);

  const observationFiles = await collectObservationFiles(stateRoot);
  const names = observationFiles.map((file) => basename(file));
  assert.equal(new Set(names).size, names.length);

  const logs = [];
  for (const file of observationFiles) {
    const sidecar = `${file}.log`;
    await access(sidecar);
    logs.push(await readFile(sidecar, "utf8"));
  }
  const combined = logs.join("");
  assert.match(combined, /run-a/);
  assert.match(combined, /run-b/);
});
