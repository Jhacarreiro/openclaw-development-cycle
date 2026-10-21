import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalRouting, writeCanonicalRoutingConfig } from "./helpers/octopus-routing.mjs";

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

test("an inconclusive council review is run once more, then left for a person", { skip: process.platform !== "linux" }, async t => {
  const octopusRoot = await mkdtemp(join(tmpdir(), "development-cycle-council-retry-"));
  t.after(() => rm(octopusRoot, { recursive: true, force: true }));
  const { checkout, call, seed } = await fixture(t, { DEVELOPMENT_CYCLE_OCTOPUS_ROOT: octopusRoot });
  await mkdir(join(octopusRoot, "scripts"), { recursive: true });
  const orchestrate = join(octopusRoot, "scripts", "orchestrate.sh");
  // Seats that answer nothing leave a partial summary without a verdict.
  await writeFile(orchestrate, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output-dir ]; then output="$2"; break; fi; shift; done\nmkdir -p "$output/result"\nprintf '%s' '{"status":"partial"}' > "$output/result/summary.json"\n`, { mode: 0o755 });
  await seed({ phase: "external_validation_passed", implementationAdapter: "octopus", outputPath: checkout });
  const reconcile = () => call("reconcile", { autoRunCouncilReview: true, notifyMain: false, autoStopStalled: false });
  const first = await reconcile();
  assert.equal(first.status.phase, "council_review_failed");
  assert.match(first.status.nextAction, /runs it once more/);
  const retried = await reconcile();
  assert.equal(retried.status.phase, "council_review_failed", JSON.stringify(retried));
  assert.equal(retried.status.councilReviewAttempts, 2);
  assert.match(retried.status.nextAction, /^Resolve the failed/);
  assert.equal((await reconcile()).councilEndgate, null);
  // Corrections and revalidation start a new review, which gets its own retry.
  await seed({ phase: "corrections_completed" });
  assert.equal((await call("run_final_validation")).ok, true);
  assert.equal((await reconcile()).status.phase, "council_review_failed");
  assert.equal((await reconcile()).status.councilReviewAttempts, 2);
});

test("a run left in a failed council review before attempts were counted is retried only once", { skip: process.platform !== "linux" }, async t => {
  const octopusRoot = await mkdtemp(join(tmpdir(), "development-cycle-council-legacy-"));
  t.after(() => rm(octopusRoot, { recursive: true, force: true }));
  const { checkout, call, seed } = await fixture(t, { DEVELOPMENT_CYCLE_OCTOPUS_ROOT: octopusRoot });
  await mkdir(join(octopusRoot, "scripts"), { recursive: true });
  await writeFile(join(octopusRoot, "scripts", "orchestrate.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await seed({ phase: "council_review_failed", implementationAdapter: "octopus", outputPath: checkout, councilReviewSummary: "" });
  const reconcile = () => call("reconcile", { autoRunCouncilReview: true, notifyMain: false, autoStopStalled: false });
  assert.equal((await reconcile()).status.councilReviewAttempts, 2);
  assert.equal((await reconcile()).councilEndgate, null);
});

test("a council review that answers on its second attempt validates the run", { skip: process.platform !== "linux" }, async t => {
  const octopusRoot = await mkdtemp(join(tmpdir(), "development-cycle-council-retry-ok-"));
  t.after(() => rm(octopusRoot, { recursive: true, force: true }));
  const { checkout, call, seed } = await fixture(t, { DEVELOPMENT_CYCLE_OCTOPUS_ROOT: octopusRoot });
  await mkdir(join(octopusRoot, "scripts"), { recursive: true });
  await writeFile(join(octopusRoot, "scripts", "orchestrate.sh"), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output-dir ]; then output="$2"; break; fi; shift; done\nmkdir -p "$output/result"\nif [ -f "${octopusRoot}/answered-once" ]; then printf '%s' '{"status":"completed"}' > "$output/result/summary.json"; printf '%s' 'GO: no blockers' > "$output/result/synthesis.md"; else touch "${octopusRoot}/answered-once"; printf '%s' '{"status":"partial"}' > "$output/result/summary.json"; fi\n`, { mode: 0o755 });
  await seed({ phase: "external_validation_passed", implementationAdapter: "octopus", outputPath: checkout });
  const reconcile = () => call("reconcile", { autoRunCouncilReview: true, notifyMain: false, autoStopStalled: false });
  assert.equal((await reconcile()).status.phase, "council_review_failed");
  const retried = await reconcile();
  assert.equal(retried.status.phase, "council_validated", JSON.stringify(retried));
});

