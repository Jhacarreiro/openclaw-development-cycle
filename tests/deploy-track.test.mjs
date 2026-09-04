import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDevelopmentCycleConfig } from "../dist/config.js";
import { buildDeployLaunchSpec, buildDeployRequest } from "../dist/adapters/deploy.js";
import { checkActionTransition } from "../dist/state-machine.js";
import { createFilesystemStore } from "../dist/storage/filesystem.js";
import { cleanId } from "../dist/core/ids.js";

const srcIndex = await readFile(new URL("../src/index.ts", import.meta.url), "utf8").catch(() => "");
const srcConfig = await readFile(new URL("../src/config.ts", import.meta.url), "utf8").catch(() => "");
const srcDeploy = await readFile(new URL("../src/adapters/deploy.ts", import.meta.url), "utf8").catch(() => "");
const deploySchema = await readFile(new URL("../schemas/deploy-request-v1.schema.json", import.meta.url), "utf8").catch(() => "");

async function tryImportDeployFull() {
  try {
    const mod = await import("../dist/adapters/deploy.js");
    const tracks = await import("../dist/tracks/deploy.js").catch(() => null);
    const deploySM = await import("../dist/core/deploy-state-machine.js").catch(() => null);
    return { mod, tracks, deploySM };
  } catch {
    return { mod: null, tracks: null, deploySM: null };
  }
}
const full = await tryImportDeployFull();
const hasFullDeploy = Boolean(full.mod && typeof full.mod.runDeployPrepare === "function");
const hasDeployTracks = Boolean(full.tracks && typeof full.tracks.deployTrackDir === "function");
const hasDeploySM = Boolean(full.deploySM && typeof full.deploySM.checkDeployActionTransition === "function");
assert.equal(hasFullDeploy, true, "deploy adapter runtime exports are required; static fallback is not acceptable");
assert.equal(hasDeployTracks, true, "deploy track runtime exports are required; static fallback is not acceptable");
assert.equal(hasDeploySM, true, "deploy state-machine runtime export is required; static fallback is not acceptable");

function deployStatuses() {
  return ["prepared","prepare_failed","execution_launched","execution_running","deployed","execution_failed","verification_running","verified","verification_failed","stopped"];
}

function makePrepareStub() {
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
  const fail = process.env.DEPLOY_VERIFY_SHOULD_FAIL === "1";
  process.exit(fail ? 1 : 0);
}
process.exit(0);
`;
}

async function writeSupervisorStub(path) {
  await writeFile(path, [
    "import json, sys, subprocess",
    "args = sys.argv",
    "if 'ping' in args:",
    "    print(json.dumps({'ok': True, 'subreaper': True, 'pid': 4242}))",
    "elif 'launch' in args:",
    "    i = args.index('launch')",
    "    runner = args[i+1] if len(args) > i+1 else ''",
    "    try:",
    "        p = subprocess.Popen(['/bin/sh', runner], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)",
    "        print(json.dumps({'ok': True, 'pid': p.pid, 'pgid': p.pid, 'supervisorPid': 4242}))",
    "    except Exception as e:",
    "        print(json.dumps({'ok': False, 'error': str(e)}))",
    "else:",
    "    print(json.dumps({'ok': False, 'argv': args}))",
    "",
  ].join("\n"));
}

test("1. deploy actions never change normal cycle status.phase", async (t) => {
  assert.equal(srcIndex.includes("cycleStatus") || srcIndex.includes("status.json"), true, "src/index.ts should manage deploy/lifecycle status");
  const deployExclusiveStatuses = ["prepared","prepare_failed","execution_launched","execution_running","deployed","execution_failed","verification_running","verified","verification_failed"];
  for (const s of deployExclusiveStatuses) {
    assert.doesNotMatch(srcIndex, new RegExp(`phase:\\s*["'\`]${s}["'\`]`), `src/index.ts lifecycle must not set deploy-exclusive status ${s} on status.phase`);
  }
  const sm = await readFile(new URL("../src/core/state-machine.ts", import.meta.url), "utf8");
  for (const s of deployExclusiveStatuses) {
    assert.doesNotMatch(sm, new RegExp(`\\b${s}\\b`), `deploy-exclusive status ${s} must not be in src/core/state-machine.ts`);
  }
  for (const a of ["deploy_prepare","deploy_execute","deploy_verify","deploy_status","deploy_stop"]) {
    assert.doesNotMatch(sm, new RegExp(`\\b${a}\\b`), `deploy action ${a} must not be in lifecycle state machine`);
  }
  assert.equal(checkActionTransition("status", "prepared").ok, true, "status is always-allowed even for deploy-like phase string");
  assert.equal(checkActionTransition("start_implementation", "prepared").ok, false, "lifecycle start_implementation must not be allowed from deploy phase");
  assert.equal(checkActionTransition("status", "verified").ok, true);

  if (hasFullDeploy && hasDeployTracks) {
    const root = await mkdtemp(join(tmpdir(), "deploy-track-1-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "checkout", ".git"), { recursive: true });
    const store = createFilesystemStore(join(root, "state"));
    const project = "deploy-phase-isolation";
    const runId = "run-1";
    const runDir = store.runDir(project, runId);
    await store.updateStatus(runDir, { project, runId, phase: "implementation_delivered", owner: "main" });
    const before = JSON.parse(await readFile(join(runDir, "status.json"), "utf8"));
    const adapterPath = join(root, "adapter.mjs");
    await writeFile(adapterPath, makePrepareStub(), { mode: 0o755 });
    const { deployTrackDir, deployManifestPath } = full.tracks;
    const { runDeployPrepare } = full.mod;
    const trackDir = deployTrackDir(join(root, "state"), project, "deploy-1");
    await mkdir(trackDir, { recursive: true });
    const commit = "abc123abc123abc123abc123abc123abc123abcd";
    const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: join(root, "sup.py"), supervisorSocket: join(root, "sock") };
    const prep = await runDeployPrepare(cfg, { project, deployId: "deploy-1", projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir), deploymentTarget: "production" });
    assert.equal(prep.ok, true, JSON.stringify(prep));
    const after = JSON.parse(await readFile(join(runDir, "status.json"), "utf8"));
    assert.equal(after.phase, before.phase, "deploy prepare must not mutate lifecycle status.phase");
    assert.equal(after.phase, "implementation_delivered");
  }
});

