import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotificationService, invokeGatewayMessage } from "../dist/runtime/notifications.js";
import { createFilesystemStore } from "../dist/storage/filesystem.js";

const config = { enabled: true, channel: "slack", target: "fixture", account: "", deliveryJson: "" };
async function until(check) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("notification did not reach expected state");
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-outbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: createFilesystemStore(root) };
}

test("pending notifications survive restart and defer delivery during active actions", async t => {
  const { root, store } = await fixture(t);
  const delivered = [];
  const before = createNotificationService(store, root, config, async payload => { delivered.push(payload); return { ok: true }; });
  before.beginExecution();
  const result = await before.send({ notificationDryRun: true }, "Phase", "Ready");
  const path = join(root, "notification-outbox", result.notificationId + ".json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.payload.args.dryRun, true);
  assert.deepEqual(delivered, []);
  assert.equal(saved.token, undefined);
  before.dispose();
  const after = createNotificationService(store, root, config, async payload => { delivered.push(payload); return { ok: true }; });
  t.after(() => after.dispose());
  after.beginExecution();
  await after.recover();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delivered, []);
  after.endExecution();
  await until(async () => !(await readdir(join(root, "notification-outbox"))).includes(result.notificationId + ".json"));
  assert.equal(delivered.length, 1);
});

test("failed deliveries retain retry state and stop retrying after five attempts", async t => {
  const { root, store } = await fixture(t);
  let calls = 0;
  const service = createNotificationService(store, root, config, async () => { calls++; throw new Error("offline"); });
  t.after(() => service.dispose());
  const result = await service.send({}, "Phase", "Ready");
  const path = join(root, "notification-outbox", result.notificationId + ".json");
  for (let attempt = 1; attempt <= 5; attempt++) {
    await until(async () => (await store.loadJson(path)).attempts === attempt && !service.snapshot().draining).catch(async error => {
      throw new Error(`${error.message}; expected attempt ${attempt}; calls ${calls}; job ${JSON.stringify(await store.loadJson(path))}; queue ${JSON.stringify(service.snapshot())}`);
    });
    const job = await store.loadJson(path);
    assert.equal(job.failed, attempt === 5);
    assert.match(job.lastResult.error, /offline/);
    if (attempt < 5) {
      assert.ok(job.nextAttemptAt > Date.now());
      await store.saveJson(path, { ...job, nextAttemptAt: 0 });
      await service.recover();
    }
  }
  await service.recover();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 5);
});

test("two services sharing an outbox claim each notification once", async t => {
  const { root, store } = await fixture(t);
  const first = createNotificationService(store, root, config);
  first.beginExecution();
  await first.send({}, "Phase", "Ready");
  first.dispose();
  let calls = 0;
  const deliver = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 100)); return { ok: true }; };
  const a = createNotificationService(store, root, config, deliver);
  const b = createNotificationService(store, root, config, deliver);
  t.after(() => { a.dispose(); b.dispose(); });
  await Promise.all([a.recover(), b.recover()]);
  await until(async () => (await readdir(join(root, "notification-outbox"))).length === 0);
  assert.equal(calls, 1);
});

test("gateway HTTP success alone cannot acknowledge a failed message tool", async t => {
  const responses = ["not-json", JSON.stringify({ ok: true, result: { isError: true } }), JSON.stringify({ ok: true, result: { details: { ok: false } } }), JSON.stringify({ ok: true, result: { ok: true } })];
  const server = createServer((_req, res) => { res.end(responses.shift()); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.DEVELOPMENT_CYCLE_GATEWAY_URL;
  process.env.DEVELOPMENT_CYCLE_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { if (previous === undefined) delete process.env.DEVELOPMENT_CYCLE_GATEWAY_URL; else process.env.DEVELOPMENT_CYCLE_GATEWAY_URL = previous; await new Promise(resolve => server.close(resolve)); });
  const payload = { tool: "message", action: "send", args: { channel: "slack", target: "fixture", message: "hello" } };
  assert.equal((await invokeGatewayMessage(payload)).ok, false);
  assert.equal((await invokeGatewayMessage(payload)).ok, false);
  assert.equal((await invokeGatewayMessage(payload)).ok, false);
  assert.equal((await invokeGatewayMessage(payload)).ok, true);
});
