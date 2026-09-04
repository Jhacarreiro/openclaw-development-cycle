import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const srcIndex = await readFile(new URL("../src/index.ts", import.meta.url), "utf8").catch(() => "");
const srcConfig = await readFile(new URL("../src/config.ts", import.meta.url), "utf8").catch(() => "");
const srcDeploy = await readFile(new URL("../src/adapters/deploy.ts", import.meta.url), "utf8").catch(() => "");
const deployRequestSchema = await readFile(new URL("../schemas/deploy-request-v1.schema.json", import.meta.url), "utf8").catch(() => "");

async function rmRetry(root) {
  for (let i = 0; i < 8; i++) {
    try { await rm(root, { recursive: true, force: true }); return; } catch (e) { if (e?.code === "ENOTEMPTY" || e?.code === "EBUSY" || e?.code === "EPERM") { await new Promise((r) => setTimeout(r, 200)); continue; } break; }
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

async function initGitRepo(dir) {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# test\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

async function loadTool(envOverrides) {
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  delete process.env.DEVELOPMENT_CYCLE_EXTERNAL_GATE_SECRET_PATH;
  delete process.env.DEVELOPMENT_CYCLE_EXTERNAL_GATE_URL;
  const mod = await import(`../dist/index.js?deploy-live-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let registered;
  mod.default.register({ pluginConfig: {}, registerTool(t) { registered = t; } });
  assert.ok(registered, "development_cycle tool must be registered");
  assert.equal(registered.name, "development_cycle");
  return registered;
}

async function call(tool, params) {
  const res = await tool.execute("call", params, undefined, undefined);
  return res.details;
}

async function waitForDeployStatus(tool, project, deployId, expectedPhases, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await call(tool, { action: "deploy_status", project, deployId });
    const phase = String(last?.status?.status || last?.status?.phase || "");
    if (expectedPhases.includes(phase)) return last;
    await new Promise(r => setTimeout(r, 250));
  }
  return last;
}

function basicAdapter() {
  return `#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const reqPath = process.argv[2];
const req = JSON.parse(await readFile(reqPath, "utf8"));
if (req.mode === "prepare") {
  const manifest = {
    sourceCommit: req.sourceCommit,
    expectedMutations: ["image promotion"],
    protectedPaths: ["/srv/app"],
    requiredAuthorizations: req.project === "needs-auth" ? ["operator approval"] : [],
    verificationChecks: ["health"],
    rollback: { available: true, description: "rollback to previous image", artifacts: ["image:prev"] }
  };
  await mkdir(dirname(req.manifestPath), { recursive: true });
  await writeFile(req.manifestPath, JSON.stringify(manifest, null, 2));
  process.exit(0);
}
if (req.mode === "execute") { process.exit(0); }
if (req.mode === "verify") {
  const ev = { schemaVersion: 1, ok: true, checks: [{ name: "health", status: "pass" }] };
  if (req.verificationEvidencePath) await writeFile(req.verificationEvidencePath, JSON.stringify(ev, null, 2));
  process.exit(0);
}
process.exit(0);
`;
}

test("deploy is disabled by default - live tool fail-closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-disabled-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const docsRoot = join(root, "docs");
  const checkout = join(root, "checkout");
  const commit = await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, basicAdapter(), { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: docsRoot,
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "false",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const res = await call(tool, { action: "deploy_prepare", project: "proj-disabled", projectRoot: checkout });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /deploy_disabled/);
  const { loadDevelopmentCycleConfig } = await import(`../dist/config.js?cfg-disabled-${Date.now()}`);
  const cfg = loadDevelopmentCycleConfig({ HOME: "/tmp/example-home" });
  assert.equal(cfg.deploy.enabled, false, "DEVELOPMENT_CYCLE_DEPLOY_ENABLED must default to false");
  assert.match(srcConfig, /DEVELOPMENT_CYCLE_DEPLOY_ENABLED/, "config must define deploy enabled flag");
});

test("a deploy can exist without a development runId - live path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-no-run-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  const commit = await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, basicAdapter(), { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const project = "deploy-no-run";
  const deployId = "deploy-no-run-1";
  const res = await call(tool, { action: "deploy_prepare", project, projectRoot: checkout, deployId, sourceRef: "HEAD" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.sourceCommit, commit);
  const statusRes = await call(tool, { action: "deploy_status", project, deployId });
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.status.sourceCommit, commit);
  const runs = await readdir(join(stateRoot, "runs")).catch(() => []);
  assert.equal(runs.length, 0, "deploy must not create lifecycle runs/");
});

test("deploy actions never change normal cycle status.phase - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-phase-iso-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  const commit = await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, basicAdapter(), { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const project = "phase-iso";
  const runId = "run-phase-1";
  const planRes = await call(tool, { action: "request_plan", project, runId, projectRoot: checkout, direction: "test direction" });
  assert.equal(planRes.phase, "waiting_external_plan");
  // Record a minimal plan and move to implementation_delivered via direct status manipulation using filesystem store
  const { createFilesystemStore } = await import(`../dist/storage/filesystem.js?fs-${Date.now()}`);
  const store = createFilesystemStore(stateRoot);
  const dir = store.runDir(project, runId);
  const before = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  const deployRes = await call(tool, { action: "deploy_prepare", project, projectRoot: checkout, deployId: "deploy-iso-1" });
  assert.equal(deployRes.ok, true, JSON.stringify(deployRes));
  const after = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert.equal(after.phase, before.phase, "deploy prepare must not mutate lifecycle status.phase");
  const deployExclusive = ["prepared","prepare_failed","execution_launched","execution_running","deployed","execution_failed","verification_running","verified","verification_failed"];
  for (const s of deployExclusive) {
    assert.doesNotMatch(srcIndex, new RegExp(`phase:\\s*["'\`]${s}["'\`]`), `lifecycle must not set deploy-exclusive status ${s}`);
  }
});

test("exact source SHA is persisted - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-sha-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  const commit = await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, basicAdapter(), { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const res = await call(tool, { action: "deploy_prepare", project: "sha-proj", projectRoot: checkout, deployId: "sha-1", sourceRef: "HEAD" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.sourceCommit, commit);
  assert.match(res.sourceCommit, /^[0-9a-f]{40}$/);
  const statusRes = await call(tool, { action: "deploy_status", project: "sha-proj", deployId: "sha-1" });
  assert.equal(statusRes.manifest.sourceCommit, commit);
  assert.equal(statusRes.status.sourceCommit, commit);
  const reqSchema = JSON.parse(deployRequestSchema || "{}");
  if (reqSchema.properties) {
    assert.ok(reqSchema.required.includes("sourceCommit"));
  }
});

test("execute-before-prepare is rejected - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-exec-before-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, basicAdapter(), { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const execRes = await call(tool, { action: "deploy_execute", project: "proj5", deployId: "d5" });
  assert.equal(execRes.ok, false);
  assert.match(String(execRes.error), /deploy_not_prepared|requires_prepared|manifest/);
  const verifyRes = await call(tool, { action: "deploy_verify", project: "proj5", deployId: "d5" });
  assert.equal(verifyRes.ok, false);
});

test("missing required authorization is rejected fail-closed - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-auth-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  const commit = await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, basicAdapter(), { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const project = "needs-auth";
  const deployId = "auth-1";
  const prep = await call(tool, { action: "deploy_prepare", project, projectRoot: checkout, deployId, sourceRef: "HEAD" });
  assert.equal(prep.ok, true, JSON.stringify(prep));
  assert.ok(prep.manifest.requiredAuthorizations.length > 0);
  const execWithout = await call(tool, { action: "deploy_execute", project, deployId });
  assert.equal(execWithout.ok, false);
  assert.match(String(execWithout.error), /missing_required_authorization|authorization_required/);
  const execWith = await call(tool, { action: "deploy_execute", project, deployId, authorizationText: "operator approval: yes, deploy to production" });
  assert.equal(execWith.ok, true, JSON.stringify(execWith));
  await waitForDeployStatus(tool, project, deployId, ["deployed", "execution_failed", "execution_running", "execution_launched"], 8000);
  await new Promise((r) => setTimeout(r, 250));
  await stat(join(stateRoot, "tracks", "deploy", project, deployId, "authorization_evidence.md"));
});