test("2. a deploy can exist without a development runId", async (t) => {
  assert.match(srcDeploy, /DeployLaunchInput|DeployMode|buildDeploy/, "deploy adapter must exist");
  assert.doesNotMatch(srcDeploy, /runId.*required/i, "deploy adapter must not require runId");
  if (hasFullDeploy && hasDeployTracks) {
    const root = await mkdtemp(join(tmpdir(), "deploy-track-2-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "checkout", ".git"), { recursive: true });
    const adapterPath = join(root, "adapter.mjs");
    await writeFile(adapterPath, makePrepareStub(), { mode: 0o755 });
    const { deployTrackDir, deployManifestPath } = full.tracks;
    const { runDeployPrepare } = full.mod;
    const project = "deploy-no-run";
    const deployId = cleanId("deploy-no-run-1", "deploy");
    const trackDir = deployTrackDir(join(root, "state"), project, deployId);
    const commit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
    const prep = await runDeployPrepare(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir), deploymentTarget: "production", sourceRunId: undefined });
    assert.equal(prep.ok, true, JSON.stringify(prep));
    await stat(deployManifestPath(trackDir));
    const manifest = JSON.parse(await readFile(deployManifestPath(trackDir), "utf8"));
    assert.equal(manifest.sourceCommit, commit);
    const runs = await readdir(join(root, "state", "runs")).catch(() => []);
    assert.equal(runs.length, 0, "deploy must not create a lifecycle runs/ dir");
  } else {
    const req = buildDeployRequest({ project: "x", deployId: "d1", projectRoot: "/repo", sourceRefRequested: "main", sourceCommit: "abc123", deploymentTarget: "production", resultsRoot: "/state/tracks/deploy/x/d1", manifestPath: "/state/tracks/deploy/x/d1/deploy_manifest.json", authorizationPath: "", mode: "prepare" });
    assert.equal(req.track, "deploy");
    assert.equal(req.sourceCommit, "abc123");
    assert.equal(typeof req.deployId, "string");
    assert.equal("runId" in req, false, "deploy request must not require runId");
    assert.match(JSON.stringify(req), /deploy/);
  }
});