for (const { name, roles, policy, members } of [
  { name: "council seats follow the configured routing and Codex goes through the cycle's shim", roles: undefined, policy: "claude,commandcode:xai/grok-4.7,commandcode:xiaomi/mimo-v2.6-pro,commandcode:qwen/qwen3.8-max-0902,codex", members: "5" },
  { name: "a routing with more than five models seats them all on a seven-member council", roles: { ...canonicalRouting, implementer: { provider: "commandcode", model: "deepseek/deepseek-v4-flash" } }, policy: "claude,commandcode:xai/grok-4.7,commandcode:xiaomi/mimo-v2.6-pro,commandcode:qwen/qwen3.8-max-0902,commandcode:deepseek/deepseek-v4-flash,codex", members: "7" },
]) test(name, { skip: process.platform !== "linux" }, async t => {
  const octopusRoot = await mkdtemp(join(tmpdir(), "development-cycle-council-routing-"));
  t.after(() => rm(octopusRoot, { recursive: true, force: true }));
  const home = join(octopusRoot, "home");
  writeCanonicalRoutingConfig(home, roles);
  const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, OCTOPUS_COUNCIL_AUTO_PROVIDERS: process.env.OCTOPUS_COUNCIL_AUTO_PROVIDERS };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  delete process.env.OCTOPUS_COUNCIL_AUTO_PROVIDERS;
  const { checkout, call, seed } = await fixture(t, { DEVELOPMENT_CYCLE_OCTOPUS_ROOT: octopusRoot, HOME: home, CODEX_HOME: "/elsewhere/codex" });
  await mkdir(join(octopusRoot, "scripts"), { recursive: true });
  const seen = join(octopusRoot, "seen.json");
  await writeFile(join(octopusRoot, "scripts", "orchestrate.sh"), `#!/bin/sh\nnode -e 'const a=process.argv.slice(1);require("fs").writeFileSync(process.env.SEEN,JSON.stringify({providers:a[a.indexOf("--providers")+1],members:a[a.indexOf("--members")+1],policy:process.env.OCTOPUS_COUNCIL_DEFAULT_PROVIDERS,claude:process.env.OCTOPUS_CLAUDE_MODEL,codex:process.env.OCTOPUS_CODEX_MODEL,commandcode:process.env.OCTOPUS_COMMANDCODE_MODEL,codexHome:process.env.CODEX_HOME||null,codexBin:require("child_process").execSync("command -v codex",{encoding:"utf8"}).trim()}))' -- "$@"\n`, { mode: 0o755 });
  process.env.SEEN = seen;
  t.after(() => { delete process.env.SEEN; });
  await seed({ phase: "external_validation_passed", implementationAdapter: "octopus", outputPath: checkout });
  await call("reconcile", { autoRunCouncilReview: true, notifyMain: false, autoStopStalled: false });
  const launched = JSON.parse(await readFile(seen, "utf8"));
  assert.equal(launched.providers, "auto");
  assert.equal(launched.policy, policy);
  assert.equal(launched.members, members);
  assert.deepEqual([launched.claude, launched.commandcode, launched.codex], ["claude-sonnet-5-5", undefined, "gpt-6.1-sol"]);
  assert.equal(launched.codexHome, null);
  assert.equal(launched.codexBin, resolve("bin/codex"));
});