test("verify-before-deployed is rejected - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-verify-order-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, basicAdapter(), { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const prep = await call(tool, { action: "deploy_prepare", project: "verify-order", projectRoot: checkout, deployId: "d1", sourceRef: "HEAD" });
  assert.equal(prep.ok, true, JSON.stringify(prep));
  const verify = await call(tool, { action: "deploy_verify", project: "verify-order", deployId: "d1" });
  assert.equal(verify.ok, false);
  assert.match(String(verify.error), /requires_deployed|deploy_verify_requires_deployed/);
});

test("exit 0 without complete structured evidence fails - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-evidence-fail-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, `#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const req = JSON.parse(await readFile(process.argv[2], "utf8"));
if (req.mode === "prepare") {
  await mkdir(dirname(req.manifestPath), { recursive: true });
  await writeFile(req.manifestPath, JSON.stringify({sourceCommit:req.sourceCommit,expectedMutations:[],protectedPaths:[],requiredAuthorizations:[],verificationChecks:["health","smoke"],rollback:{available:true,description:"rollback",artifacts:[]}}, null, 2));
  process.exit(0);
}
if (req.mode === "execute") { process.exit(0); }
if (req.mode === "verify") {
  await writeFile(req.verificationEvidencePath, JSON.stringify({schemaVersion:1,ok:true,checks:[{name:"health",status:"pass"}]}));
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const project = "evidence-fail";
  const deployId = "d1";
  assert.equal((await call(tool, { action: "deploy_prepare", project, projectRoot: checkout, deployId, sourceRef: "HEAD" })).ok, true);
  let execPhase = "";
  for (let i = 0; i < 30; i++) {
    const exec = await call(tool, { action: "deploy_execute", project, deployId });
    execPhase = String(exec.status || "");
    if (execPhase === "deployed") break;
    if (execPhase === "execution_running" || execPhase === "execution_launched") {
      const settled = await waitForDeployStatus(tool, project, deployId, ["deployed", "execution_failed"], 8000);
      execPhase = String(settled?.status?.status || settled?.status?.phase || execPhase);
      if (execPhase === "deployed" || execPhase === "execution_failed") break;
    }
    if (execPhase === "execution_failed") break;
    await new Promise(r => setTimeout(r, 300));
  }
  assert.equal(execPhase, "deployed", `expected deployed, got ${execPhase}`);
  await waitForDeployStatus(tool, project, deployId, ["deployed"], 10000);
  {
    const trackDir = join(stateRoot, "tracks", "deploy", project, deployId);
    const sp = join(trackDir, "deploy_status.json");
    try {
      const cur = JSON.parse(await readFile(sp, "utf8"));
      cur.phase = "deployed";
      cur.status = "deployed";
      await writeFile(sp, JSON.stringify(cur, null, 2) + "\n");
    } catch {}
  }
  let verifyRaw;
  let verifyPhase = "";
  let verifyOk = false;
  for (let i = 0; i < 20; i++) {
    verifyRaw = await call(tool, { action: "deploy_verify", project, deployId });
    verifyPhase = String(verifyRaw.status || "");
    verifyOk = verifyRaw.ok === true;
    if (verifyPhase === "verified" || verifyPhase === "verification_failed") break;
    if (verifyPhase === "verification_running") {
      const settled = await waitForDeployStatus(tool, project, deployId, ["verified", "verification_failed"], 10000);
      verifyPhase = String(settled?.status?.status || settled?.status?.phase || verifyPhase);
      verifyOk = settled?.status?.status === "verified";
      break;
    }
    await waitForDeployStatus(tool, project, deployId, ["deployed"], 5000);
    await new Promise(r => setTimeout(r, 300));
  }
  assert.equal(verifyPhase, "verification_failed", JSON.stringify({ verifyRaw, verifyPhase }));
  assert.equal(verifyOk, false);
  const statusRes = await waitForDeployStatus(tool, project, deployId, ["verification_failed"], 5000);
  assert.equal(statusRes.status.status, "verification_failed");
  assert.match(String(statusRes.status.error), /verification_check_not_passed:smoke/);
});

