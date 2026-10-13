import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { execSupervisedCommand, stopVerifiedProcessGroup } from "../dist/runtime/processes.js";

test("cancellation refuses a reused PID or unverified process group", async () => {
  const identity = { pid: 1234, pgid: 1234, startTime: "100", bootId: "boot-one" };
  const signals = [];
  const signal = (pid, sig) => { signals.push([pid, sig]); };
  for (const change of [{ startTime: "101" }, { bootId: "boot-two" }, { pgid: 1 }]) {
    assert.equal((await stopVerifiedProcessGroup(identity, async () => ({ ...identity, ...change }), signal)).ok, false);
  }
  assert.equal((await stopVerifiedProcessGroup(null, async () => identity, signal)).ok, false);
  assert.deepEqual(signals, []);
  let reads = 0;
  const result = await stopVerifiedProcessGroup(identity, async () => ++reads === 1 ? identity : null, signal);
  assert.equal(result.ok, true);
  assert.deepEqual(signals, [[-1234, "SIGTERM"]]);
});

test("cancellation never escalates to KILL against a replaced process", async () => {
  const identity = { pid: 1234, pgid: 1234, startTime: "100", bootId: "boot-one" };
  let reads = 0;
  const signals = [];
  const result = await stopVerifiedProcessGroup(identity, async () => ++reads === 1 ? identity : { ...identity, startTime: "101" }, (pid, signal) => { signals.push([pid, signal]); });
  assert.equal(result.ok, false);
  assert.deepEqual(signals, [[-1234, "SIGTERM"]]);
});

test("a validation timeout kills shell descendants", { skip: process.platform !== "linux" }, async () => {
  let child;
  try {
    await execSupervisedCommand("sh", ["-c", "sleep 60 & echo $!; wait"], { cwd: "/tmp", timeout: 1000, maxBuffer: 4096 });
    assert.fail("command should time out");
  } catch (error) {
    assert.equal(error.code, 124);
    child = Number(error.stdout.trim());
    assert.ok(child > 1);
  }
  let state;
  try { state = (await readFile(`/proc/${child}/stat`, "utf8")).split(") ")[1].split(" ")[0]; } catch (error) { assert.equal(error.code, "ENOENT"); }
  assert.ok(!state || state === "Z", `descendant ${child} still alive (${state})`);
});