test("a routing with more models than Octopus can seat refuses the council instead of dropping one", { skip: process.platform !== "linux" }, async t => {
  const octopusRoot = await mkdtemp(join(tmpdir(), "development-cycle-council-oversized-"));
  t.after(() => rm(octopusRoot, { recursive: true, force: true }));
  const home = join(octopusRoot, "home");
  const roles = Object.fromEntries(Object.keys(canonicalRouting).map((role, index) => [role, { provider: "commandcode", model: `vendor/model-${index}` }]));
  writeCanonicalRoutingConfig(home, roles);
  const { checkout, call, seed } = await fixture(t, { DEVELOPMENT_CYCLE_OCTOPUS_ROOT: octopusRoot, HOME: home });
  await mkdir(join(octopusRoot, "scripts"), { recursive: true });
  const launched = join(octopusRoot, "launched");
  await writeFile(join(octopusRoot, "scripts", "orchestrate.sh"), `#!/bin/sh\ntouch "${launched}"\n`, { mode: 0o755 });
  await seed({ phase: "external_validation_passed", implementationAdapter: "octopus", outputPath: checkout });
  const result = await call("reconcile", { autoRunCouncilReview: true, notifyMain: false, autoStopStalled: false });
  assert.equal(result.councilEndgate.council.reason, "council_seats_exceed_octopus_limit", JSON.stringify(result));
  assert.equal(result.councilEndgate.council.seatCount, Object.keys(canonicalRouting).length);
  await assert.rejects(readFile(launched));
});

for (const { name, verdicts, decision } of [
  { name: "a council whose answering seats all ask for changes sends the run to corrections", verdicts: ["REVISE", "REVISE", "REVISE"], decision: "revise" },
  { name: "a unanimous objection that includes a veto stops the run instead of correcting it", verdicts: ["REVISE", "BLOCK", "REVISE"], decision: "stop" },
]) test(name, { skip: process.platform !== "linux" }, async t => {
  const octopusRoot = await mkdtemp(join(tmpdir(), "development-cycle-council-objection-"));
  t.after(() => rm(octopusRoot, { recursive: true, force: true }));
  const { checkout, call, seed } = await fixture(t, { DEVELOPMENT_CYCLE_OCTOPUS_ROOT: octopusRoot });
  await mkdir(join(octopusRoot, "scripts"), { recursive: true });
  // What Octopus writes when its quorum answered but approved nothing: partial, no synthesis, exit 1.
  const summary = JSON.stringify({ status: "partial", quorum: { required_non_chair: 2, received_non_chair: 2 }, seats: verdicts.map((verdict) => ({ status: "responded", verdict })) });
  await writeFile(join(octopusRoot, "scripts", "orchestrate.sh"), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output-dir ]; then output="$2"; break; fi; shift; done\nmkdir -p "$output/result/responses"\nprintf '%s' '${summary}' > "$output/result/summary.json"\nprintf '%s' 'HIGH: add() subtracts instead of adding. VERDICT: REVISE' > "$output/result/responses/00-code-reviewer.md"\nexit 1\n`, { mode: 0o755 });
  await seed({ phase: "external_validation_passed", implementationAdapter: "octopus", outputPath: checkout });
  const result = await call("reconcile", { autoRunCouncilReview: true, autoCouncilCorrections: decision === "stop", notifyMain: false, autoStopStalled: false });
  assert.equal(result.status.phase, "council_review_needs_corrections", JSON.stringify(result));
  assert.equal(result.councilEndgate.council.decision, decision);
  assert.ok(result.councilEndgate.council.findings.some((finding) => /subtracts/.test(finding)), JSON.stringify(result.councilEndgate.council.findings));
  if (decision === "stop") assert.equal(result.councilEndgate.corrections ?? null, null);
});

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
