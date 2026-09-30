import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SUPERVISOR_PATH = fileURLToPath(new URL("../runner-supervisor.py", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(path, timeoutMs = 5000) {
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
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (chunk) => { chunks.push(chunk); if (Buffer.concat(chunks).includes(0x0a)) sock.end(); });
    sock.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8").split("\n", 1)[0])));
    sock.on("error", reject);
  });
}

test("supervisor materializes terminal state when runner exits without finalizer markers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "development-cycle-supervisor-terminal-"));
  const socketPath = join(dir, "supervisor.sock");
  const runnerPath = join(dir, "runner.sh");
  await writeFile(join(dir, "status.json"), JSON.stringify({ status: "running", launchState: "running" }) + "\n");
  await writeFile(runnerPath, "#!/bin/sh\nexit 7\n");
  await chmod(runnerPath, 0o755);
  const supervisor = spawn("python3", [SUPERVISOR_PATH, "--socket", socketPath, "serve"], { stdio: "ignore" });
  t.after(async () => { if (supervisor.exitCode === null) supervisor.kill("SIGKILL"); await rm(dir, { recursive: true, force: true }); });
  await waitFor(socketPath);
  const launch = await request(socketPath, { action: "launch", runnerPath, cwd: dir });
  assert.equal(launch.ok, true);
  await waitFor(join(dir, "exit-code.txt"));
  assert.equal((await readFile(join(dir, "exit-code.txt"), "utf8")).trim(), "7");
  await waitFor(join(dir, "exited-at.txt"));
  const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert.equal(status.status, "failed");
  assert.equal(status.launchState, "exited");
  assert.equal(status.exitCode, 7);
  assert.match(status.message, /materialized by supervisor/);
});
