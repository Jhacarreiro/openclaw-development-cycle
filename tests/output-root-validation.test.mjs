import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
function detailsOf(result) { return result?.details ?? result; }
async function git(cwd, ...args) { return String((await execFileAsync("git", args, { cwd })).stdout || "").trim(); }

async function loadTool(root) {
  Object.assign(process.env, {
    DEVELOPMENT_CYCLE_STATE_ROOT: join(root, "state"),
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false",
    DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED: "false",
  });
  const { default: plugin } = await import(`../dist/index.js?output-root-validation=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  return tool;
}

test("final validation loads policy from source checkout but executes in outputPath", async (t) => {
  const root = join(tmpdir(), `development-cycle-output-validation-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const output = join(root, "output");
  const marker = join(root, "validation-cwd.txt");
  const project = "output-root-validation";
  await mkdir(source, { recursive: true });
  await git(source, "init");
  await git(source, "config", "user.email", "test@example.com");
  await git(source, "config", "user.name", "Test Runner");
  await writeFile(join(source, "README.md"), "source\n");
  await writeFile(join(source, "validation.json"), JSON.stringify({
    commands: [`pwd > '${marker}'`],
    preserveDiff: true,
    strictDirty: false,
  }, null, 2));
  await git(source, "add", "README.md", "validation.json");
  await git(source, "commit", "-m", "initial");
  await git(source, "worktree", "add", "-b", "delivery/output", output);

  const tool = await loadTool(root);
  const requested = detailsOf(await tool.execute("request", {
    action: "request_plan", project, projectRoot: source,
  }, undefined, undefined));
  const runId = requested.runId;
  const recorded = detailsOf(await tool.execute("record", {
    action: "record_plan", project, runId, projectRoot: source, force: true,
    planText: "# Implementation plan\n\n## Project paths\n- projectRoot\n\n## Tasks\n1. validate output\n\n## Validation checks\n- policy command\n\n## Stop conditions\n- validation failure\n\n## Expected artifacts\n- validated output\n",
  }, undefined, undefined));
  const statusPath = join(recorded.dir, "status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  status.phase = "implementation_delivered";
  status.owner = "main";
  status.outputPath = await realpath(output);
  await writeFile(statusPath, JSON.stringify(status, null, 2));

  const validated = detailsOf(await tool.execute("validate", {
    action: "run_final_validation", project, runId, projectRoot: source,
    validationConfigPath: join(source, "validation.json"),
  }, undefined, undefined));
  assert.equal(validated.ok, true, JSON.stringify(validated));
  assert.equal(validated.decision, "go", JSON.stringify(validated));
  assert.equal((await readFile(marker, "utf8")).trim(), await realpath(output));
  const result = JSON.parse(await readFile(validated.validationResult, "utf8"));
  assert.equal(result.projectRoot, await realpath(source));
  assert.equal(result.implementationRoot, await realpath(output));
  assert.equal(result.outputPath, await realpath(output));
  assert.equal(result.validationConfigPath, join(await realpath(source), "validation.json"));
});
