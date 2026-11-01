import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredDeliveryQueue } from "../dist/core/deferred-delivery.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("queued delivery waits until the active tool execution ends", async () => {
  const delivered = [];
  const queue = createDeferredDeliveryQueue(async (payload) => {
    delivered.push(payload);
    return { ok: true, payload };
  });
  queue.beginExecution();
  const queued = queue.enqueue({ payload: "launch" });
  assert.equal(queued.queued, true);
  await tick();
  assert.deepEqual(delivered, []);
  queue.endExecution();
  await tick();
  await tick();
  assert.deepEqual(delivered, ["launch"]);
});

test("nested active executions do not drain until the final execution returns", async () => {
  const delivered = [];
  const queue = createDeferredDeliveryQueue(async (payload) => {
    delivered.push(payload);
    return { ok: true };
  });
  queue.beginExecution();
  queue.beginExecution();
  queue.enqueue({ payload: "intervention" });
  queue.endExecution();
  await tick();
  assert.deepEqual(delivered, []);
  queue.endExecution();
  await tick();
  await tick();
  assert.deepEqual(delivered, ["intervention"]);
});

test("delivery callback receives the eventual result without blocking enqueue", async () => {
  const callbacks = [];
  const queue = createDeferredDeliveryQueue(async (payload) => ({ ok: true, payload }));
  queue.beginExecution();
  queue.enqueue({ payload: "done", onResult: (result) => { callbacks.push(result); } });
  assert.deepEqual(callbacks, []);
  queue.endExecution();
  await tick();
  await tick();
  assert.deepEqual(callbacks, [{ ok: true, payload: "done" }]);
});
