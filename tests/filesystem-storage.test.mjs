import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLock, createFilesystemStore } from "../dist/storage/filesystem.js";

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

function runStatusWorker({ storeHref, root, dir, key, n }) {
  const source = `
    import { createFilesystemStore } from ${JSON.stringify(storeHref)};
    const store = createFilesystemStore(${JSON.stringify(root)});
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

test("filesystem storage uses safe run paths and atomic status updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixedNow = new Date("2026-07-16T10:00:00.000Z");
  const store = createFilesystemStore(root, () => fixedNow);
  const runDir = store.runDir("Project / One", "Run #1");
  assert.equal(runDir, join(root, "runs", "Project-One", "Run-1"));

  const status = await store.updateStatus(runDir, { phase: "planned" });
  assert.equal(status.updatedAt, fixedNow.toISOString());
  assert.deepEqual(JSON.parse(await readFile(join(runDir, "status.json"), "utf8")), status);
  assert.deepEqual((await readdir(runDir)).filter((name) => name.includes(".tmp-")), []);
});

test("updateStatus serializes two processes onto one status file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemStore(root, () => new Date("2026-07-16T10:00:00.000Z"));
  const runDir = store.runDir("Lock", "Two-Process");
  await mkdir(runDir, { recursive: true });
  const storeHref = new URL("../dist/storage/filesystem.js", import.meta.url).href;
  const [outA, outB] = await Promise.all([
    runStatusWorker({ storeHref, root, dir: runDir, key: "a", n: 60 }),
    runStatusWorker({ storeHref, root, dir: runDir, key: "b", n: 60 }),
  ]);
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
  await utimes(lockDir, past, past);

  const status = await store.updateStatus(runDir, { phase: "recovered" });
  assert.equal(status.phase, "recovered");
  await assert.rejects(() => stat(lockDir), { code: "ENOENT" });
});

test("a live holder is not evicted when the lock mtime is stale", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDir = join(root, ".status.lock");
  const held = await acquireLock(lockDir, 80);
  t.after(() => held.release());
  const past = new Date(Date.now() - 10_000);
  await utimes(lockDir, past, past);
  await assert.rejects(() => acquireLock(lockDir, 80), /timed out acquiring status lock/);
  assert.equal(await held.isHeld(), true);
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
