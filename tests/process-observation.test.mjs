import assert from "node:assert/strict";
import test from "node:test";
import { findProviderProcessesOutsideObservedTree, isZombieProcess } from "../dist/core/process-observation.js";

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
