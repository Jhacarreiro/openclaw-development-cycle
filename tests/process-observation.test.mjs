import assert from "node:assert/strict";
import test from "node:test";
import { findProviderProcessesOutsideObservedTree, isZombieProcess } from "../dist/core/process-observation.js";

test("zombie provider processes are informational, not outside-tree blockers", () => {
  const zombie = { pid: 337, ppid: 1, stat: "Z", comm: "node" };
  assert.equal(isZombieProcess(zombie), true);
  assert.deepEqual(findProviderProcessesOutsideObservedTree([zombie], [], []), []);
});

test("live provider processes outside the observed tree remain blockers", () => {
  const live = { pid: 9001, ppid: 1, stat: "Sl", comm: "codex" };
  assert.deepEqual(findProviderProcessesOutsideObservedTree([live], [], []), [live]);
});

test("live provider processes already inside the observed tree are not blockers", () => {
  const live = { pid: 9002, ppid: 8000, stat: "S", comm: "claude" };
  assert.deepEqual(findProviderProcessesOutsideObservedTree([live], [live], []), []);
});
