import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SUPERVISOR_PATH = fileURLToPath(new URL("../runner-supervisor.py", import.meta.url));
const SOCKET_WAIT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function sendAndHangUp(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    sock.setTimeout(SOCKET_TIMEOUT_MS);
    sock.on("connect", () => {
      sock.write(payload);
      sock.destroy();
    });
    sock.on("close", resolve);
    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error("disconnect client timed out before hang-up"));
    });
    sock.on("error", () => {
      // Closing without reading can surface EPIPE/ECONNRESET locally.
    });
  });
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

test("supervisor survives a client that disconnects without reading the response", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "development-cycle-supervisor-disconnect-"));
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

  // Regression trigger: a complete unknown-action request, then hang up
  // without reading so the supervisor's response sendall hits a broken pipe.
  await sendAndHangUp(socketPath, '{"action":"unknown_action"}\n');

  assert.equal(
    unexpectedExit,
    undefined,
    `supervisor exited after client disconnect: ${JSON.stringify(unexpectedExit)}; log: ${supervisorLog}`,
  );

  const parsed = await readJsonLine(socketPath, '{"action":"ping"}\n');
  assert.equal(parsed.ok, true);
});
