import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function registerPlugin(root) {
  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";
  const { default: plugin } = await import(`../dist/index.js?pathguard=${Date.now()}-${Math.random()}`);
  let registered;
  plugin.register({
    pluginConfig: {},
    registerTool(tool) {
      registered = tool;
    },
  });
  return registered;
}

test("record_plan rejects planPath outside allowed roots", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-g-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code"), { recursive: true });
  const secret = join(root, "secret.env");
  await writeFile(secret, "SECRET=should-not-leak\n");

  const tool = await registerPlugin(root);
  const planReq = await tool.execute(
    "pg-1",
    { action: "request_plan", project: "fixture-g", projectRoot: join(root, "code"), direction: "path guard" },
    undefined,
    undefined,
  );
  assert.equal(planReq.details.ok, true);
  const runId = planReq.details.runId;

  const blocked = await tool.execute(
    "pg-2",
    {
      action: "record_plan",
      project: "fixture-g",
      runId,
      projectRoot: join(root, "code"),
      planPath: secret,
      force: true,
    },
    undefined,
    undefined,
  );
  assert.equal(blocked.details.ok, false);
  assert.equal(blocked.details.error, "plan_path_outside_allowed_roots");

  // Allowed: plan under project docs
  const allowedPlan = join(root, "docs", "fixture-g", "good-plan.md");
  await mkdir(join(root, "docs", "fixture-g"), { recursive: true });
  await writeFile(
    allowedPlan,
    "# Implementation plan\n\n## Project paths\n- projectRoot\n- projectWikiPath\n\n## Tasks\n1. x\n\n## Validation checks\n- npm test\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- file\n",
  );
  const ok = await tool.execute(
    "pg-3",
    {
      action: "record_plan",
      project: "fixture-g",
      runId,
      projectRoot: join(root, "code"),
      planPath: allowedPlan,
      force: true,
    },
    undefined,
    undefined,
  );
  assert.equal(ok.details.ok, true, JSON.stringify(ok.details));
});

test("run_final_validation ignores validationConfigPath outside allowed roots", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-h-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code"), { recursive: true });
  await writeFile(join(root, "code", "package.json"), JSON.stringify({ name: "x", scripts: { check: "true" } }));
  const marker = join(root, "rce.txt");
  const evil = join(root, "evil-validation.json");
  await writeFile(evil, JSON.stringify({ commands: [`printf RCE_OK > '${marker}'`] }));

  const tool = await registerPlugin(root);
  const planReq = await tool.execute(
    "ph-1",
    { action: "request_plan", project: "fixture-h", projectRoot: join(root, "code") },
    undefined,
    undefined,
  );
  const runId = planReq.details.runId;
  // force plan so we can reach a phase that allows validation; seed status via record_plan
  await tool.execute(
    "ph-2",
    {
      action: "record_plan",
      project: "fixture-h",
      runId,
      projectRoot: join(root, "code"),
      force: true,
      planText:
        "# Implementation plan\n\n## Project paths\n- projectRoot: code\n- projectWikiPath: docs\n\n## Tasks\n1. a\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- none\n",
    },
    undefined,
    undefined,
  );

  // Seed phase that allows run_final_validation if needed via reconcile/status; try directly
  const result = await tool.execute(
    "ph-3",
    {
      action: "run_final_validation",
      project: "fixture-h",
      runId,
      projectRoot: join(root, "code"),
      validationConfigPath: evil,
    },
    undefined,
    undefined,
  );
  // Must not execute evil commands
  let rce = false;
  try {
    await access(marker);
    rce = true;
  } catch {
    rce = false;
  }
  assert.equal(rce, false, `RCE marker must not exist; result=${JSON.stringify(result.details)}`);
  // Either rejected path or ran with defaults only
  if (result.details.ok === false && result.details.error) {
    // phase gate or rejection both OK as long as no RCE
    assert.ok(true);
  } else {
    const cmds = result.details.commandResults || result.details.failures || [];
    const joined = JSON.stringify(cmds);
    assert.doesNotMatch(joined, /RCE_OK|evil-validation/);
  }
});


test("planPath via symlink outside roots is rejected", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-sym-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code"), { recursive: true });
  await mkdir(join(root, "docs", "fixture-sym"), { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "SECRET=should-not-leak\n");
  // symlink under project docs pointing outside allowed tree
  await symlink(outside, join(root, "docs", "fixture-sym", "escape"));

  const tool = await registerPlugin(root);
  const planReq = await tool.execute(
    "ps-1",
    { action: "request_plan", project: "fixture-sym", projectRoot: join(root, "code"), direction: "symlink guard" },
    undefined,
    undefined,
  );
  assert.equal(planReq.details.ok, true);
  const runId = planReq.details.runId;

  const blocked = await tool.execute(
    "ps-2",
    {
      action: "record_plan",
      project: "fixture-sym",
      runId,
      projectRoot: join(root, "code"),
      planPath: join(root, "docs", "fixture-sym", "escape", "secret.txt"),
      force: true,
    },
    undefined,
    undefined,
  );
  assert.equal(blocked.details.ok, false, JSON.stringify(blocked.details));
  assert.equal(blocked.details.error, "plan_path_outside_allowed_roots");
});
