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

test("malicious projectWikiPath does not expand planPath allowlist", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-wiki-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code"), { recursive: true });
  await mkdir(join(root, "docs", "fixture-wiki"), { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  const secret = join(outside, "secret-plan.md");
  await writeFile(
    secret,
    "# Implementation plan\n\n## Project paths\n- projectRoot\n- projectWikiPath\n\n## Tasks\n1. x\n\n## Validation checks\n- npm test\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- file\n",
  );

  const tool = await registerPlugin(root);
  const planReq = await tool.execute(
    "pw-1",
    { action: "request_plan", project: "fixture-wiki", projectRoot: join(root, "code"), direction: "wiki path" },
    undefined,
    undefined,
  );
  assert.equal(planReq.details.ok, true);
  const runId = planReq.details.runId;

  // Without trust: projectWikiPath=outside would allow planPath under outside.
  const blocked = await tool.execute(
    "pw-2",
    {
      action: "record_plan",
      project: "fixture-wiki",
      runId,
      projectRoot: join(root, "code"),
      projectWikiPath: outside,
      planPath: secret,
      force: true,
    },
    undefined,
    undefined,
  );
  assert.equal(blocked.details.ok, false, JSON.stringify(blocked.details));
  assert.equal(blocked.details.error, "plan_path_outside_allowed_roots");
});

test("projectWikiPath that is a dir-symlink under wiki root does not write outside", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-wsym-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code"), { recursive: true });
  await mkdir(join(root, "docs", "fixture-wsym"), { recursive: true });
  const outside = join(root, "outside-target");
  await mkdir(outside, { recursive: true });
  // Lexically under projectsWikiRoot, but realpath escapes:
  await symlink(outside, join(root, "docs", "fixture-wsym", "escape-dir"));

  const tool = await registerPlugin(root);
  const planReq = await tool.execute(
    "ws-1",
    { action: "request_plan", project: "fixture-wsym", projectRoot: join(root, "code"), direction: "wiki symlink write" },
    undefined,
    undefined,
  );
  assert.equal(planReq.details.ok, true);
  const runId = planReq.details.runId;

  const planBody = `# Implementation plan

## Project paths
- projectRoot
- projectWikiPath

## Tasks
1. x

## Validation checks
- npm test

## Stop conditions
- none

## Expected artifacts
- file
`;
  const recorded = await tool.execute(
    "ws-2",
    {
      action: "record_plan",
      project: "fixture-wsym",
      runId,
      projectRoot: join(root, "code"),
      projectWikiPath: join(root, "docs", "fixture-wsym", "escape-dir"),
      planText: planBody,
      force: true,
    },
    undefined,
    undefined,
  );
  // Plan may record into cycle state, but must NOT create outside-target/plans/*
  const leaked = join(outside, "plans");
  let leakedExists = false;
  try {
    await access(leaked);
    leakedExists = true;
  } catch {
    leakedExists = false;
  }
  assert.equal(leakedExists, false, `write escaped to ${leaked}; details=${JSON.stringify(recorded.details)}`);
});

test("broad projectRoot does not make outside planPath readable", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-pr-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code"), { recursive: true });
  const secret = join(root, "secret.env");
  await writeFile(secret, "SECRET=should-not-leak\n");

  const tool = await registerPlugin(root);
  const planReq = await tool.execute(
    "ppr-1",
    { action: "request_plan", project: "fixture-pr", projectRoot: join(root, "code"), direction: "projectRoot guard" },
    undefined,
    undefined,
  );
  assert.equal(planReq.details.ok, true);
  const runId = planReq.details.runId;

  for (const projectRoot of ["/", root]) {
    const blocked = await tool.execute(
      "ppr-2",
      {
        action: "record_plan",
        project: "fixture-pr",
        runId,
        projectRoot,
        planPath: secret,
        force: true,
      },
      undefined,
      undefined,
    );
    assert.equal(blocked.details.ok, false, `projectRoot=${projectRoot} ${JSON.stringify(blocked.details)}`);
    assert.equal(blocked.details.error, "plan_path_outside_allowed_roots");
  }
});

test("resolveTrustedProjectWikiPath fallback does not escape for dot-token projects", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-dot-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code"), { recursive: true });
  await writeFile(join(root, "code", "package.json"), JSON.stringify({ name: "x", scripts: { check: "true" } }));
  const sibling = join(root, "sibling");
  await mkdir(sibling, { recursive: true });
  const siblingConfig = join(sibling, "validation.json");
  await writeFile(siblingConfig, JSON.stringify({ commands: ["printf SIBLING_LEAK"] }));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "validation.json"), JSON.stringify({ commands: ["printf DOT_ROOT_LEAK"] }));

  const tool = await registerPlugin(root);

  for (const project of ["..", "."]) {
    const planReq = await tool.execute(
      "pdot-1",
      { action: "request_plan", project, projectRoot: join(root, "code"), direction: "dot-token fallback" },
      undefined,
      undefined,
    );
    assert.equal(planReq.details.ok, true, JSON.stringify(planReq.details));
    const runId = planReq.details.runId;
    const dir = planReq.details.dir;
    const statusPath = join(dir, "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    status.phase = "implementation_delivered";
    await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`);

    const result = await tool.execute(
      "pdot-2",
      {
        action: "run_final_validation",
        project,
        runId,
        projectRoot: join(root, "code"),
        validationConfigPath: siblingConfig,
      },
      undefined,
      undefined,
    );
    const cmds = JSON.stringify(result.details.commandResults || result.details.failures || []);
    assert.doesNotMatch(cmds, /SIBLING_LEAK|DOT_ROOT_LEAK/);
    const loadedPath = result.details.status?.validationConfigPath || result.details.validationConfigPath;
    assert.ok(
      !loadedPath || loadedPath === "default" || !String(loadedPath).includes("sibling"),
      `config path must not be the sibling file; got ${loadedPath}`,
    );
    if (result.details.ok !== false || result.details.error !== "invalid_phase_transition") {
      assert.equal(result.details.status?.validationConfigPath || "default", "default");
      assert.ok(
        result.details.rejectedValidationConfigPath || result.details.status?.rejectedValidationConfigPath,
        `rejected path should surface; details=${JSON.stringify(result.details)}`,
      );
    }
  }
});

test("writePlanningPack recon does not follow wiki symlink outside the root", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-recon-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code"), { recursive: true });
  await mkdir(join(root, "docs", "fixture-recon"), { recursive: true });
  const outside = join(root, "outside-wiki");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "README.md"), "SECRET_RECON_LEAK=should-not-appear\n");
  await symlink(outside, join(root, "docs", "fixture-recon", "escape"));

  const tool = await registerPlugin(root);
  const planReq = await tool.execute(
    "precon-1",
    {
      action: "request_plan",
      project: "fixture-recon",
      projectRoot: join(root, "code"),
      projectWikiPath: join(root, "docs", "fixture-recon", "escape"),
      direction: "recon symlink",
    },
    undefined,
    undefined,
  );
  assert.equal(planReq.details.ok, true, JSON.stringify(planReq.details));
  const pack = await readFile(join(planReq.details.dir, "context_pack.md"), "utf8");
  assert.doesNotMatch(pack, /SECRET_RECON_LEAK/);
  assert.match(pack, /projectWikiPath missing or not supplied/);
});