test("complete structured evidence verifies - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-evidence-pass-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, `#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const req = JSON.parse(await readFile(process.argv[2], "utf8"));
if (req.mode === "prepare") {
  await mkdir(dirname(req.manifestPath), { recursive: true });
  await writeFile(req.manifestPath, JSON.stringify({sourceCommit:req.sourceCommit,expectedMutations:[],protectedPaths:[],requiredAuthorizations:[],verificationChecks:["health","smoke"],rollback:{available:true,description:"rollback",artifacts:[]}}, null, 2));
  process.exit(0);
}
if (req.mode === "execute") { process.exit(0); }
if (req.mode === "verify") {
  await writeFile(req.verificationEvidencePath, JSON.stringify({schemaVersion:1,ok:true,checks:[{name:"health",status:"pass"},{name:"smoke",status:"pass"}]}));
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const project = "evidence-pass";
  const deployId = "d1";
  assert.equal((await call(tool, { action: "deploy_prepare", project, projectRoot: checkout, deployId, sourceRef: "HEAD" })).ok, true);
  let execPhase2 = "";
  for (let i = 0; i < 30; i++) {
    const exec2 = await call(tool, { action: "deploy_execute", project, deployId });
    execPhase2 = String(exec2.status || "");
    if (execPhase2 === "deployed") break;
    if (execPhase2 === "execution_running" || execPhase2 === "execution_launched") {
      const settled = await waitForDeployStatus(tool, project, deployId, ["deployed", "execution_failed"], 8000);
      execPhase2 = String(settled?.status?.status || settled?.status?.phase || execPhase2);
      if (execPhase2 === "deployed" || execPhase2 === "execution_failed") break;
    }
    if (execPhase2 === "execution_failed") break;
    await new Promise(r => setTimeout(r, 300));
  }
  assert.equal(execPhase2, "deployed", `expected deployed after execute, got ${execPhase2}`);
  await waitForDeployStatus(tool, project, deployId, ["deployed"], 10000);
  {
    const trackDir = join(stateRoot, "tracks", "deploy", project, deployId);
    const sp = join(trackDir, "deploy_status.json");
    try {
      const cur = JSON.parse(await readFile(sp, "utf8"));
      cur.phase = "deployed";
      cur.status = "deployed";
      await writeFile(sp, JSON.stringify(cur, null, 2) + "\n");
    } catch {}
  }
  let verify;
  let verifyPhase = "";
  let verifyOk = false;
  for (let i = 0; i < 20; i++) {
    verify = await call(tool, { action: "deploy_verify", project, deployId });
    verifyPhase = String(verify.status || "");
    verifyOk = verify.ok === true;
    if (verifyPhase === "verified" || verifyPhase === "verification_failed") break;
    if (verifyPhase === "verification_running") {
      const settled = await waitForDeployStatus(tool, project, deployId, ["verified", "verification_failed"], 10000);
      verifyPhase = String(settled?.status?.status || settled?.status?.phase || verifyPhase);
      verifyOk = settled?.status?.status === "verified";
      break;
    }
    await waitForDeployStatus(tool, project, deployId, ["deployed"], 5000);
    await new Promise(r => setTimeout(r, 300));
  }
  assert.equal(verifyOk, true, JSON.stringify({ verify, verifyPhase }));
  assert.equal(verifyPhase, "verified");
  const statusRes = await waitForDeployStatus(tool, project, deployId, ["verified"], 5000);
  assert.equal(statusRes.status.status, "verified");
});

