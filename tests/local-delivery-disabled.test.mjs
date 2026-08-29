import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function detailsOf(result) { return result?.details ?? result; }

async function loadTool(root) {
  Object.assign(process.env, {
    DEVELOPMENT_CYCLE_STATE_ROOT: join(root, "state"),
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false",
    DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED: "false",
  });
  delete process.env.DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_COMMAND;
  const { default: plugin } = await import(`../dist/index.js?local-delivery=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  return tool;
}

for (const [sourcePhase, expectedPhase, classification] of [
  ["council_validated", "closed_success", "success"],
  ["council_review_waiting_human", "closed_partial", "partial"],
]) {
  test(`delivery-disabled ${sourcePhase} closes locally as ${expectedPhase}`, async (t) => {
    const root = join(tmpdir(), `development-cycle-local-delivery-${sourcePhase}-${process.pid}-${Date.now()}`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const checkout = join(root, "checkout");
    await mkdir(join(checkout, ".git"), { recursive: true });
    const tool = await loadTool(root);
    const project = sourcePhase.replaceAll("_", "-");
    const runId = `run-${project}`;
    const requested = detailsOf(await tool.execute("request", { action: "request_plan", project, runId, projectRoot: checkout }, undefined, undefined));
    const statusPath = join(requested.dir, "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    status.phase = sourcePhase;
    status.projectRoot = checkout;
    await writeFile(statusPath, JSON.stringify(status));

    const finalized = detailsOf(await tool.execute("finalize", { action: "finalize_delivery", project, runId, projectRoot: checkout }, undefined, undefined));
    assert.equal(finalized.ok, true);
    assert.equal(finalized.phase, expectedPhase);
    assert.equal(finalized.delivery.localOnly, true);
    assert.equal(finalized.delivery.skipped, true);
    assert.equal(finalized.delivery.reason, "repository_delivery_disabled");
    assert.equal(finalized.delivery.classification, classification);
    const persisted = JSON.parse(await readFile(statusPath, "utf8"));
    assert.equal(persisted.phase, expectedPhase);
    assert.equal(persisted.repositoryDelivery.localOnly, true);

    const closed = detailsOf(await tool.execute("close", { action: "close", project, runId }, undefined, undefined));
    assert.equal(closed.ok, true);
    assert.equal(closed.phase, "closed");
  });
}


test("repository delivery request uses outputPath while preserving sourceProjectRoot", async (t) => {
  const root = join(tmpdir(), `development-cycle-local-delivery-output-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const output = join(root, "output");
  await mkdir(join(checkout, ".git"), { recursive: true });
  await mkdir(join(output, ".git"), { recursive: true });
  const tool = await loadTool(root);
  const project = "delivery-output-root";
  const runId = "run-delivery-output-root";
  const requested = detailsOf(await tool.execute("request-output", { action: "request_plan", project, runId, projectRoot: checkout }, undefined, undefined));
  const statusPath = join(requested.dir, "status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  status.phase = "council_validated";
  status.projectRoot = checkout;
  status.outputPath = output;
  await writeFile(statusPath, JSON.stringify(status));

  const finalized = detailsOf(await tool.execute("finalize-output", { action: "finalize_delivery", project, runId, projectRoot: checkout }, undefined, undefined));
  assert.equal(finalized.ok, true, JSON.stringify(finalized));
  const request = JSON.parse(await readFile(join(requested.dir, "repository_delivery_request.json"), "utf8"));
  assert.equal(request.projectRoot, output);
  assert.equal(request.sourceProjectRoot, checkout);
  assert.equal(request.outputPath, output);
});
