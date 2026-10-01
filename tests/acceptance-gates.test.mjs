import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function fixture(t, env = {}) {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-gates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  const git = (...args) => execFileSync("git", args, { cwd: checkout, stdio: "pipe" });
  git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  await writeFile(join(checkout, "README.md"), "initial\n");
  git("add", "."); git("commit", "-m", "initial");
  Object.assign(process.env, { DEVELOPMENT_CYCLE_STATE_ROOT: join(root, "state"), DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"), DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false", DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false", DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED: "false", DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER: "command", ...env });
  const { default: plugin } = await import(`../dist/index.js?acceptance=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(value) { tool = value; } });
  const params = { project: "fixture", runId: "run", projectRoot: checkout, projectWikiPath: join(root, "docs", "fixture") };
  const call = async (action, extra = {}) => (await tool.execute(action, { action, ...params, ...extra }, undefined, undefined)).details;
  const requested = await call("request_plan");
  const statusPath = join(requested.dir, "status.json");
  const seed = async patch => writeFile(statusPath, JSON.stringify({ ...JSON.parse(await readFile(statusPath, "utf8")), ...patch }));
  return { root, checkout, params, call, seed, statusPath, dir: requested.dir };
}

test("a success override cannot accept a failed implementation or enable auto-merge", async t => {
  const { call, seed, dir } = await fixture(t);
  await seed({ phase: "implementation_failed", implementationAdapter: "command" });
  const result = await call("finalize_delivery", { deliveryClassification: "success" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.phase, "closed_partial");
  const request = JSON.parse(await readFile(join(dir, "repository_delivery_request.json"), "utf8"));
  assert.equal(request.classification, "partial");
  assert.equal(request.autoMerge, false);
});

for (const [synthesis, expected] of [["NO-GO: unresolved security vulnerability", "council_review_needs_corrections"], ["review completed without a verdict", "council_review_failed"]]) {
  test(`completed council review refuses ${synthesis}`, { skip: process.platform !== "linux" }, async t => {
    const octopusRoot = await mkdtemp(join(tmpdir(), "development-cycle-council-"));
    t.after(() => rm(octopusRoot, { recursive: true, force: true }));
    const { checkout, call, seed } = await fixture(t, { DEVELOPMENT_CYCLE_OCTOPUS_ROOT: octopusRoot });
    await mkdir(join(octopusRoot, "scripts"), { recursive: true });
    await writeFile(join(octopusRoot, "scripts", "orchestrate.sh"), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output-dir ]; then output="$2"; break; fi; shift; done\nmkdir -p "$output/result"\nprintf '%s' '{"status":"completed"}' > "$output/result/summary.json"\nprintf '%s' '${synthesis}' > "$output/result/synthesis.md"\n`, { mode: 0o755 });
    await seed({ phase: "external_validation_passed", implementationAdapter: "octopus", outputPath: checkout });
    const result = await call("reconcile", { autoRunCouncilReview: true, notifyMain: false, autoStopStalled: false });
    assert.equal(result.status.phase, expected, JSON.stringify(result));
    assert.equal(result.status.ok, false);
    assert.equal(result.councilEndgate.corrections, null);
    assert.match(result.councilEndgate.council.status.nextAction, /rejected|inconclusive/);
  });
}

test("revalidation clears the council cache and cannot consume an earlier review artifact", { skip: process.platform !== "linux" }, async t => {
  const octopusRoot = await mkdtemp(join(tmpdir(), "development-cycle-council-cache-"));
  t.after(() => rm(octopusRoot, { recursive: true, force: true }));
  const { checkout, call, seed, dir } = await fixture(t, { DEVELOPMENT_CYCLE_OCTOPUS_ROOT: octopusRoot });
  const previousRoot = join(dir, "council-code-review", "previous");
  await mkdir(previousRoot, { recursive: true });
  const previousSummary = join(previousRoot, "summary.json");
  await writeFile(previousSummary, '{"status":"completed"}');
  await writeFile(join(previousRoot, "synthesis.md"), "GO\nNo blockers");
  await seed({ phase: "council_validated", implementationAdapter: "octopus", outputPath: checkout, councilReviewSummary: previousSummary, councilReviewSynthesis: join(previousRoot, "synthesis.md") });
  const validated = await call("run_final_validation");
  assert.equal(validated.ok, true, JSON.stringify(validated));
  assert.equal(validated.status.councilReviewSummary, "");
  await mkdir(join(octopusRoot, "scripts"), { recursive: true });
  await writeFile(join(octopusRoot, "scripts", "orchestrate.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const reviewed = await call("reconcile", { autoRunCouncilReview: true, notifyMain: false, autoStopStalled: false });
  assert.equal(reviewed.status.phase, "council_review_failed", JSON.stringify(reviewed));
  assert.equal(reviewed.councilEndgate.council.summaryPath, "");
  assert.equal(reviewed.councilEndgate.corrections, null);
});

test("corrupted status returns an actionable error without erasing history", async t => {
  const { call, statusPath } = await fixture(t);
  await writeFile(statusPath, "{broken-state");
  const result = await call("reconcile");
  assert.equal(result.ok, false);
  assert.equal(result.error, "state_unreadable");
  assert.equal(await readFile(statusPath, "utf8"), "{broken-state");
});

test("invalid explicit and implicit validation policies stop acceptance and allow recovery", { skip: process.platform !== "linux" }, async t => {
  const { root, checkout, params, call, seed } = await fixture(t);
  await seed({ phase: "implementation_delivered", implementationAdapter: "command" });
  const config = join(checkout, "validation.json");
  await writeFile(config, "{broken");
  let result = await call("run_final_validation", { validationConfigPath: config, autoRunCouncilReview: false });
  assert.equal(result.decision, "stop");
  assert.equal(result.validationConfigError, "validation_config_invalid_json");
  assert.deepEqual(result.commandResults, []);
  await writeFile(config, JSON.stringify({ commands: 0 }));
  result = await call("run_final_validation", { validationConfigPath: config, autoRunCouncilReview: false });
  assert.equal(result.validationConfigError, "validation_config_invalid_shape");
  const outside = join(root, "outside.json");
  await writeFile(outside, JSON.stringify({ commands: ["true"] }));
  result = await call("run_final_validation", { validationConfigPath: outside, autoRunCouncilReview: false });
  assert.equal(result.decision, "stop");
  assert.equal(result.validationConfigError, "validation_config_path_outside_allowed_roots");
  await mkdir(params.projectWikiPath, { recursive: true });
  await writeFile(join(params.projectWikiPath, "validation.json"), "null");
  result = await call("run_final_validation", { autoRunCouncilReview: false });
  assert.equal(result.validationConfigError, "validation_config_invalid_shape");
  await writeFile(join(params.projectWikiPath, "validation.json"), JSON.stringify({ commands: ["true"] }));
  result = await call("run_final_validation", { autoRunCouncilReview: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.decision, "go");
});
