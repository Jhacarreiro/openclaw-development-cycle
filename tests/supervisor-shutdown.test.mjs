import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SUPERVISOR_PATH = fileURLToPath(new URL("../runner-supervisor.py", import.meta.url));
const SUPERVISOR_SOURCE = await readFile(new URL("../runner-supervisor.py", import.meta.url), "utf8");
const SOCKET_WAIT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 5_000;
const SHUTDOWN_WAIT_MS = 12_000;
const PID_WAIT_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForSocket(socketPath, timeoutMs, onTimeout) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      return;
    } catch {
      await sleep(25);
    }
  }
  throw new Error(onTimeout());
}

async function waitForPidFile(path, timeoutMs = PID_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return pid;
    } catch {
      // marker has not been written yet
    }
    await sleep(25);
  }
  throw new Error(`runner pid file did not appear: ${path}`);
}

function readJsonLine(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    const chunks = [];
    const fail = (error) => {
      sock.destroy();
      reject(error);
    };
    sock.setTimeout(SOCKET_TIMEOUT_MS);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(0x0a)) {
        sock.end();
      }
    });
    sock.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const line = raw.split("\n", 1)[0];
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`invalid supervisor response: ${JSON.stringify(raw)}`, { cause: error }));
      }
    });
    sock.on("error", fail);
    sock.on("timeout", () => fail(new Error("timed out waiting for supervisor response")));
  });
}

async function startSupervisor(t) {
  const dir = await mkdtemp(join(tmpdir(), "development-cycle-supervisor-shutdown-"));
  const socketPath = join(dir, "supervisor.sock");
  const child = spawn("python3", [SUPERVISOR_PATH, "--socket", socketPath, "serve"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let supervisorLog = "";
  child.stdout.on("data", (chunk) => {
    supervisorLog += chunk;
  });
  child.stderr.on("data", (chunk) => {
    supervisorLog += chunk;
  });

  const trackedPids = new Set();
  let stopping = false;
  let unexpectedExit;
  child.on("exit", (code, signal) => {
    if (!stopping) {
      unexpectedExit = { code, signal };
    }
  });
  child.on("error", (error) => {
    supervisorLog += String(error);
  });

  t.after(() => {
    stopping = true;
    for (const pid of trackedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    return rm(dir, { recursive: true, force: true });
  });

  await waitForSocket(
    socketPath,
    SOCKET_WAIT_MS,
    () => `supervisor socket did not appear within ${SOCKET_WAIT_MS}ms; log: ${supervisorLog}`,
  );

  return { dir, socketPath, child, trackedPids, get unexpectedExit() { return unexpectedExit; }, get supervisorLog() { return supervisorLog; }, markStopping() { stopping = true; } };
}

async function launchSleepGroup(ctx) {
  const leaderPath = join(ctx.dir, "leader.pid");
  const childPath = join(ctx.dir, "child.pid");
  const runnerPath = join(ctx.dir, "runner.sh");
  await writeFile(
    runnerPath,
    [
      "#!/bin/sh",
      "sleep 120 &",
      `echo $! > "${childPath}"`,
      `echo $$ > "${leaderPath}"`,
      "wait",
      "",
    ].join("\n"),
  );

  const launched = await readJsonLine(
    ctx.socketPath,
    `${JSON.stringify({ action: "launch", runnerPath, cwd: ctx.dir })}\n`,
  );
  assert.equal(launched.ok, true, `launch failed: ${JSON.stringify(launched)}`);
  assert.ok(launched.pid > 0);

  const leaderPid = await waitForPidFile(leaderPath);
  const descendantPid = await waitForPidFile(childPath);
  ctx.trackedPids.add(leaderPid);
  ctx.trackedPids.add(descendantPid);
  assert.equal(leaderPid, launched.pid);
  assert.equal(pidAlive(leaderPid), true);
  assert.equal(pidAlive(descendantPid), true);
  return { launched, leaderPid, descendantPid };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("shutdown defers _exit while a launch is between fork and runners registration", () => {
  const serve = SUPERVISOR_SOURCE.slice(SUPERVISOR_SOURCE.indexOf("def serve"));
  const flagOn = serve.indexOf("launch_in_flight = True");
  const launchCall = serve.indexOf("launch_runner(", flagOn);
  const register = serve.indexOf("runners[pid] = pid", launchCall);
  const flagOff = serve.indexOf("launch_in_flight = False", register);
  const deferred = serve.indexOf("if shutdown_requested:", flagOff);
  assert.ok(flagOn >= 0, "launch must be marked in-flight before fork");
  assert.ok(launchCall > flagOn, "launch_runner must run while launch_in_flight is set");
  assert.ok(register > launchCall, "runners[pid] must be recorded before clearing the in-flight flag");
  assert.ok(flagOff > register);
  assert.ok(deferred > flagOff, "shutdown requested during launch must run after registration");
  assert.match(serve, /if launch_in_flight:\s*\n\s*return/);
});

for (const shutdownSignal of ["SIGTERM", "SIGINT"]) {
  test(`supervisor ${shutdownSignal} terminates the runner group and descendants`, { timeout: 20_000 }, async (t) => {
    const ctx = await startSupervisor(t);
    const { launched, leaderPid, descendantPid } = await launchSleepGroup(ctx);

    ctx.markStopping();
    const signaled = ctx.child.kill(shutdownSignal);
    assert.equal(signaled, true);
    const exited = await waitForExit(ctx.child, SHUTDOWN_WAIT_MS);
    assert.ok(exited, `supervisor did not exit after ${shutdownSignal}; log: ${ctx.supervisorLog}`);
    assert.equal(exited.signal, null, `supervisor should handle ${shutdownSignal} and _exit(0), not die of the signal`);
    assert.equal(exited.code, 0);

    const goneDeadline = Date.now() + 2_000;
    while (Date.now() < goneDeadline && (pidAlive(leaderPid) || pidAlive(descendantPid))) {
      await sleep(25);
    }
    assert.equal(pidAlive(leaderPid), false, `runner leader ${leaderPid} still alive after supervisor ${shutdownSignal}`);
    assert.equal(pidAlive(descendantPid), false, `runner descendant ${descendantPid} still alive after supervisor ${shutdownSignal}`);
    assert.equal(launched.pgid, launched.pid);
  });
}