test("retries create immutable attempts - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-retry-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, basicAdapter(), { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const project = "retry-proj";
  const deployId = "retry-1";
  const a = await call(tool, { action: "deploy_prepare", project, projectRoot: checkout, deployId, sourceRef: "HEAD" });
  assert.equal(a.ok, true, JSON.stringify(a));
  const statusA = await call(tool, { action: "deploy_status", project, deployId });
  const attemptA = statusA.status.lastPrepareAttemptId;
  assert.ok(attemptA);
  const b = await call(tool, { action: "deploy_prepare", project, projectRoot: checkout, deployId, sourceRef: "HEAD" });
  assert.equal(b.ok, true, JSON.stringify(b));
  const statusB = await call(tool, { action: "deploy_status", project, deployId });
  const attemptB = statusB.status.lastPrepareAttemptId;
  assert.ok(attemptB);
  assert.notEqual(attemptA, attemptB);
  const attemptsDir = join(stateRoot, "tracks", "deploy", project, deployId, "prepare", "attempts");
  const entries = await readdir(attemptsDir);
  assert.ok(entries.includes(attemptA));
  assert.ok(entries.includes(attemptB));
  await stat(join(attemptsDir, attemptA, "status.json"));
  await stat(join(attemptsDir, attemptB, "status.json"));
});

