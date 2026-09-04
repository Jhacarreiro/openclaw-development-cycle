import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { acquireLock, createFilesystemStore } from "../dist/storage/filesystem.js";
import { cleanId } from "../dist/core/ids.js";

function unusedPid() {
  for (let pid = 100000; pid < 200000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find an unused pid");
}

function runStatusWorker({ storeHref, root, dir, key, n, readyPath, gatePath }) {
  const source = `
    import { access, writeFile } from "node:fs/promises";
    import { setTimeout as sleep } from "node:timers/promises";
    import { createFilesystemStore } from ${JSON.stringify(storeHref)};
    const store = createFilesystemStore(${JSON.stringify(root)});
    await writeFile(${JSON.stringify(readyPath)}, "ready");
    process.stdout.write(JSON.stringify({ event: "ready", pid: process.pid, key: ${JSON.stringify(key)} }) + "\\n");
    for (;;) {
      try { await access(${JSON.stringify(gatePath)}); break; } catch {}
      await sleep(5);
    }
    process.stdout.write(JSON.stringify({ event: "start", pid: process.pid, key: ${JSON.stringify(key)} }) + "\\n");
    for (let i = 0; i < ${Number(n)}; i++) {
      await store.updateStatus(${JSON.stringify(dir)}, { [${JSON.stringify(key)}]: i + 1 });
    }
    process.stdout.write(JSON.stringify({ event: "done", pid: process.pid, key: ${JSON.stringify(key)}, n: ${Number(n)} }) + "\\n");
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`worker ${key} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function waitForPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("filesystem storage uses safe run paths and atomic status updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixedNow = new Date("2026-07-16T10:00:00.000Z");
  const store = createFilesystemStore(root, () => fixedNow);
  const runDir = store.runDir("Project / One", "Run #1");
  assert.equal(runDir, join(root, "runs", cleanId("Project / One"), cleanId("Run #1")));

  const status = await store.updateStatus(runDir, { phase: "planned" });
  assert.equal(status.updatedAt, fixedNow.toISOString());
  assert.deepEqual(JSON.parse(await readFile(join(runDir, "status.json"), "utf8")), status);
  assert.deepEqual((await readdir(runDir)).filter((name) => name.includes(".tmp-")), []);
});


test("fresh install writes the canonical sanitized run path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemStore(root, () => new Date("2026-07-16T10:00:00.000Z"));
  const runDir = store.runDir("Project / One", "Run #1");
  await store.updateStatus(runDir, { phase: "planned" });
  const names = await readdir(join(root, "runs"));
  assert.deepEqual(names, [cleanId("Project / One")]);
  assert.equal(store.runDir("Project / One", "Run #1"), runDir);
});

test("upgrade resolves legacy sanitized run paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemStore(root, () => new Date("2026-07-16T10:00:00.000Z"));
  const legacy = join(root, "runs", "Project-One", "Run-1");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "status.json"), `${JSON.stringify({ phase: "planned", runId: "Run-1" }, null, 2)}\n`);
  assert.equal(store.runDir("Project / One", "Run #1"), legacy);
  const status = await store.loadJson(join(store.runDir("Project / One", "Run #1"), "status.json"));
  assert.equal(status.phase, "planned");
});

test("updateStatus serializes two processes onto one status file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemStore(root, () => new Date("2026-07-16T10:00:00.000Z"));
  const runDir = store.runDir("Lock", "Two-Process");
  await mkdir(runDir, { recursive: true });
  const storeHref = new URL("../dist/storage/filesystem.js", import.meta.url).href;
  const readyA = join(root, "ready-a");
  const readyB = join(root, "ready-b");
  const gatePath = join(root, "release-workers");
  const workerA = runStatusWorker({ storeHref, root, dir: runDir, key: "a", n: 60, readyPath: readyA, gatePath });
  const workerB = runStatusWorker({ storeHref, root, dir: runDir, key: "b", n: 60, readyPath: readyB, gatePath });
  await Promise.all([waitForPath(readyA), waitForPath(readyB)]);
  await writeFile(gatePath, "go");
  const [outA, outB] = await Promise.all([workerA, workerB]);
  assert.match(outA, /"event":"ready"/);
  assert.match(outB, /"event":"ready"/);
  assert.match(outA, /"event":"start"/);
  assert.match(outB, /"event":"start"/);
  assert.match(outA, /"event":"done"/);
  assert.match(outB, /"event":"done"/);
  const status = JSON.parse(await readFile(join(runDir, "status.json"), "utf8"));
  assert.equal(status.a, 60);
  assert.equal(status.b, 60);
});

