import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SUPERVISOR_PATH = fileURLToPath(new URL("../runner-supervisor.py", import.meta.url));
const linux = { skip: process.platform !== "linux", timeout: 15_000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(path, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { await sleep(25); }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    const chunks = [];
    sock.setTimeout(5000);
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (chunk) => { chunks.push(chunk); if (Buffer.concat(chunks).includes(0x0a)) sock.end(); });
    sock.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8").split("\n", 1)[0])); }
      catch (error) { reject(error); }
    });
    sock.on("error", reject);
    sock.on("timeout", () => { sock.destroy(); reject(new Error("supervisor request timed out")); });
  });
}

async function startSupervisor(t) {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-supervisor-terminal-"));
  const socketPath = join(root, "supervisor.sock");
  const supervisor = spawn("python3", [SUPERVISOR_PATH, "--socket", socketPath, "serve"], { stdio: "ignore" });
  t.after(async () => {
    if (supervisor.exitCode === null) {
      const exited = new Promise((resolve) => supervisor.once("exit", resolve));
      supervisor.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(socketPath);
  return { root, socketPath, supervisor };
}

async function launchSession(ctx, id, source, initialStatus = {}) {
  const dir = join(ctx.root, id);
  await mkdir(dir);
  const runnerPath = join(dir, "runner.sh");
  await writeFile(join(dir, "status.json"), JSON.stringify({
    status: "running", launchState: "running", attemptId: id, ...initialStatus,
  }) + "\n");
  await writeFile(runnerPath, "#!/bin/sh\n" + source);
  const launched = await request(ctx.socketPath, { action: "launch", runnerPath, cwd: dir });
  assert.equal(launched.ok, true);
  return { dir, launched };
}

async function terminalStatus(dir, exitCode) {
  await waitFor(join(dir, "exit-code.txt"));
  assert.equal((await readFile(join(dir, "exit-code.txt"), "utf8")).trim(), String(exitCode));
  const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert.equal(status.status, exitCode === 0 ? "completed" : "failed");
  assert.equal(status.launchState, "exited");
  assert.equal(status.exitCode, exitCode);
  assert.equal((await readFile(join(dir, "exited-at.txt"), "utf8")).trim(), status.exitedAt);
  return status;
}

for (const exitCode of [0, 7]) {
  test(`supervisor materializes exit ${exitCode} without finalizer markers`, linux, async (t) => {
    const ctx = await startSupervisor(t);
    const { dir } = await launchSession(ctx, "plain", `exit ${exitCode}\n`);
    const status = await terminalStatus(dir, exitCode);
    assert.equal(status.attemptId, "plain");
    assert.match(status.message, /materialized by supervisor/);
  });
}

test("supervisor preserves the primary finalizer markers and state", linux, async (t) => {
  const ctx = await startSupervisor(t);
  const { dir } = await launchSession(ctx, "primary", "printf '0\\n' > exit-code.txt\nprintf 'primary time\\n' > exited-at.txt\nexit 7\n", {
    status: "completed", launchState: "exited", exitCode: 0, exitedAt: "primary time", message: "primary finalizer",
  });
  await waitFor(join(dir, "exit-code.txt"));
  await sleep(500);
  const status = await terminalStatus(dir, 0);
  assert.equal(status.message, "primary finalizer");
});

test("supervisor retains terminal state for concurrent exits during group cleanup", linux, async (t) => {
  const ctx = await startSupervisor(t);
  const first = await launchSession(ctx, "first", "sh -c 'trap \"\" TERM; sleep 60' &\nprintf 'ready\\n' > ready\nwhile [ ! -e ../release ]; do sleep 0.05; done\nexit 3\n");
  const second = await launchSession(ctx, "second", "printf 'ready\\n' > ready\nwhile [ ! -e ../release ]; do sleep 0.05; done\nsleep 0.5\nexit 7\n");
  await Promise.all([waitFor(join(first.dir, "ready")), waitFor(join(second.dir, "ready"))]);
  await writeFile(join(ctx.root, "release"), "release\n");
  await terminalStatus(first.dir, 3);
  const status = await terminalStatus(second.dir, 7);
  assert.equal(status.attemptId, "second");
  assert.equal((await request(ctx.socketPath, { action: "ping" })).ok, true);
});

test("supervisor persists signal termination without a shell finalizer", linux, async (t) => {
  const ctx = await startSupervisor(t);
  const { dir, launched } = await launchSession(ctx, "killed", "printf 'ready\\n' > ready\nexec sleep 60\n");
  await waitFor(join(dir, "ready"));
  process.kill(launched.pid, "SIGKILL");
  await terminalStatus(dir, -9);
});

test("supervisor persists tracked terminal state before shutdown", linux, async (t) => {
  const ctx = await startSupervisor(t);
  const { dir } = await launchSession(ctx, "shutdown", "printf 'ready\\n' > ready\nexec sleep 60\n");
  await waitFor(join(dir, "ready"));
  const exited = new Promise((resolve) => ctx.supervisor.once("exit", resolve));
  ctx.supervisor.kill("SIGTERM");
  await exited;
  await terminalStatus(dir, -15);
});

test("supervisor atomic writes do not follow precreated temporary symlinks", linux, async (t) => {
  const ctx = await startSupervisor(t);
  const { dir } = await launchSession(ctx, "symlink", "printf 'ready\\n' > ready\nwhile [ ! -e release ]; do sleep 0.05; done\nexit 7\n");
  await waitFor(join(dir, "ready"));
  const victim = join(ctx.root, "outside-state.txt");
  await writeFile(victim, "preserve this file\n");
  for (const name of ["status.json", "exited-at.txt", "exit-code.txt"]) {
    await symlink(victim, join(dir, `${name}.tmp.${ctx.supervisor.pid}`));
  }
  await writeFile(join(dir, "release"), "release\n");
  await terminalStatus(dir, 7);
  assert.equal(await readFile(victim, "utf8"), "preserve this file\n");
});

test("supervisor recovers a malformed status shape when materializing terminal state", linux, async (t) => {
  const ctx = await startSupervisor(t);
  const { dir } = await launchSession(ctx, "invalid-status", "printf '[]\\n' > status.json\nexit 7\n");
  await terminalStatus(dir, 7);
});
