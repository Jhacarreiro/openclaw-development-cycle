import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../runner-supervisor.py", import.meta.url));
async function until(check) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("supervisor test timed out");
}

test("supervisor callbacks survive group cleanup and concurrent runner exits", { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-callback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, "supervisor.sock");
  const supervisor = spawn("python3", [script, "--socket", socket, "serve"], { stdio: "ignore" });
  t.after(async () => {
    if (supervisor.exitCode === null) { const exited = new Promise(resolve => supervisor.once("exit", resolve)); supervisor.kill("SIGTERM"); await exited; }
  });
  await until(async () => { try { await access(socket); return true; } catch { return false; } });
  const received = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    received.push({ body: JSON.parse(text), token: req.headers.authorization });
    res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const runner = join(root, "runner.sh");
  await writeFile(runner, "#!/bin/sh\nsh -c 'trap \"\" TERM; sleep 60' &\nsleep 0.5\nexit 0\n");
  const identities = [];
  for (const runId of ["one", "two"]) {
    const result = await exec("python3", [script, "--socket", socket, "launch", runner, root], { env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: "fixture-token", DEVELOPMENT_CYCLE_GATEWAY_URL: `http://127.0.0.1:${server.address().port}`, DEVELOPMENT_CYCLE_RECONCILE_PROJECT: "fixture", DEVELOPMENT_CYCLE_RECONCILE_RUN_ID: runId }, timeout: 5000 });
    identities.push(JSON.parse(result.stdout).pid);
  }
  await until(async () => received.length === 2);
  assert.deepEqual(received.map(v => v.body.args.runId).sort(), ["one", "two"]);
  for (const request of received) {
    assert.equal(request.body.action, "reconcile");
    assert.equal(request.body.tool, "development_cycle");
    assert.equal(request.token, "Bearer fixture-token");
  }
  for (const pid of identities) await assert.rejects(readFile(`/proc/${pid}/stat`), error => error.code === "ENOENT");
  // A client that never finishes its request must not freeze the supervisor.
  const partial = createConnection(socket);
  partial.on("error", () => {});
  await new Promise(resolve => partial.once("connect", resolve));
  partial.write('{"action":');
  const ping = await exec("python3", [script, "--socket", socket, "ping"], { timeout: 5000 });
  assert.equal(JSON.parse(ping.stdout).ok, true);
  partial.destroy();
});
