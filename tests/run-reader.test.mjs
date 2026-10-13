import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { formatRunIndexMarkdown, readRunIndex } from "../dist/reader/index.js";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repository, "tests", "fixtures", "run-reader");
const cli = join(repository, "bin", "read-runs.mjs");
const readerUrl = pathToFileURL(join(repository, "dist", "reader", "index.js")).href;
const allRuns = (index) => index.projects.flatMap((project) => project.runs);
const findRun = (index, runId) => allRuns(index).find((run) => run.runId === runId);

async function temporaryFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-run-reader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "state");
  await cp(fixture, root, { recursive: true });
  return { directory, root };
}

async function treeHash(root) {
  const hash = createHash("sha256");
  async function visit(path) {
    const information = await lstat(path);
    hash.update(`${relative(root, path).replaceAll("\\", "/")}\0`);
    if (information.isSymbolicLink()) {
      hash.update(`link\0${await readlink(path)}\0`);
    } else if (information.isDirectory()) {
      hash.update("directory\0");
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else {
      hash.update("file\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

test("run index lists status-bearing runs grouped by project and ordered by recorded time", async () => {
  const index = await readRunIndex(fixture);
  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(index.projects.map(({ project, runs }) => ({
    project,
    runs: runs.map(({ runId }) => runId),
  })), [
    { project: "synthetic-alpha", runs: ["run-go", "run-revise", "run-stop", "run-malformed"] },
    { project: "synthetic-beta", runs: ["run-recovery", "run-review-failure"] },
  ]);
  for (const { project, runs } of index.projects) {
    for (const run of runs) {
      assert.equal(run.project, project);
      assert.equal(run.path, `runs/${project}/${run.runId}`);
      assert.equal(run.createdAt, null);
      assert.equal(run.unavailable.createdAt, run.status === "unreadable" ? "unreadable" : "not_recorded");
    }
  }
});

test("recorded outcomes, decisions, classes and counts remain distinct", async () => {
  const index = await readRunIndex(fixture);
  const go = findRun(index, "run-go");
  const revise = findRun(index, "run-revise");
  const stop = findRun(index, "run-stop");
  const recovery = findRun(index, "run-recovery");
  const review = findRun(index, "run-review-failure");
  assert.deepEqual([go.phase, go.terminal, go.finalDecision, go.implementationAdapter], ["closed", true, "go", "command"]);
  assert.deepEqual([revise.phase, revise.terminal, revise.finalDecision, revise.councilCorrectionRounds], ["closed_partial", true, "revise", 2]);
  assert.deepEqual([stop.phase, stop.terminal, stop.finalDecision, stop.endedAt], ["stopped", true, "stop", "2026-01-03T09:59:00.000Z"]);
  assert.deepEqual([recovery.phase, recovery.terminal, recovery.finalDecision, recovery.failureClass, recovery.automaticRecoveryCount, recovery.automaticRecoveryEvents], ["implementation_failed", true, null, "planner_reconsideration_contract_failure", 1, 1]);
  assert.deepEqual([review.phase, review.terminal, review.finalDecision, review.failureClass, review.automaticRecoveryCount], ["review_infrastructure_failed", true, null, "review_infrastructure_failed", 0]);
  assert.deepEqual([go.deliveryOutcome, go.prUrl], ["success", "https://github.com/example/synthetic-project/pull/1"]);
  assert.equal(revise.deliveryOutcome, "partial");
  for (const run of [go, revise, stop, recovery, review]) {
    assert.equal(run.status, "readable");
    assert.equal(run.interventionCount, null);
    assert.equal(run.unavailable.interventionCount, "not_recorded");
    assert.equal(run.correctionRounds, null);
    assert.equal(run.unavailable.correctionRounds, "not_recorded");
    assert.equal(run.startedAt, null);
    assert.equal(run.durationMs, null);
    assert.equal(run.unavailable.durationMs, "not_recorded");
    assert.equal(run.acceptanceChecks, null);
    assert.equal(run.solutionValue, null);
    assert.equal(run.cost, null);
  }
  assert.equal(go.failureClass, null);
  assert.equal(go.unavailable.failureClass, "not_recorded");
});

test("malformed status is a visible unreadable run and does not hide other runs", async () => {
  const index = await readRunIndex(fixture);
  const malformed = findRun(index, "run-malformed");
  assert.equal(allRuns(index).length, 6);
  assert.equal(malformed.status, "unreadable");
  assert.equal(malformed.phase, null);
  assert.equal(malformed.terminal, null);
  assert.equal(malformed.unavailable.phase, "unreadable");
  assert.equal(findRun(index, "run-go").finalDecision, "go");
});

test("run symlink outside the state root is excluded without reading its target", async (t) => {
  const { directory, root } = await temporaryFixture(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "status.json"), JSON.stringify({ phase: "closed", implementationAdapter: "SYNTHETIC_OUTSIDE_SECRET" }));
  await symlink(outside, join(root, "runs", "synthetic-alpha", "outside-link"), process.platform === "win32" ? "junction" : "dir");
  const code = `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { relative, resolve, isAbsolute } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { readRunIndex } from ${JSON.stringify(readerUrl)};
    const root = process.argv[1];
    const outsideReads = [];
    function check(path) {
      if (typeof path !== 'string' && !(path instanceof URL) && !Buffer.isBuffer(path)) return;
      const value = path instanceof URL ? fileURLToPath(path) : String(path);
      const rel = relative(root, resolve(value));
      if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\\\' : '/')) || isAbsolute(rel)) {
        outsideReads.push(value);
        throw new Error('Synthetic outside file read denied');
      }
    }
    for (const target of [fs, fsp]) {
      for (const method of target === fs ? ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream'] : ['readFile', 'open']) {
        const original = target[method];
        target[method] = function(path, ...args) { check(path); return original.call(this, path, ...args); };
      }
    }
    syncBuiltinESMExports();
    const index = await readRunIndex(root);
    console.log(JSON.stringify({ index, outsideReads }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", code, root]);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.outsideReads, []);
  assert.equal(allRuns(result.index).length, 6);
  assert.equal(findRun(result.index, "outside-link"), undefined);
  assert.equal(stdout.includes("SYNTHETIC_OUTSIDE_SECRET"), false);
});

test("library and both CLI formats leave state root byte-for-byte unchanged", async (t) => {
  const { root } = await temporaryFixture(t);
  const before = await treeHash(root);
  await readRunIndex(root);
  await execFileAsync(process.execPath, [cli, root]);
  await execFileAsync(process.execPath, [cli, root, "--format", "markdown"]);
  assert.equal(await treeHash(root), before);
});

test("Markdown columns match the reliability baseline per-run table", async () => {
  const baseline = await readFile(join(repository, "docs", "reliability-baseline.md"), "utf8");
  const section = baseline.split("## Per-run record")[1].split("## Proposed criterion")[0];
  const fields = section.split(/\r?\n/).filter((line) => /^\| [a-z]/.test(line)).map((line) => line.split("|")[1].trim());
  assert.equal(fields.length, 9);
  const index = await readRunIndex(fixture);
  const markdown = formatRunIndexMarkdown(index);
  const header = markdown.split(/\r?\n/).find((line) => line.startsWith("|"));
  const columns = header.split("|").slice(1, -1).map((column) => column.trim());
  for (const field of fields) assert.ok(columns.includes(field), `missing baseline column: ${field}`);
  assert.ok(markdown.includes("run-go"));
  assert.ok(markdown.includes("unavailable"));
});

test("CLI defaults to JSON, filters a project and supports Markdown", async () => {
  const { stdout: json } = await execFileAsync(process.execPath, [cli, fixture]);
  assert.deepEqual(JSON.parse(json), await readRunIndex(fixture));
  const { stdout: filtered } = await execFileAsync(process.execPath, [cli, fixture, "--project", "synthetic-beta"]);
  assert.deepEqual(JSON.parse(filtered).projects.map(({ project }) => project), ["synthetic-beta"]);
  assert.deepEqual(await readRunIndex(fixture, { project: "synthetic-beta" }), JSON.parse(filtered));
  const { stdout: markdown } = await execFileAsync(process.execPath, [cli, fixture, "--project", "synthetic-alpha", "--format", "markdown"]);
  assert.ok(markdown.includes("run-go"));
  assert.equal(markdown.includes("run-recovery"), false);
});

test("library loads and reads runs without node_modules or OpenClaw", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-standalone-reader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(repository, "dist", "reader"), join(directory, "dist", "reader"), { recursive: true });
  await cp(join(repository, "dist", "core"), join(directory, "dist", "core"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  assert.equal(await lstat(join(directory, "node_modules")).catch(() => null), null);
  const standalone = pathToFileURL(join(directory, "dist", "reader", "index.js")).href;
  const code = `import { readRunIndex } from ${JSON.stringify(standalone)}; console.log(JSON.stringify(await readRunIndex(process.argv[1])));`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", code, fixture], { cwd: directory });
  assert.equal(allRuns(JSON.parse(stdout)).length, 6);
});

test("missing decisions are unavailable rather than inferred from terminal phase", async (t) => {
  const { root } = await temporaryFixture(t);
  await rm(join(root, "runs", "synthetic-alpha", "run-go", "final_validation_response.md"));
  const run = findRun(await readRunIndex(root), "run-go");
  assert.equal(run.phase, "closed");
  assert.equal(run.finalDecision, null);
  assert.equal(run.unavailable.finalDecision, "not_recorded");
});

test("malformed optional decision and delivery affect those fields only", async (t) => {
  const { root } = await temporaryFixture(t);
  const runPath = join(root, "runs", "synthetic-alpha", "run-go");
  await writeFile(join(runPath, "final_validation_response.md"), "SYNTHETIC malformed decision with go mentioned later");
  await writeFile(join(runPath, "repository_delivery.json"), "{ bad json");
  const run = findRun(await readRunIndex(root), "run-go");
  assert.equal(run.status, "readable");
  assert.equal(run.phase, "closed");
  assert.equal(run.finalDecision, null);
  assert.equal(run.unavailable.finalDecision, "unreadable");
  assert.equal(run.deliveryOutcome, null);
  assert.equal(run.unavailable.deliveryOutcome, "unreadable");
});

test("durable recovery total survives missing retained event evidence", async (t) => {
  const { root } = await temporaryFixture(t);
  await rm(join(root, "runs", "synthetic-beta", "run-recovery", "automatic_recovery_events.jsonl"));
  const run = findRun(await readRunIndex(root), "run-recovery");
  assert.equal(run.automaticRecoveryCount, 1);
  assert.equal(run.automaticRecoveryEvents, null);
  assert.equal(run.unavailable.automaticRecoveryEvents, "pruned");
});

test("unsafe pointers and private artifact bodies cannot leak into the index", async (t) => {
  const { directory, root } = await temporaryFixture(t);
  const outside = join(directory, "outside-plan.md");
  await writeFile(outside, "SYNTHETIC_OUTSIDE_PLAN_BODY");
  const runPath = join(root, "runs", "synthetic-alpha", "run-go");
  const statusPath = join(runPath, "status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  status.plan = outside;
  status.projectRoot = join(directory, "SYNTHETIC_OUTSIDE_PROJECT");
  status.implementationStdout = outside;
  status.implementationPrompt = "SYNTHETIC_PRIVATE_PROMPT_BODY";
  await writeFile(statusPath, JSON.stringify(status));
  const index = await readRunIndex(root);
  const run = findRun(index, "run-go");
  assert.equal(run.planPath, null);
  assert.equal(run.unavailable.planPath, "unreadable");
  const output = JSON.stringify(index) + formatRunIndexMarkdown(index);
  for (const secret of [outside, "SYNTHETIC_PRIVATE_DECISION_BODY", "SYNTHETIC_PRIVATE_PLAN_BODY", "SYNTHETIC_PRIVATE_INTERVENTION_BODY", "SYNTHETIC_PRIVATE_PROMPT_BODY", "SYNTHETIC_OUTSIDE_PLAN_BODY", "SYNTHETIC_OUTSIDE_PROJECT"]) assert.equal(output.includes(secret), false);
});