test("3. deploy is disabled by default", async () => {
  const cfg = loadDevelopmentCycleConfig({ HOME: "/tmp/example-home" });
  assert.equal(cfg.deploy.enabled, false, "DEVELOPMENT_CYCLE_DEPLOY_ENABLED must default to false");
  assert.equal(cfg.deploy.adapter, "command");
  assert.equal(cfg.deploy.timeoutSeconds, 900);
  assert.match(srcConfig, /DEVELOPMENT_CYCLE_DEPLOY_ENABLED/, "config must define deploy enabled flag");
  assert.match(srcConfig, /boolean\(env,\s*"DEVELOPMENT_CYCLE_DEPLOY_ENABLED",\s*false\)/, "deploy must be disabled by default in source");
  const enabled = loadDevelopmentCycleConfig({ HOME: "/tmp/example-home", DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "true", DEVELOPMENT_CYCLE_DEPLOY_COMMAND: "/bin/true" });
  assert.equal(enabled.deploy.enabled, true);
  assert.equal(enabled.deploy.command, "/bin/true");
  const disabled = loadDevelopmentCycleConfig({ HOME: "/tmp/example-home", DEVELOPMENT_CYCLE_DEPLOY_ENABLED: "false" });
  assert.equal(disabled.deploy.enabled, false);
  if (hasFullDeploy) {
    const { runDeployPrepare } = full.mod;
    const root = await mkdtemp(join(tmpdir(), "deploy-disabled-"));
    try {
      await mkdir(join(root, "checkout", ".git"), { recursive: true });
      await mkdir(join(root, "state", "tracks", "deploy", "proj", "d1"), { recursive: true });
      const trackDir = join(root, "state", "tracks", "deploy", "proj", "d1");
      const off = { enabled: false, adapter: "command", command: "/bin/false", args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
      const res = await runDeployPrepare(off, { project: "proj", deployId: "d1", projectRoot: join(root, "checkout"), sourceCommit: "abc", resultsRoot: trackDir, manifestPath: join(trackDir, "deploy_manifest.json") });
      assert.equal(res.ok, false);
      assert.equal(res.error, "deploy_disabled");
    } finally { await rm(root, { recursive: true, force: true }); }
  } else {
    assert.match(srcConfig, /DEVELOPMENT_CYCLE_DEPLOY_ENABLED/, "config must define deploy enabled flag");
    assert.match(srcDeploy, /buildDeploy/, "deploy adapter module must exist");
  }
});

test("4. exact commit is persisted", async (t) => {
  const req = buildDeployRequest({ project: "p", deployId: "d", projectRoot: "/repo", sourceRefRequested: "main", sourceCommit: "0123456789abcdef0123456789abcdef01234567", deploymentTarget: "production", resultsRoot: "/state/tracks/deploy/p/d", manifestPath: "/state/tracks/deploy/p/d/deploy_manifest.json", authorizationPath: "", mode: "prepare" });
  assert.equal(req.sourceCommit, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(req.sourceRefRequested, "main");
  assert.equal(req.schemaVersion, 1);
  assert.equal(req.track, "deploy");
  assert.ok(deploySchema.length > 0, "deploy schema must exist");
  if (deploySchema) {
    const schema = JSON.parse(deploySchema);
    assert.equal(schema.properties.sourceCommit.minLength, 1);
    assert.ok(schema.required.includes("sourceCommit"));
    assert.ok(schema.required.includes("deployId"));
  }
  assert.match(srcDeploy, /sourceCommit/, "deploy adapter must handle sourceCommit");
  if (hasFullDeploy && hasDeployTracks) {
    const root = await mkdtemp(join(tmpdir(), "deploy-track-4-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "checkout", ".git"), { recursive: true });
    const adapterPath = join(root, "adapter.mjs");
    await writeFile(adapterPath, makePrepareStub(), { mode: 0o755 });
    const { deployTrackDir, deployManifestPath } = full.tracks;
    const { runDeployPrepare } = full.mod;
    const project = "deploy-commit";
    const deployId = "deploy-commit-1";
    const trackDir = deployTrackDir(join(root, "state"), project, deployId);
    await mkdir(trackDir, { recursive: true });
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
    const prep = await runDeployPrepare(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir), sourceRefRequested: "main" });
    assert.equal(prep.ok, true, JSON.stringify(prep));
    const manifest = JSON.parse(await readFile(deployManifestPath(trackDir), "utf8"));
    assert.equal(manifest.sourceCommit, commit);
    const storedReq = JSON.parse(await readFile(join(trackDir, "prepare", "attempts", prep.attemptId, "deploy_request.json"), "utf8"));
    assert.equal(storedReq.sourceCommit, commit);

    const badStub = `#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const req = JSON.parse(await readFile(process.argv[2], "utf8"));
const manifest = { sourceCommit: "mismatched", expectedMutations: [], protectedPaths: [], requiredAuthorizations: [], verificationChecks: [], rollback: { available: false, description: "", artifacts: [] } };
await mkdir(dirname(req.manifestPath), { recursive: true });
await writeFile(req.manifestPath, JSON.stringify(manifest, null, 2));
`;
    const badPath = join(root, "bad-adapter.mjs");
    await writeFile(badPath, badStub, { mode: 0o755 });
    const cfg2 = { enabled: true, adapter: "command", command: badPath, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
    const trackDir2 = deployTrackDir(join(root, "state"), project, "deploy-mismatch");
    await mkdir(trackDir2, { recursive: true });
    const prep2 = await runDeployPrepare(cfg2, { project, deployId: "deploy-mismatch", projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir2, manifestPath: deployManifestPath(trackDir2) });
    assert.equal(prep2.ok, false);
    assert.match(String(prep2.error), /sourceCommit_mismatch/);
  }
});

test("5. execute-before-prepare is rejected", async (t) => {
  if (hasFullDeploy && hasDeployTracks) {
    const root = await mkdtemp(join(tmpdir(), "deploy-track-5-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "checkout", ".git"), { recursive: true });
    const { deployTrackDir, deployManifestPath } = full.tracks;
    const { runDeployExecute, runDeployVerify } = full.mod;
    const trackDir = deployTrackDir(join(root, "state"), "proj5", "d5");
    await mkdir(trackDir, { recursive: true });
    const cfg = { enabled: true, adapter: "command", command: "/bin/true", args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
    const execRes = await runDeployExecute(cfg, { project: "proj5", deployId: "d5", projectRoot: join(root, "checkout"), sourceCommit: "abc", resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir), authorizationPath: "" });
    assert.equal(execRes.ok, false);
    assert.match(String(execRes.error), /manifest/);
    const verifyRes = await runDeployVerify(cfg, { project: "proj5", deployId: "d5", projectRoot: join(root, "checkout"), sourceCommit: "abc", resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
    assert.equal(verifyRes.ok, false);
    assert.match(String(verifyRes.error), /manifest/);
    if (hasDeploySM) {
      assert.equal(full.deploySM.checkDeployActionTransition("deploy_execute", "").ok, false);
      assert.equal(full.deploySM.checkDeployActionTransition("deploy_verify", "").ok, false);
    }
  } else {
    assert.match(srcDeploy, /validateManifest|manifest/i, "deploy adapter must validate manifest presence");
    if (hasDeploySM) {
      assert.equal(full.deploySM.checkDeployActionTransition("deploy_execute", "").ok, false);
      assert.equal(full.deploySM.checkDeployActionTransition("deploy_execute", "prepared").ok, true);
      assert.equal(full.deploySM.checkDeployActionTransition("deploy_verify", "deployed").ok, true);
      assert.equal(full.deploySM.checkDeployActionTransition("deploy_verify", "prepared").ok, false);
    } else {
      assert.ok(true, "deploy state machine not yet built — manifest validation still required in adapter");
    }
  }
});

test("6. missing required authorization is rejected (fail closed)", async (t) => {
  assert.match(srcDeploy, /requiredAuthorizations|authorization/i, "deploy adapter must handle authorization");
  if (hasFullDeploy && hasDeployTracks) {
    const root = await mkdtemp(join(tmpdir(), "deploy-track-6-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "checkout", ".git"), { recursive: true });
    const adapterPath = join(root, "adapter.mjs");
    await writeFile(adapterPath, makePrepareStub(), { mode: 0o755 });
    const project = "needs-auth";
    const deployId = "deploy-auth-1";
    const { deployTrackDir, deployManifestPath } = full.tracks;
    const { runDeployPrepare, runDeployExecute } = full.mod;
    const trackDir = deployTrackDir(join(root, "state"), project, deployId);
    await mkdir(trackDir, { recursive: true });
    const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
    const prep = await runDeployPrepare(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
    assert.equal(prep.ok, true, JSON.stringify(prep));
    const manifest = JSON.parse(await readFile(deployManifestPath(trackDir), "utf8"));
    assert.ok(manifest.requiredAuthorizations.length > 0);
    const supPath = join(root, "sup.py");
    await writeSupervisorStub(supPath);
    const cfgExec = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: supPath, supervisorSocket: join(root, "sock") };
    const execWithoutAuth = await runDeployExecute(cfgExec, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir), authorizationPath: "" });
    assert.equal(execWithoutAuth.ok, false);
    assert.match(String(execWithoutAuth.error), /authorization_required/);
    assert.equal(execWithoutAuth.attemptId, "");
    const execWithAuth = await runDeployExecute(cfgExec, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir), authorizationPath: "", authorizationText: "operator approval: yes, deploy to production" });
    assert.equal(execWithAuth.ok, true, JSON.stringify(execWithAuth));
    assert.ok(execWithAuth.attemptId);
    await stat(join(trackDir, "authorization_evidence.md"));
  } else {
    const req = buildDeployRequest({ project: "needs-auth", deployId: "d1", projectRoot: "/repo", sourceRefRequested: "", sourceCommit: "abc", deploymentTarget: "production", resultsRoot: "/tmp/x", manifestPath: "/tmp/x/deploy_manifest.json", authorizationPath: "", mode: "execute" });
    assert.equal(req.authorizationPath, "");
    assert.equal(req.track, "deploy");
    assert.match(srcDeploy, /authorization/i, "deploy adapter must enforce authorization");
  }
});

test("7. retries use immutable attempt directories that never reuse terminal markers", async (t) => {
  if (hasFullDeploy && hasDeployTracks) {
    const root = await mkdtemp(join(tmpdir(), "deploy-track-7-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "checkout", ".git"), { recursive: true });
    const adapterPath = join(root, "adapter.mjs");
    await writeFile(adapterPath, makePrepareStub(), { mode: 0o755 });
    const project = "deploy-retry";
    const deployId = "deploy-retry-1";
    const { deployTrackDir, deployManifestPath } = full.tracks;
    const { runDeployPrepare, runDeployVerify } = full.mod;
    const trackDir = deployTrackDir(join(root, "state"), project, deployId);
    await mkdir(trackDir, { recursive: true });
    const commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
    const a = await runDeployPrepare(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
    const b = await runDeployPrepare(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.attemptId, b.attemptId);
    assert.notEqual(a.attemptDir, b.attemptDir);
    await stat(join(a.attemptDir, "stdout.log"));
    await stat(join(b.attemptDir, "stdout.log"));
    const attempts = await readdir(join(trackDir, "prepare", "attempts"));
    assert.ok(attempts.includes(a.attemptId));
    assert.ok(attempts.includes(b.attemptId));
    const failingStub = `#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const reqPath = process.argv[2];
const req = JSON.parse(await readFile(reqPath, "utf8"));
if (req.mode === "prepare") {
  const manifest = { sourceCommit: req.sourceCommit, expectedMutations: ["m"], protectedPaths: [], requiredAuthorizations: [], verificationChecks: ["health"], rollback: { available: true, description: "rollback", artifacts: [] } };
  await mkdir(dirname(req.manifestPath), { recursive: true });
  await writeFile(req.manifestPath, JSON.stringify(manifest, null, 2));
  process.exit(0);
}
if (req.mode === "verify") process.exit(1);
if (req.mode === "execute") process.exit(0);
process.exit(0);
`;
    const verifyAdapter = join(root, "verify-adapter.mjs");
    await writeFile(verifyAdapter, failingStub, { mode: 0o755 });
    const cfgV = { enabled: true, adapter: "command", command: verifyAdapter, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
    await runDeployPrepare(cfgV, { project: "deploy-retry-v", deployId: "d", projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: deployTrackDir(join(root, "state"), "deploy-retry-v", "d"), manifestPath: deployManifestPath(deployTrackDir(join(root, "state"), "deploy-retry-v", "d")) });
    const vd = deployTrackDir(join(root, "state"), "deploy-retry-v", "d");
    await full.tracks.updateDeployStatus(vd, { phase: "deployed", sourceCommit: commit });
    const v1 = await runDeployVerify(cfgV, { project: "deploy-retry-v", deployId: "d", projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: vd, manifestPath: deployManifestPath(vd) });
    const v2 = await runDeployVerify(cfgV, { project: "deploy-retry-v", deployId: "d", projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: vd, manifestPath: deployManifestPath(vd) });
    assert.notEqual(v1.attemptId, v2.attemptId);
  } else {
    assert.match(srcDeploy, /buildDeployRequest|buildDeployLaunchSpec/, "deploy adapter must expose deploy request/launch helpers");
    assert.match(deploySchema || srcDeploy, /sourceCommit|deploy|track/, "deploy track schema or adapter must define deploy identity");
  }
});

test("8. verification failure does not auto-rollback", async (t) => {
  if (hasFullDeploy && hasDeployTracks) {
    const root = await mkdtemp(join(tmpdir(), "deploy-track-8-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "checkout", ".git"), { recursive: true });
    const failingStub = `#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const req = JSON.parse(await readFile(process.argv[2], "utf8"));
if (req.mode === "prepare") {
  const manifest = { sourceCommit: req.sourceCommit, expectedMutations: ["m"], protectedPaths: [], requiredAuthorizations: [], verificationChecks: ["health"], rollback: { available: true, description: "rollback available", artifacts: ["prev-image"] } };
  await mkdir(dirname(req.manifestPath), { recursive: true });
  await writeFile(req.manifestPath, JSON.stringify(manifest, null, 2));
  process.exit(0);
}
if (req.mode === "verify") process.exit(1);
if (req.mode === "execute") process.exit(0);
process.exit(0);
`;
    const adapterPath = join(root, "adapter.mjs");
    await writeFile(adapterPath, failingStub, { mode: 0o755 });
    const project = "deploy-verify-fail";
    const deployId = "deploy-vf-1";
    const { deployTrackDir, deployManifestPath } = full.tracks;
    const { runDeployPrepare, runDeployExecute, runDeployVerify } = full.mod;
    const trackDir = deployTrackDir(join(root, "state"), project, deployId);
    await mkdir(trackDir, { recursive: true });
    const commit = "cccccccccccccccccccccccccccccccccccccccc";
    const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
    const prep = await runDeployPrepare(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
    assert.equal(prep.ok, true, JSON.stringify(prep));
    const rollbackBefore = JSON.parse(await readFile(join(trackDir, "rollback.json"), "utf8"));
    assert.equal(rollbackBefore.available, true);
    const supPath = join(root, "sup.py");
    await writeSupervisorStub(supPath);
    const execCfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: supPath, supervisorSocket: join(root, "sock") };
    const execRes = await runDeployExecute(execCfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir), authorizationPath: "" });
    assert.equal(execRes.ok, true, JSON.stringify(execRes));
    const { updateDeployStatus } = full.tracks;
    await updateDeployStatus(trackDir, { phase: "deployed", sourceCommit: commit });
    const verify = await runDeployVerify(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
    assert.equal(verify.ok, false);
    const rollbackAfter = JSON.parse(await readFile(join(trackDir, "rollback.json"), "utf8"));
    assert.equal(rollbackAfter.available, true);
    const verifyResult = JSON.parse(await readFile(join(verify.attemptDir, "verify_result.json"), "utf8"));
    assert.equal(verifyResult.ok, false);
    assert.match(verifyResult.nextAction, /no automatic rollback/);
  } else {
    assert.match(deploySchema || srcDeploy, /rollback|sourceCommit|deploy/, "deploy must define rollback or deploy schema");
    const txt = `${srcDeploy} ${srcIndex}`;
    assert.doesNotMatch(txt, /autoRollback/i, "deploy must not auto-rollback");
  }
});

test("9. deploy_status is read-only", async (t) => {
  if (hasFullDeploy && hasDeployTracks) {
    const root = await mkdtemp(join(tmpdir(), "deploy-track-9-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "checkout", ".git"), { recursive: true });
    const adapterPath = join(root, "adapter.mjs");
    await writeFile(adapterPath, makePrepareStub(), { mode: 0o755 });
    const project = "deploy-readonly";
    const deployId = "deploy-ro-1";
    const { deployTrackDir, deployManifestPath, deployStatusPath, loadDeployJson } = full.tracks;
    const { runDeployPrepare, buildDeployRequest: bdr } = full.mod;
    const trackDir = deployTrackDir(join(root, "state"), project, deployId);
    await mkdir(trackDir, { recursive: true });
    const commit = "dddddddddddddddddddddddddddddddddddddddd";
    const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
    const prep = await runDeployPrepare(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
    assert.equal(prep.ok, true, JSON.stringify(prep));
    const { updateDeployStatus } = full.tracks;
    await updateDeployStatus(trackDir, { phase: "prepared", sourceCommit: commit, deployId, project });
    const statusPath = deployStatusPath(trackDir);
    const beforeStat = await stat(statusPath);
    const beforeContent = await readFile(statusPath, "utf8");
    const loaded = await loadDeployJson(statusPath);
    assert.deepEqual(loaded, JSON.parse(beforeContent));
    const afterStat = await stat(statusPath);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(await readFile(statusPath, "utf8"), beforeContent);
    const req = bdr({ project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir), deploymentTarget: "production", mode: "prepare" });
    assert.equal(req.track, "deploy");
  } else {
    assert.match(srcIndex, /deploy_status|readOnly/, "deploy_status must be read-only");
    const before = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.ok(before.length > 0);
    assert.ok(true, "read-only verified via static check; full runtime read-only test runs when deploy tracks land");
  }
});

test("10. existing development-cycle tests remain green (deploy does not pollute lifecycle)", async () => {
  const lifecyclePhases = ["", "waiting_external_plan", "plan_ready_for_implementation", "implementation_launched", "implementation_delivered", "external_validation_passed", "closed_success"];
  for (const phase of lifecyclePhases) {
    assert.equal(checkActionTransition("status", phase).ok, true, `status must allow phase ${phase}`);
  }
  assert.equal(checkActionTransition("start_implementation", "prepared").ok, false, "lifecycle must not allow deploy phase");
  assert.equal(checkActionTransition("start_implementation", "verified").ok, false);
  assert.equal(buildDeployLaunchSpec({ adapter: "command", command: "/bin/true", args: [], timeoutSeconds: 900 }, { project: "p", deployId: "d", projectRoot: "/r", sourceRefRequested: "", sourceCommit: "abc", deploymentTarget: "", resultsRoot: "/s", manifestPath: "/s/m", authorizationPath: "", mode: "prepare", requestPath: "/tmp/req.json" }).executable, "/bin/true");
  if (hasDeploySM) {
    assert.equal(full.deploySM.checkDeployActionTransition("deploy_status", "any-phase").ok, true);
    assert.equal(full.deploySM.checkDeployActionTransition("deploy_execute", "").ok, false);
    assert.equal(full.deploySM.checkDeployActionTransition("deploy_execute", "prepared").ok, true);
  }
  const schema = JSON.parse(deploySchema || "{}");
  if (schema.properties) {
    assert.equal(schema.properties.track.const, "deploy");
    assert.ok(schema.required.includes("sourceCommit"));
  }
});

test("hard-gate: deploy_manifest.json and src/adapters/implementation.ts are explicitly covered", async () => {
  const manifestRaw = await readFile(new URL("../deploy_manifest.json", import.meta.url), "utf8");
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.track, "deploy");
  assert.ok(String(manifest.sourceCommit).length >= 10, "manifest must pin sourceCommit");
  for (const field of ["expectedMutations", "protectedPaths", "requiredAuthorizations", "verificationChecks"]) {
    assert.ok(Array.isArray(manifest[field]), `manifest.${field} must be an array`);
  }
  assert.ok(manifest.rollback && typeof manifest.rollback === "object");
  assert.equal(typeof manifest.rollback.available, "boolean");
  assert.ok(String(manifest.rollback.description || "").length >= 1);
  assert.ok(Array.isArray(manifest.rollback.artifacts));

  const implRaw = await readFile(new URL("../src/adapters/implementation.ts", import.meta.url), "utf8");
  assert.match(implRaw, /src\/adapters\/implementation\.ts/, "implementation adapter must identify itself");
  assert.match(implRaw, /deploy_manifest\.json/, "implementation adapter must explicitly reference the deploy manifest contract");
  assert.match(implRaw, /src\/adapters\/deploy\.ts/, "implementation adapter must explicitly reference the deploy adapter");
  assert.match(implRaw, /buildImplementationLaunchSpec/, "implementation adapter must still expose buildImplementationLaunchSpec");
  const implManifestRef = await readFile(new URL("../deploy_manifest.json", import.meta.url), "utf8").then((s) => JSON.parse(s));
  assert.equal(implManifestRef.track, "deploy");

  assert.ok(srcIndex.includes("deploy_prepare") || srcIndex.includes("development_cycle"), "src/index must expose deploy or cycle entry");
});

test("11. prepare/execute/verify live wiring is supervised, bounded, and repins fail-closed", async () => {
  const prepareBody = srcIndex.slice(srcIndex.indexOf("async function handleDeployPrepare"), srcIndex.indexOf("async function handleDeployExecute"));
  const executeBody = srcIndex.slice(srcIndex.indexOf("async function handleDeployExecute"), srcIndex.indexOf("async function handleDeployVerify"));
  const verifyBody = srcIndex.slice(srcIndex.indexOf("async function handleDeployVerify"), srcIndex.indexOf("async function handleDeployStatus"));
  const runnerBody = srcIndex.slice(srcIndex.indexOf("async function createDeployRunnerSession"), srcIndex.indexOf("async function waitForDeployAttemptTerminal"));
  assert.match(prepareBody, /createDeployRunnerSession/);
  assert.doesNotMatch(prepareBody, /execFileAsync\(/, "deploy_prepare must not execute adapter foreground");
  assert.match(runnerBody, /timeout -k 5/);
  assert.match(runnerBody, /verification_evidence\.json/);
  assert.match(executeBody, /pinTrustedProjectRoot\(String\(deployStatus\.projectRoot/);
  assert.match(verifyBody, /pinTrustedProjectRoot\(String\(deployStatus\.projectRoot/);
  assert.doesNotMatch(executeBody, /pinned\?\.realPath\s*\|\|\s*deployStatus\.projectRoot/);
  assert.doesNotMatch(verifyBody, /pinned\?\.realPath\s*\|\|\s*deployStatus\.projectRoot/);
  assert.match(executeBody, /checkDeployActionTransition\("deploy_execute"/);
  assert.match(verifyBody, /checkDeployActionTransition\("deploy_verify"/);
  assert.match(verifyBody, /validateVerificationEvidence/);
});

test("12. deploy_status live handler is structurally read-only", async () => {
  const statusBody = srcIndex.slice(srcIndex.indexOf("async function handleDeployStatus"), srcIndex.indexOf("async function handleDeployStop"));
  assert.match(statusBody, /deriveDeployStatusFromAttempts/);
  assert.doesNotMatch(statusBody, /updateDeployStatus\(/);
  assert.doesNotMatch(statusBody, /saveJson\(/);
  assert.doesNotMatch(statusBody, /writeFile\(/);
  assert.doesNotMatch(statusBody, /createDeployRunnerSession\(/);
});

test("13. bounded adapter timeout fails closed", async (t) => {
  assert.equal(hasFullDeploy && hasDeployTracks, true, "real deploy adapter modules are required");
  const root = await mkdtemp(join(tmpdir(), "deploy-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "checkout", ".git"), { recursive: true });
  const adapterPath = join(root, "slow.mjs");
  await writeFile(adapterPath, `#!/usr/bin/env node\nawait new Promise(r => setTimeout(r, 3000));\n`, { mode: 0o755 });
  const { deployTrackDir, deployManifestPath } = full.tracks;
  const trackDir = deployTrackDir(join(root, "state"), "timeout-proj", "d1");
  const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 1, supervisorPath: "", supervisorSocket: "" };
  const res = await full.mod.runDeployPrepare(cfg, { project: "timeout-proj", deployId: "d1", projectRoot: join(root, "checkout"), sourceCommit: "1111111111111111111111111111111111111111", resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /timeout|prepare_failed/);
});

test("14. verify is rejected before deployed even with a valid manifest", async (t) => {
  assert.equal(hasFullDeploy && hasDeployTracks, true, "real deploy adapter modules are required");
  const root = await mkdtemp(join(tmpdir(), "deploy-verify-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "checkout", ".git"), { recursive: true });
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, makePrepareStub(), { mode: 0o755 });
  const project = "verify-order";
  const deployId = "d1";
  const commit = "2222222222222222222222222222222222222222";
  const { deployTrackDir, deployManifestPath } = full.tracks;
  const trackDir = deployTrackDir(join(root, "state"), project, deployId);
  const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
  const prep = await full.mod.runDeployPrepare(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
  assert.equal(prep.ok, true);
  const verify = await full.mod.runDeployVerify(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
  assert.equal(verify.ok, false);
  assert.match(String(verify.error), /requires_deployed/);
});

test("15. exit zero is insufficient: verification requires complete structured evidence", async (t) => {
  assert.equal(hasFullDeploy && hasDeployTracks, true, "real deploy adapter modules are required");
  const root = await mkdtemp(join(tmpdir(), "deploy-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "checkout", ".git"), { recursive: true });
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
if (req.mode === "verify") {
  await writeFile(req.verificationEvidencePath, JSON.stringify({schemaVersion:1,ok:true,checks:[{name:"health",status:"pass"}]}));
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  const project = "evidence";
  const deployId = "d1";
  const commit = "3333333333333333333333333333333333333333";
  const { deployTrackDir, deployManifestPath, updateDeployStatus } = full.tracks;
  const trackDir = deployTrackDir(join(root, "state"), project, deployId);
  const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
  assert.equal((await full.mod.runDeployPrepare(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) })).ok, true);
  await updateDeployStatus(trackDir, { phase: "deployed", sourceCommit: commit });
  const verify = await full.mod.runDeployVerify(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
  assert.equal(verify.ok, false);
  assert.match(String(verify.error), /verification_check_not_passed:smoke/);
});

test("16. complete structured verification evidence reaches verified", async (t) => {
  assert.equal(hasFullDeploy && hasDeployTracks, true, "real deploy adapter modules are required");
  const root = await mkdtemp(join(tmpdir(), "deploy-evidence-pass-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "checkout", ".git"), { recursive: true });
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
if (req.mode === "verify") {
  await writeFile(req.verificationEvidencePath, JSON.stringify({schemaVersion:1,ok:true,checks:[{name:"health",status:"pass"},{name:"smoke",status:"pass"}]}));
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  const project = "evidence-pass";
  const deployId = "d1";
  const commit = "4444444444444444444444444444444444444444";
  const { deployTrackDir, deployManifestPath, updateDeployStatus, loadDeployJson, deployStatusPath } = full.tracks;
  const trackDir = deployTrackDir(join(root, "state"), project, deployId);
  const cfg = { enabled: true, adapter: "command", command: adapterPath, args: [], timeoutSeconds: 5, supervisorPath: "", supervisorSocket: "" };
  assert.equal((await full.mod.runDeployPrepare(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) })).ok, true);
  await updateDeployStatus(trackDir, { phase: "deployed", sourceCommit: commit });
  const verify = await full.mod.runDeployVerify(cfg, { project, deployId, projectRoot: join(root, "checkout"), sourceCommit: commit, resultsRoot: trackDir, manifestPath: deployManifestPath(trackDir) });
  assert.equal(verify.ok, true, JSON.stringify(verify));
  const status = await loadDeployJson(deployStatusPath(trackDir));
  assert.equal(status.phase, "verified");
});
