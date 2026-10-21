import assert from "node:assert/strict";
import test from "node:test";
import { findProviderProcessesOutsideObservedTree, isZombieProcess, observedRunTree } from "../dist/core/process-observation.js";

test("zombie provider processes are informational, not outside-tree blockers", () => {
  const zombie = { pid: 337, ppid: 1, stat: "Z", comm: "node" };
  assert.equal(isZombieProcess(zombie), true);
  assert.deepEqual(findProviderProcessesOutsideObservedTree([zombie], [], []), []);
});

test("live provider processes outside the observed tree that still work in the run's worktree remain blockers", () => {
  const live = { pid: 9001, ppid: 1, stat: "Sl", comm: "command-code", cwd: "/work/worktrees/run-1/integration/src" };
  assert.deepEqual(findProviderProcessesOutsideObservedTree([live], [], [], ["/work/project", "/work/worktrees/run-1/integration"]), [live]);
});

test("provider processes working outside the run's checkouts are not this run's blockers", () => {
  const harness = { pid: 720, ppid: 706, stat: "Sl", comm: "codex", cwd: "/opt/app" };
  const sibling = { pid: 721, ppid: 1, stat: "Sl", comm: "codex", cwd: "/work/project-other" };
  const unknown = { pid: 722, ppid: 0, stat: "Ssl+", comm: "claude", cwd: null };
  assert.deepEqual(findProviderProcessesOutsideObservedTree([harness, sibling, unknown], [], [], ["/work/project"]), []);
});

test("live provider processes already inside the observed tree are not blockers", () => {
  const live = { pid: 9002, ppid: 8000, stat: "S", comm: "claude" };
  assert.deepEqual(findProviderProcessesOutsideObservedTree([live], [live], []), []);
});

test("a run's tree holds subtasks reparented out of it that stay in the runner's session", () => {
  const supervisor = { pid: 50, ppid: 7, sid: 50, comm: "python3" };
  const runner = { pid: 100, ppid: 50, sid: 100, comm: "sh" };
  const child = { pid: 101, ppid: 100, sid: 100, comm: "bash" };
  const detached = { pid: 200, ppid: 50, sid: 100, comm: "bash" };
  const provider = { pid: 201, ppid: 200, sid: 100, comm: "command-code", cwd: "/work/worktrees/run-1/integration" };
  const otherRun = { pid: 300, ppid: 50, sid: 300, comm: "command-code", cwd: "/work/worktrees/run-1/integration" };
  const tree = observedRunTree([supervisor, runner, child, detached, provider, otherRun], [100]);
  assert.deepEqual(tree.map((row) => row.pid).sort(), [101, 200, 201]);
  assert.deepEqual(findProviderProcessesOutsideObservedTree([provider, otherRun], tree, [runner], ["/work/worktrees/run-1/integration"]), [otherRun]);
});

test("a root that does not lead its session does not claim the session's other processes", () => {
  const shell = { pid: 10, ppid: 1, sid: 10, comm: "sh" };
  const root = { pid: 20, ppid: 10, sid: 10, comm: "sh" };
  const unrelated = { pid: 30, ppid: 10, sid: 10, comm: "codex" };
  assert.deepEqual(observedRunTree([shell, root, unrelated], [20]), []);
});
