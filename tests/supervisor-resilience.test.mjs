import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SUPERVISOR_PATH = fileURLToPath(new URL("../runner-supervisor.py", import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ping(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const chunks = [];
    const fail = (error) => {
      sock.destroy();
      reject(error);
    };
    sock.setTimeout(5000);
    sock.on("connect", () => sock.write('{"action":"ping"}\n'));
    sock.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(0x0a)) sock.end();
    });
    sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    sock.on("error", fail);
    sock.on("timeout", () => fail(new Error("ping timed out")));
  });
}

test("supervisor rejects an oversized request and remains healthy", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "development-cycle-supervisor-"));
  const socketPath = join(dir, "supervisor.sock");
  const child = spawn("python3", [SUPERVISOR_PATH, "--socket", socketPath, "serve"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let supervisorLog = "";
  child.stdout.on("data", (chunk) => { supervisorLog += chunk; });
  child.stderr.on("data", (chunk) => { supervisorLog += chunk; });
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 5000;
  while (!existsSync(socketPath) && Date.now() < deadline) await sleep(25);
  assert.ok(existsSync(socketPath), `supervisor socket appeared; log: ${supervisorLog}`);

  const rejection = await new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const chunks = [];
    sock.setTimeout(5000);
    sock.on("connect", () => {
      sock.write(Buffer.alloc(1024 * 1024, 0x61));
      sock.write(Buffer.alloc(64, 0x61));
    });
    sock.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(0x0a)) sock.end();
    });
    sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    sock.on("error", reject);
    sock.on("timeout", () => reject(new Error("oversized request timed out")));
  });
  const rejected = JSON.parse(rejection);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /^ValueError:request too large$/);

  // A peer may disappear while the supervisor is trying to send the same
  // rejection. Expected teardown errors are client-side noise, not failures.
  await new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    sock.on("connect", () => {
      sock.write(Buffer.alloc(1024 * 1024, 0x62));
      sock.write(Buffer.alloc(64, 0x62));
      sock.destroy();
    });
    sock.on("close", resolve);
    sock.on("error", (error) => {
      if (error?.code === "EPIPE" || error?.code === "ECONNRESET") return;
      reject(error);
    });
  });

  await sleep(300);
  const reply = await ping(socketPath);
  const parsed = JSON.parse(reply);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.subreaper, true);
});
