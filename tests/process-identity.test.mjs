import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execSupervisedCommand, readProcessIdentity, RUN_MARKER_ENV, stopVerifiedProcessGroup } from "../dist/runtime/processes.js";
import { spawn } from "node:child_process";

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
  // Without a recorded session id the runner is not proven to lead its session, so other session members are left alone.
  const result = await stopVerifiedProcessGroup(identity, async () => ++reads === 1 ? identity : null, signal, 5000, async () => [1234, 5678]);
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

test("stopping a runner also stops subtasks that left its process group but not its session", { skip: process.platform !== "linux" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "development-cycle-stop-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const childPath = join(dir, "child.pid");
  // The subshell starts the job in a group of its own (job control) and exits, as Octopus subtasks do.
  const runner = spawn("bash", ["-c", `(set -m; sleep 120 & echo $! > "${childPath}"); sleep 120`], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-runner.pid, "SIGKILL"); } catch {} });
  let child = 0;
  for (let i = 0; i < 100 && !child; i++) { child = Number((await readFile(childPath, "utf8").catch(() => "")).trim()); if (!child) await new Promise((resolve) => setTimeout(resolve, 20)); }
  t.after(() => { try { process.kill(child, "SIGKILL"); } catch {} });
  const childStat = (await readFile(`/proc/${child}/stat`, "utf8")).split(") ")[1].split(" ");
  assert.notEqual(Number(childStat[2]), runner.pid, "the subtask must have left the runner's process group");
  assert.equal(Number(childStat[3]), runner.pid, "the subtask must still be in the runner's session");
  const result = await stopVerifiedProcessGroup(await readProcessIdentity(runner.pid), readProcessIdentity, process.kill.bind(process), 2000);
  assert.equal(result.ok, true, JSON.stringify(result));
  let state;
  for (let i = 0; i < 50; i++) {
    try { state = (await readFile(`/proc/${child}/stat`, "utf8")).split(") ")[1].split(" ")[0]; } catch (error) { assert.equal(error.code, "ENOENT"); state = undefined; }
    if (!state || state === "Z") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(!state || state === "Z", `subtask ${child} still alive (${state})`);
});

test("stopping a run whose runner already exited still stops its own subtasks, and only those", { skip: process.platform !== "linux" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "development-cycle-stop-exited-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const childPath = join(dir, "child.pid");
  const strangerPath = join(dir, "stranger.pid");
  // Once the runner is gone its session id proves nothing, so a member without this launch's marker is left alone.
  const script = `(set -m; sleep 120 & echo $! > "${childPath}"; env -u ${RUN_MARKER_ENV} sleep 120 & echo $! > "${strangerPath}"); sleep 0.5`;
  const runner = spawn("bash", ["-c", script], { detached: true, stdio: "ignore", env: { ...process.env, [RUN_MARKER_ENV]: "attempt-1" } });
  const exited = new Promise((resolve) => runner.on("exit", resolve));
  let identity = null;
  let child = 0;
  let stranger = 0;
  for (let i = 0; i < 100 && !(child && stranger); i++) {
    identity ??= await readProcessIdentity(runner.pid);
    child = Number((await readFile(childPath, "utf8").catch(() => "")).trim());
    stranger = Number((await readFile(strangerPath, "utf8").catch(() => "")).trim());
    if (!(child && stranger)) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  t.after(() => { for (const pid of [child, stranger]) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.equal(identity.sid, runner.pid);
  await exited;
  const result = await stopVerifiedProcessGroup({ ...identity, runMarker: "attempt-1" }, readProcessIdentity, process.kill.bind(process), 2000);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.skipped, true);
  assert.ok(!(await alive(child)), `subtask ${child} still alive`);
  assert.ok(await alive(stranger), "a session member without the run's marker must not be signalled");
});

async function alive(pid) {
  for (let i = 0; i < 50; i++) {
    let state;
    try { state = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].split(" ")[0]; } catch (error) { assert.equal(error.code, "ENOENT"); }
    if (!state || state === "Z") return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}