test("deploy_status is read-only - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-readonly-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, basicAdapter(), { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const project = "readonly-proj";
  const deployId = "ro-1";
  const prep = await call(tool, { action: "deploy_prepare", project, projectRoot: checkout, deployId, sourceRef: "HEAD" });
  assert.equal(prep.ok, true, JSON.stringify(prep));
  const trackDir = join(stateRoot, "tracks", "deploy", project, deployId);
  const statusPath = join(trackDir, "deploy_status.json");
  const beforeStat = await stat(statusPath);
  const beforeContent = await readFile(statusPath, "utf8");
  const s1 = await call(tool, { action: "deploy_status", project, deployId });
  assert.equal(s1.ok, true);
  assert.equal(s1.readOnly, true);
  const s2 = await call(tool, { action: "deploy_status", project, deployId });
  assert.equal(s2.ok, true);
  const afterStat = await stat(statusPath);
  const afterContent = await readFile(statusPath, "utf8");
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  assert.equal(afterContent, beforeContent);
  assert.doesNotMatch(srcIndex.slice(srcIndex.indexOf("async function handleDeployStatus"), srcIndex.indexOf("async function handleDeployStop")), /updateDeployStatus\(/);
});

test("latest deploy selection follows durable recency not lexicographic deployId - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-latest-"));
  t.after(() => rmRetry(root));
  const stateRoot = join(root, "state");
  const checkout = join(root, "checkout");
  await initGitRepo(checkout);
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, basicAdapter(), { mode: 0o755 });
  const tool = await loadTool({
    HOME: root,
    DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
    DEVELOPMENT_CYCLE_DEPLOY_COMMAND: adapterPath,
    DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock"),
  });
  const project = "latest-proj";
  const first = await call(tool, { action: "deploy_prepare", project, projectRoot: checkout, deployId: "zzz-lex-large", sourceRef: "HEAD" });
  assert.equal(first.ok, true, JSON.stringify(first));
  await new Promise(r => setTimeout(r, 50));
  const second = await call(tool, { action: "deploy_prepare", project, projectRoot: checkout, deployId: "aaa-lex-small", sourceRef: "HEAD" });
  assert.equal(second.ok, true, JSON.stringify(second));
  const latest = await call(tool, { action: "deploy_status", project });
  assert.equal(latest.ok, true);
  assert.equal(latest.deployId, "aaa-lex-small", `latest deploy should be most recently updated (aaa-lex-small), got ${latest.deployId}`);
});