test("updateStatus recovers a stale lock left by a dead holder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemStore(root, () => new Date("2026-07-16T10:00:00.000Z"));
  const runDir = store.runDir("Lock", "Crash");
  await mkdir(runDir, { recursive: true });
  const lockDir = join(runDir, ".status.lock");
  await mkdir(lockDir);
  await writeFile(join(lockDir, "owner"), `${unusedPid()}:deadtoken`);
  const past = new Date(Date.now() - 10_000);
  await utimes(join(lockDir, "owner"), past, past);
  await utimes(lockDir, past, past);

  const status = await store.updateStatus(runDir, { phase: "recovered" });
  assert.equal(status.phase, "recovered");
  await assert.rejects(() => stat(lockDir), { code: "ENOENT" });
});

test("stale recovery claim abandoned before owner publication is recoverable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-abandoned-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDir = join(root, ".status.lock");
  await mkdir(lockDir);
  await writeFile(join(lockDir, "owner"), `${unusedPid()}:deadtoken`);
  const recoveryDir = join(lockDir, ".recovery");
  await mkdir(recoveryDir);
  const past = new Date(Date.now() - 10_000);
  await utimes(recoveryDir, past, past);
  await utimes(join(lockDir, "owner"), past, past);
  await utimes(lockDir, past, past);

  const held = await acquireLock(lockDir, 300);
  t.after(() => held.release());
  assert.equal(await held.isHeld(), true);
  assert.match(await readFile(join(lockDir, "owner"), "utf8"), new RegExp(`^${process.pid}:`));
});

test("a live holder is not evicted when the lock mtime is stale", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDir = join(root, ".status.lock");
  const held = await acquireLock(lockDir, 80);
  t.after(() => held.release());
  const past = new Date(Date.now() - 10_000);
  await utimes(join(lockDir, "owner"), past, past);
  await utimes(lockDir, past, past);
  await assert.rejects(() => acquireLock(lockDir, 80), /timed out acquiring status lock/);
  assert.equal(await held.isHeld(), true);
});

test("persistent lock setup errors respect the acquisition timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-lock-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parentFile = join(root, "not-a-directory");
  await writeFile(parentFile, "file");
  const lockDir = join(parentFile, ".status.lock");
  const started = Date.now();
  await assert.rejects(() => acquireLock(lockDir, 80), /timed out acquiring status lock/);
  assert.ok(Date.now() - started < 1000);
});

test("stale-lock rename failure remains bounded and later acquire recovers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-stale-rename-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDir = join(root, ".status.lock");
  await mkdir(lockDir);
  await writeFile(join(lockDir, "owner"), String(unusedPid()) + ":deadtoken");
  const past = new Date(Date.now() - 10_000);
  await utimes(join(lockDir, "owner"), past, past);
  await utimes(lockDir, past, past);
  const failRename = async () => { const error = new Error("injected rename failure"); error.code = "EACCES"; throw error; };

  const started = Date.now();
  await assert.rejects(() => acquireLock(lockDir, 80, failRename), /timed out acquiring status lock/);
  assert.ok(Date.now() - started < 1000);

  await new Promise((resolve) => setTimeout(resolve, 90));
  const recovered = await acquireLock(lockDir, 300);
  t.after(() => recovered.release());
  assert.equal(await recovered.isHeld(), true);
});