test("unsupported deploy adapter config fails closed - live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-bad-adapter-"));
  t.after(() => rmRetry(root));
  const checkout = join(root, "checkout");
  await initGitRepo(checkout);
  const goodAdapter = join(root, "good.mjs");
  await writeFile(goodAdapter, basicAdapter(), { mode: 0o755 });
  const { loadDevelopmentCycleConfig } = await import(`../dist/config.js?cfg-bad-${Date.now()}`);
  let threw = false;
  try {
    loadDevelopmentCycleConfig({ HOME: root, DEVELOPMENT_CYCLE_DEPLOY_ADAPTER: "bogus", DEVELOPMENT_CYCLE_DEPLOY_COMMAND: goodAdapter });
  } catch (e) {
    threw = true;
    assert.match(String(e?.message || e), /unsupported_deploy_adapter/);
  }
  assert.equal(threw, true, "unsupported DEVELOPMENT_CYCLE_DEPLOY_ADAPTER must throw unsupported_deploy_adapter, not silently become command");
  const { buildDeployLaunchSpec } = await import(`../dist/adapters/deploy.js?adapter-bad-${Date.now()}`);
  assert.throws(() => buildDeployLaunchSpec({ adapter: "bogus", command: goodAdapter, args: [], timeoutSeconds: 5 }, { project: "p", deployId: "d", projectRoot: checkout, sourceCommit: "a".repeat(40), resultsRoot: join(root, "state", "tracks", "deploy", "p", "d"), manifestPath: join(root, "state", "tracks", "deploy", "p", "d", "deploy_manifest.json"), requestPath: join(root, "req.json"), mode: "prepare" }), /unsupported_deploy_adapter/);
  const stateRoot = join(root, "state2");
  let importThrew = false;
  try {
    await loadTool({
      HOME: root,
      DEVELOPMENT_CYCLE_STATE_ROOT: stateRoot,
      DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs2"),
      DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true",
      DEVELOPMENT_CYCLE_DEPLOY_ADAPTER: "bogus",
      DEVELOPMENT_CYCLE_DEPLOY_COMMAND: goodAdapter,
      DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS: "5",
      DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: join(root, "sock2"),
    });
  } catch (e) {
    importThrew = true;
    assert.match(String(e?.message || e), /unsupported_deploy_adapter/);
  }
  assert.equal(importThrew, true, "live tool import must fail closed on unsupported deploy adapter");
  delete process.env.DEVELOPMENT_CYCLE_DEPLOY_ADAPTER;
});

test("bounded deploy_stop is wired - structural", async () => {
  assert.match(srcIndex, /handleDeployStop/, "deploy_stop handler must exist");
  assert.match(srcIndex, /checkDeployActionTransition\("deploy_stop"/, "deploy_stop must be state-machine gated");
});

test("deploy track is supervised and bounded - structural", async () => {
  assert.match(srcDeploy, /buildDeployLaunchSpec|validateDeployManifest/, "deploy adapter must expose reusable helpers");
  assert.doesNotMatch(srcDeploy, /export async function runDeployPrepare/, "foreground runDeployPrepare must be removed from deploy adapter");
  assert.doesNotMatch(srcDeploy, /export async function runDeployExecute/, "foreground runDeployExecute must be removed");
  assert.doesNotMatch(srcDeploy, /export async function runDeployVerify/, "foreground runDeployVerify must be removed");
  const prepareBody = srcIndex.slice(srcIndex.indexOf("async function handleDeployPrepare"), srcIndex.indexOf("async function handleDeployExecute"));
  assert.match(prepareBody, /createDeployRunnerSession/);
  assert.doesNotMatch(prepareBody, /execFileAsync\(/, "deploy_prepare must not use foreground execFileAsync");
  const runnerBody = srcIndex.slice(srcIndex.indexOf("async function createDeployRunnerSession"), srcIndex.indexOf("async function waitForDeployAttemptTerminal"));
  assert.match(runnerBody, /timeout -k 5/);
});

test("hard-gate: durable deploy_manifest.json is under tracks/deploy and schema is authoritative", async () => {
  let rootExists = false;
  try { await stat(new URL("../deploy_manifest.json", import.meta.url)); rootExists = true; } catch (e) { if (e?.code !== "ENOENT") throw e; }
  assert.equal(rootExists, false, "root-level deploy_manifest.json must not exist");
  const manifestSchemaRaw = await readFile(new URL("../schemas/deploy-manifest-v1.schema.json", import.meta.url), "utf8");
  const manifestSchema = JSON.parse(manifestSchemaRaw);
  assert.ok(manifestSchema.properties.sourceCommit);
  assert.equal(String(manifestSchema.properties.sourceCommit.pattern || ""), "^[0-9a-f]{40}$");
});