test("stale ownerless lock from interrupted legacy publication is recoverable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-ownerless-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDir = join(root, ".status.lock");
  await mkdir(lockDir);
  const past = new Date(Date.now() - 10_000);
  await utimes(lockDir, past, past);
  const recovered = await acquireLock(lockDir, 300);
  t.after(() => recovered.release());
  assert.equal(await recovered.isHeld(), true);
});

test("crash before owner publication leaves only a nonblocking candidate directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-owner-publication-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDir = join(root, ".status.lock");
  await mkdir(`${lockDir}.acquire-dead-publisher`);

  const held = await acquireLock(lockDir, 80);
  t.after(() => held.release());
  assert.equal(await held.isHeld(), true);
});

test("concurrent release calls cannot remove a replacement lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-release-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDir = join(root, ".status.lock");
  let signalMoved;
  let releaseCleanup;
  const moved = new Promise((resolve) => { signalMoved = resolve; });
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  const gatedRename = async (src, dst) => {
    await rename(src, dst);
    if (src === lockDir && dst.includes(".release-")) {
      signalMoved();
      await cleanupGate;
    }
  };

  const held = await acquireLock(lockDir, 80, gatedRename);
  const releaseA = held.release();
  const releaseB = held.release();
  await moved;

  const replacement = await acquireLock(lockDir, 80);
  t.after(() => replacement.release());
  assert.equal(await replacement.isHeld(), true);

  releaseCleanup();
  await Promise.all([releaseA, releaseB]);
  assert.equal(await replacement.isHeld(), true);
  assert.match(await readFile(join(lockDir, "owner"), "utf8"), new RegExp(`^${process.pid}:`));
});

test("delayed release does not remove a replacement lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-fence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDir = join(root, ".status.lock");
  const delayed = await acquireLock(lockDir, 80);
  await rm(lockDir, { recursive: true, force: true });
  const replacement = await acquireLock(lockDir, 80);
  t.after(() => replacement.release());
  assert.equal(await delayed.isHeld(), false);
  await delayed.release();
  assert.equal(await replacement.isHeld(), true);
  assert.match(await readFile(join(lockDir, "owner"), "utf8"), new RegExp(`^${process.pid}:`));
});

test("distinct raw run ids cannot claim a reserved canonical directory through legacy normalization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-marker-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemStore(root);

  const canonicalRun = cleanId("Run #1");
  const canonicalDir = store.runDir("Project", "Run #1");
  await mkdir(canonicalDir, { recursive: true });
  await writeFile(join(canonicalDir, "status.json"), `${JSON.stringify({ phase: "planned", runId: canonicalRun }, null, 2)}
`);

  assert.equal(store.runDir("Project", canonicalRun), canonicalDir);

  const distinctRaw = canonicalRun + " ";
  const distinctDir = store.runDir("Project", distinctRaw);
  assert.notEqual(distinctDir, canonicalDir);
  assert.equal(distinctDir, join(root, "runs", "Project", cleanId(distinctRaw)));
});

test("reused canonical project IDs stay in the same physical project directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-canonical-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemStore(root);

  const canonicalProject = cleanId("Project / One");
  const first = store.runDir("Project / One", "Run-1");
  await mkdir(first, { recursive: true });
  await writeFile(join(first, "status.json"), `${JSON.stringify({ phase: "planned", project: canonicalProject, runId: "Run-1" }, null, 2)}
`);

  const second = store.runDir(canonicalProject, "Run-2");
  assert.equal(second, join(root, "runs", canonicalProject, "Run-2"));
});

test("traversal-shaped digest suffixes cannot escape the storage root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-canonical-traversal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemStore(root);
  const digest = "b".repeat(64);
  const rawProject = `../outside-id-${digest}`;
  const rawRun = `..\\run-id-${digest}`;

  const dir = store.runDir(rawProject, rawRun);
  const expectedRoot = join(root, "runs");
  assert.equal(dir.startsWith(expectedRoot + sep), true, dir);
  assert.equal(dir.includes(".." + sep), false, dir);
});
