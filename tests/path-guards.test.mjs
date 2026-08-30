import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, access, symlink, rename, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

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
  await mkdir(join(root, "code", ".git"), { recursive: true });
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
  await mkdir(join(root, "code", ".git"), { recursive: true });
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

test("nested system projectRoot does not authorize plan reads", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-system-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code", ".git"), { recursive: true });
  const tool = await registerPlugin(root);
  const req = await tool.execute("sys-1", { action: "request_plan", project: "fixture-system", projectRoot: join(root, "code") }, undefined, undefined);
  const blocked = await tool.execute("sys-2", { action: "record_plan", project: "fixture-system", runId: req.details.runId, projectRoot: "/etc/ssl", planPath: "/etc/ssl/openssl.cnf", force: true }, undefined, undefined);
  assert.equal(blocked.details.ok, false, JSON.stringify(blocked.details));
  assert.equal(blocked.details.error, "plan_path_outside_allowed_roots");
});

test("dangling wiki symlink is rejected before mkdir", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-dangling-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code", ".git"), { recursive: true });
  await mkdir(join(root, "docs", "fixture-dangling"), { recursive: true });
  const outside = join(root, "outside-missing");
  await symlink(outside, join(root, "docs", "fixture-dangling", "escape"));
  const tool = await registerPlugin(root);
  const req = await tool.execute("dang-1", { action: "request_plan", project: "fixture-dangling", projectRoot: join(root, "code") }, undefined, undefined);
  const rec = await tool.execute("dang-2", { action: "record_plan", project: "fixture-dangling", runId: req.details.runId, projectRoot: join(root, "code"), projectWikiPath: join(root, "docs", "fixture-dangling", "escape", "child"), planText: "# Implementation plan\n\n## Project paths\n- projectRoot\n- projectWikiPath\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- file\n", force: true }, undefined, undefined);
  assert.equal(rec.details.canonicalPlan, null);
  await assert.rejects(() => access(outside));
});

test("symlinked plans directory is rejected before write", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-plans-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "code", ".git"), { recursive: true });
  const wiki = join(root, "docs", "fixture-plans");
  const outside = join(root, "outside-plans");
  await mkdir(wiki, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(wiki, "plans"));
  const tool = await registerPlugin(root);
  const req = await tool.execute("plans-1", { action: "request_plan", project: "fixture-plans", projectRoot: join(root, "code") }, undefined, undefined);
  const rec = await tool.execute("plans-2", { action: "record_plan", project: "fixture-plans", runId: req.details.runId, projectRoot: join(root, "code"), projectWikiPath: wiki, planText: "# Implementation plan\n\n## Project paths\n- projectRoot\n- projectWikiPath\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- file\n", force: true }, undefined, undefined);
  assert.equal(rec.details.canonicalPlan, null);
  assert.deepEqual(await import("node:fs/promises").then((m) => m.readdir(outside)), []);
});

test("git checkout projectRoot authorizes contained plan read", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-git-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = join(root, "code");
  await mkdir(join(code, ".git"), { recursive: true });
  const planPath = join(code, "plan.md");
  await writeFile(planPath, "# Implementation plan\n\n## Project paths\n- projectRoot\n- projectWikiPath\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- file\n");
  const tool = await registerPlugin(root);
  const req = await tool.execute("git-1", { action: "request_plan", project: "fixture-git", projectRoot: code }, undefined, undefined);
  const rec = await tool.execute("git-2", { action: "record_plan", project: "fixture-git", runId: req.details.runId, projectRoot: code, planPath, force: true }, undefined, undefined);
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
});

test("start_implementation rejects external plan via symlinked wiki root", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-start-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = join(root, "code");
  const docs = join(root, "docs");
  const outside = join(root, "outside");
  await mkdir(join(code, ".git"), { recursive: true });
  await mkdir(join(docs, "fixture-start"), { recursive: true });
  await mkdir(outside, { recursive: true });
  const externalPlan = join(outside, "external-plan.md");
  await writeFile(externalPlan, "# external\n");
  const wikiLink = join(docs, "fixture-start", "escape");
  await symlink(outside, wikiLink);
  const tool = await registerPlugin(root);
  const req = await tool.execute("start-1", { action: "request_plan", project: "fixture-start", projectRoot: code }, undefined, undefined);
  const rec = await tool.execute("start-2", {
    action: "record_plan",
    project: "fixture-start",
    runId: req.details.runId,
    projectRoot: code,
    projectWikiPath: join(docs, "fixture-start"),
    planText: "# Implementation plan\n\n## Project paths\n- projectRoot\n- projectWikiPath\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- file\n",
    force: true,
  }, undefined, undefined);
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
  const started = await tool.execute("start-3", {
    action: "start_implementation",
    project: "fixture-start",
    runId: req.details.runId,
    projectRoot: code,
    projectWikiPath: wikiLink,
    planPath: externalPlan,
    force: true,
  }, undefined, undefined);
  assert.equal(started.details.ok, false, JSON.stringify(started.details));
  assert.equal(started.details.error, "plan_path_outside_allowed_roots");
});

test("fresh projects docs root is created before canonical plan persistence", async (t) => {
  const root = join(tmpdir(), `ocl-pathguard-fresh-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = join(root, "code");
  await mkdir(join(code, ".git"), { recursive: true });
  const tool = await registerPlugin(root);
  await rm(join(root, "docs"), { recursive: true, force: true });
  const req = await tool.execute("fresh-1", { action: "request_plan", project: "fixture-fresh", projectRoot: code }, undefined, undefined);
  const rec = await tool.execute("fresh-2", {
    action: "record_plan", project: "fixture-fresh", runId: req.details.runId, projectRoot: code,
    planText: "# Implementation plan\n\n## Project paths\n- projectRoot\n- projectWikiPath\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- file\n",
    force: true,
  }, undefined, undefined);
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
  assert.ok(rec.details.canonicalPlan, JSON.stringify(rec.details));
  await access(rec.details.canonicalPlan);
});


test("validation config in projectRoot is honored", async t=>{const r=join(tmpdir(),`ocl-pcfg-${process.pid}-${Date.now()}`);t.after(()=>rm(r,{recursive:true,force:true}));const c=join(r,"code");await mkdir(join(c,".git"),{recursive:true});const m=join(r,"ran"),v=join(c,"validation.json");await writeFile(v,JSON.stringify({commands:[`printf OK > ${m}`]}));const tool=await registerPlugin(r);const q=await tool.execute("q",{action:"request_plan",project:"pcfg",projectRoot:c});await tool.execute("r",{action:"record_plan",project:"pcfg",runId:q.details.runId,projectRoot:c,planText:"# Implementation plan\n\n## Project paths\n- x\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- x\n",force:true});const sp=join(q.details.dir,"status.json"),st=JSON.parse(await readFile(sp,"utf8"));st.phase="implementation_delivered";await writeFile(sp,JSON.stringify(st));const z=await tool.execute("v",{action:"run_final_validation",project:"pcfg",runId:q.details.runId,projectRoot:c,validationConfigPath:v});await access(m);assert.equal(z.details.status?.validationConfigPath,v)});


test("pinned write resists concurrent parent symlink swap",async t=>{const r=join(tmpdir(),`ocl-swap-${process.pid}-${Date.now()}`);t.after(()=>rm(r,{recursive:true,force:true}));t.after(()=>{delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WRITE_READY_FILE;delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WRITE_DELAY_MS});const c=join(r,"code"),w=join(r,"docs","swap"),m=join(r,"docs","swap-real"),o=join(r,"outside");await mkdir(join(c,".git"),{recursive:true});await mkdir(join(w,"plans"),{recursive:true});await mkdir(o,{recursive:true});const tool=await registerPlugin(r),q=await tool.execute("q",{action:"request_plan",project:"swap",projectRoot:c,projectWikiPath:w}),ready=join(r,"ready");process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WRITE_READY_FILE=ready;process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WRITE_DELAY_MS="300";const pending=tool.execute("r",{action:"record_plan",project:"swap",runId:q.details.runId,projectRoot:c,projectWikiPath:w,planText:"# Implementation plan\n\n## Project paths\n- x\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- x\n",force:true});for(let i=0;i<100;i++){try{await access(ready);break}catch{}await new Promise(x=>setTimeout(x,10))}await access(ready);await rename(w,m);await symlink(o,w);const z=await pending;assert.equal(z.details.ok,true,JSON.stringify(z.details));assert.deepEqual(await readdir(o),[]);assert.ok(z.details.canonicalPlan?.startsWith(m+"/plans/"),JSON.stringify(z.details));await access(z.details.canonicalPlan)});

test("configured projectsWikiRoot may be a symlink", async (t) => {
  const root = join(tmpdir(), `ocl-rootlink-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => { delete process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_GIT_ROOT; });
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_GIT_ROOT = root;
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Path Guard Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "pathguard@example.invalid"]);
  await writeFile(join(root, ".gitignore"), "state/\ncode/\n");
  execFileSync("git", ["-C", root, "add", ".gitignore"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
  const realDocs = join(root, "real-docs");
  await mkdir(realDocs, { recursive: true });
  await symlink(realDocs, join(root, "docs"));
  const code = join(root, "code");
  await mkdir(join(code, ".git"), { recursive: true });
  const tool = await registerPlugin(root);
  const req = await tool.execute("rl-1", { action: "request_plan", project: "rootlink", projectRoot: code });
  const rec = await tool.execute("rl-2", { action: "record_plan", project: "rootlink", runId: req.details.runId, projectRoot: code, planText: "# Implementation plan\n\n## Project paths\n- x\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- x\n", force: true });
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
  assert.ok(rec.details.canonicalPlan?.startsWith(realDocs + "/"), JSON.stringify(rec.details));
  await access(rec.details.canonicalPlan);
  assert.equal(rec.details.canonicalPlanGit?.ok, true, JSON.stringify(rec.details.canonicalPlanGit));
  assert.equal(rec.details.canonicalPlanGit?.skipped, false, JSON.stringify(rec.details.canonicalPlanGit));
  const committed = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
  assert.match(committed, /real-docs\/rootlink\/plans\/.*implementation-plan\.md/);
});

test("concurrent writers tolerate EEXIST while creating plans directory", async (t) => {
  const root = join(tmpdir(), `ocl-eexist-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = join(root, "code");
  await mkdir(join(code, ".git"), { recursive: true });
  const shared = join(root, "docs", "shared");
  const tool = await registerPlugin(root);
  const q1 = await tool.execute("e-1", { action: "request_plan", project: "e1", projectRoot: code });
  const q2 = await tool.execute("e-2", { action: "request_plan", project: "e2", projectRoot: code });
  const body = "# Implementation plan\n\n## Project paths\n- x\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- x\n";
  const [a, b] = await Promise.all([
    tool.execute("e-3", { action: "record_plan", project: "e1", runId: q1.details.runId, projectRoot: code, projectWikiPath: shared, planText: body, force: true }),
    tool.execute("e-4", { action: "record_plan", project: "e2", runId: q2.details.runId, projectRoot: code, projectWikiPath: shared, planText: body, force: true }),
  ]);
  assert.equal(a.details.ok, true, JSON.stringify(a.details));
  assert.equal(b.details.ok, true, JSON.stringify(b.details));
  await access(a.details.canonicalPlan);
  await access(b.details.canonicalPlan);
});

test("start_implementation rejects outside planPath even with inline planText", async (t) => {
  const root = join(tmpdir(), `ocl-inline-plan-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = join(root, "code");
  const outside = join(root, "outside");
  await mkdir(join(code, ".git"), { recursive: true });
  await mkdir(outside, { recursive: true });
  const externalPlan = join(outside, "external.md");
  await writeFile(externalPlan, "# external\n");
  const tool = await registerPlugin(root);
  const req = await tool.execute("inline-1", { action: "request_plan", project: "inline", projectRoot: code });
  const rec = await tool.execute("inline-2", { action: "record_plan", project: "inline", runId: req.details.runId, projectRoot: code, planText: "# Implementation plan\n\n## Project paths\n- x\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- x\n", force: true });
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
  const started = await tool.execute("inline-3", { action: "start_implementation", project: "inline", runId: req.details.runId, projectRoot: code, planText: "approved inline", planPath: externalPlan });
  assert.equal(started.details.ok, false, JSON.stringify(started.details));
  assert.equal(started.details.error, "plan_path_outside_allowed_roots");
});

test("start_implementation rejects symlinked wiki handoff with inline planText", async (t) => {
  const root = join(tmpdir(), `ocl-inline-wiki-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = join(root, "code");
  const wiki = join(root, "docs", "inline-wiki");
  const outside = join(root, "outside");
  await mkdir(join(code, ".git"), { recursive: true });
  await mkdir(wiki, { recursive: true });
  await mkdir(outside, { recursive: true });
  const link = join(wiki, "escape");
  await symlink(outside, link);
  const tool = await registerPlugin(root);
  const req = await tool.execute("wiki-1", { action: "request_plan", project: "inline-wiki", projectRoot: code, projectWikiPath: wiki });
  const rec = await tool.execute("wiki-2", { action: "record_plan", project: "inline-wiki", runId: req.details.runId, projectRoot: code, projectWikiPath: wiki, planText: "# Implementation plan\n\n## Project paths\n- x\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- x\n", force: true });
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
  const started = await tool.execute("wiki-3", { action: "start_implementation", project: "inline-wiki", runId: req.details.runId, projectRoot: code, projectWikiPath: link, planText: "approved inline" });
  assert.equal(started.details.ok, false, JSON.stringify(started.details));
  assert.equal(started.details.error, "project_wiki_path_outside_allowed_root");
});

test("planning pack reads stay pinned across concurrent wiki parent swap", async (t) => {
  const root = join(tmpdir(), `ocl-read-swap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => { delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_READ_READY_FILE; delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_READ_DELAY_MS; });
  const code = join(root, "code");
  const wiki = join(root, "docs", "read-swap");
  const moved = join(root, "docs", "read-swap-real");
  const outside = join(root, "outside");
  const ready = join(root, "read-ready");
  await mkdir(join(code, ".git"), { recursive: true });
  await mkdir(wiki, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(wiki, "README.md"), "SAFE_PINNED_WIKI\n");
  await writeFile(join(outside, "README.md"), "SECRET_SWAP_LEAK\n");
  const tool = await registerPlugin(root);
  process.env.DEVELOPMENT_CYCLE_TEST_PINNED_READ_READY_FILE = ready;
  process.env.DEVELOPMENT_CYCLE_TEST_PINNED_READ_DELAY_MS = "300";
  const pending = tool.execute("swap-read-1", { action: "request_plan", project: "read-swap", projectRoot: code, projectWikiPath: wiki });
  let signaled = false;
  for (let i = 0; i < 100; i++) {
    try { await access(ready); signaled = true; break; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.equal(signaled, true, "planning-pack read did not reach pinned hook");
  await rename(wiki, moved);
  await symlink(outside, wiki);
  const req = await pending;
  assert.equal(req.details.ok, true, JSON.stringify(req.details));
  const pack = await readFile(join(req.details.dir, "context_pack.md"), "utf8");
  assert.match(pack, /SAFE_PINNED_WIKI/);
  assert.doesNotMatch(pack, /SECRET_SWAP_LEAK/);
});


test("exact broad project roots are rejected while ordinary descendants remain eligible", async () => {
  const { isExactBroadProjectRoot } = await import(`../dist/index.js?broadroots=${Date.now()}-${Math.random()}`);
  for (const root of ["/home", "/root", "/opt", "/srv"]) assert.equal(isExactBroadProjectRoot(root), true, root);
  for (const child of ["/home/project", "/root/project", "/opt/openclaw/app", "/srv/project"]) assert.equal(isExactBroadProjectRoot(child), false, child);
});

test("allowed read roots stay pinned across concurrent projectRoot replacement", async (t) => {
  const root = join(tmpdir(), `ocl-allowed-read-swap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_ALLOWED_READ_READY_FILE;
    delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_ALLOWED_READ_DELAY_MS;
  });
  const code = join(root, "code");
  const moved = join(root, "code-real");
  const outside = join(root, "outside");
  const ready = join(root, "allowed-read-ready");
  const planName = "approved-plan.md";
  const safePlan = "# SAFE_PINNED_PLAN\n\n## Project paths\n- code\n\n## Tasks\n1. safe\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- safe\n";
  const evilPlan = "# SECRET_SWAP_PLAN\n\n## Project paths\n- outside\n\n## Tasks\n1. evil\n\n## Validation checks\n- false\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- evil\n";
  await mkdir(join(code, ".git"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(code, planName), safePlan);
  await writeFile(join(outside, planName), evilPlan);

  const tool = await registerPlugin(root);
  const req = await tool.execute("allowed-read-1", { action: "request_plan", project: "allowed-read", projectRoot: code });
  assert.equal(req.details.ok, true, JSON.stringify(req.details));

  process.env.DEVELOPMENT_CYCLE_TEST_PINNED_ALLOWED_READ_READY_FILE = ready;
  process.env.DEVELOPMENT_CYCLE_TEST_PINNED_ALLOWED_READ_DELAY_MS = "300";
  const pending = tool.execute("allowed-read-2", {
    action: "record_plan",
    project: "allowed-read",
    runId: req.details.runId,
    projectRoot: code,
    planPath: join(code, planName),
    force: true,
  });
  let signaled = false;
  for (let i = 0; i < 100; i++) {
    try { await access(ready); signaled = true; break; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.equal(signaled, true, "allowed read did not reach pinned-root hook");
  await rename(code, moved);
  await symlink(outside, code);
  const rec = await pending;
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
  const stored = await readFile(rec.details.plan, "utf8");
  assert.match(stored, /SAFE_PINNED_PLAN/);
  assert.doesNotMatch(stored, /SECRET_SWAP_PLAN/);
});

test("stable root open fails closed when projectRoot is swapped before open", async (t) => {
  const root = join(tmpdir(), `ocl-stable-root-swap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.DEVELOPMENT_CYCLE_TEST_STABLE_ROOT_READY_FILE;
    delete process.env.DEVELOPMENT_CYCLE_TEST_STABLE_ROOT_DELAY_MS;
  });
  const code = join(root, "code");
  const moved = join(root, "code-real");
  const outside = join(root, "outside");
  const ready = join(root, "stable-root-ready");
  await mkdir(join(code, ".git"), { recursive: true });
  await mkdir(join(outside, ".git"), { recursive: true });
  await writeFile(join(code, "plan.md"), "SAFE_STABLE_ROOT\n");
  await writeFile(join(outside, "plan.md"), "SECRET_STABLE_ROOT_SWAP\n");
  const tool = await registerPlugin(root);
  const req = await tool.execute("stable-root-1", { action: "request_plan", project: "stable-root", projectRoot: code });
  assert.equal(req.details.ok, true, JSON.stringify(req.details));

  process.env.DEVELOPMENT_CYCLE_TEST_STABLE_ROOT_READY_FILE = ready;
  process.env.DEVELOPMENT_CYCLE_TEST_STABLE_ROOT_DELAY_MS = "300";
  const pending = tool.execute("stable-root-2", {
    action: "record_plan",
    project: "stable-root",
    runId: req.details.runId,
    projectRoot: code,
    planPath: join(code, "plan.md"),
    force: true,
  });
  let signaled = false;
  for (let i = 0; i < 100; i++) {
    try { await access(ready); signaled = true; break; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.equal(signaled, true, "stable-root hook did not fire");
  await rename(code, moved);
  await symlink(outside, code);
  const rec = await pending;
  assert.equal(rec.details.ok, false, JSON.stringify(rec.details));
  assert.equal(rec.details.error, "plan_path_outside_allowed_roots");
  const cyclePlan = join(req.details.dir, "implementation_plan.md");
  const stored = await readFile(cyclePlan, "utf8").catch(() => "");
  assert.doesNotMatch(stored, /SECRET_STABLE_ROOT_SWAP/);
});

test("fresh docs root creation stays on pinned parent across concurrent swap", async (t) => {
  const root = join(tmpdir(), `ocl-create-root-swap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_CREATE_READY_FILE;
    delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_CREATE_DELAY_MS;
  });
  const parent = join(root, "parent");
  const moved = join(root, "parent-real");
  const outside = join(root, "outside");
  const code = join(root, "code");
  const docs = join(parent, "docs");
  const ready = join(root, "create-ready");
  await mkdir(parent, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(join(code, ".git"), { recursive: true });

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = docs;
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";
  const { default: plugin } = await import(`../dist/index.js?create-root=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(t) { tool = t; } });

  process.env.DEVELOPMENT_CYCLE_TEST_PINNED_CREATE_READY_FILE = ready;
  process.env.DEVELOPMENT_CYCLE_TEST_PINNED_CREATE_DELAY_MS = "300";
  const pending = tool.execute("create-root-1", { action: "request_plan", project: "create-root", projectRoot: code, projectWikiPath: join(docs, "create-root") });
  let signaled = false;
  for (let i = 0; i < 100; i++) {
    try { await access(ready); signaled = true; break; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.equal(signaled, true, "pinned-create hook did not fire");
  await rename(parent, moved);
  await symlink(outside, parent);
  const req = await pending;
  assert.equal(req.details.ok, true, JSON.stringify(req.details));
  assert.deepEqual(await readdir(outside), []);
  await access(join(moved, "docs", "create-root"));
});

test("stable root open fails closed when a projectRoot parent is swapped before open", async (t) => {
  const root = join(tmpdir(), `ocl-stable-parent-swap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.DEVELOPMENT_CYCLE_TEST_STABLE_ROOT_READY_FILE;
    delete process.env.DEVELOPMENT_CYCLE_TEST_STABLE_ROOT_DELAY_MS;
  });
  const parent = join(root, "parent");
  const moved = join(root, "parent-real");
  const code = join(parent, "code");
  const outsideParent = join(root, "outside-parent");
  const outsideCode = join(outsideParent, "code");
  const ready = join(root, "stable-parent-ready");
  await mkdir(join(code, ".git"), { recursive: true });
  await mkdir(join(outsideCode, ".git"), { recursive: true });
  await writeFile(join(code, "plan.md"), "SAFE_PARENT_PIN\n");
  await writeFile(join(outsideCode, "plan.md"), "SECRET_PARENT_SWAP\n");
  const tool = await registerPlugin(root);
  const req = await tool.execute("stable-parent-1", { action: "request_plan", project: "stable-parent", projectRoot: code });
  assert.equal(req.details.ok, true, JSON.stringify(req.details));

  process.env.DEVELOPMENT_CYCLE_TEST_STABLE_ROOT_READY_FILE = ready;
  process.env.DEVELOPMENT_CYCLE_TEST_STABLE_ROOT_DELAY_MS = "300";
  const pending = tool.execute("stable-parent-2", {
    action: "record_plan",
    project: "stable-parent",
    runId: req.details.runId,
    projectRoot: code,
    planPath: join(code, "plan.md"),
    force: true,
  });
  let signaled = false;
  for (let i = 0; i < 100; i++) {
    try { await access(ready); signaled = true; break; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.equal(signaled, true, "stable-root hook did not fire");
  await rename(parent, moved);
  await symlink(outsideParent, parent);
  const rec = await pending;
  assert.equal(rec.details.ok, false, JSON.stringify(rec.details));
  assert.equal(rec.details.error, "plan_path_outside_allowed_roots");
  const stored = await readFile(join(req.details.dir, "implementation_plan.md"), "utf8").catch(() => "");
  assert.doesNotMatch(stored, /SECRET_PARENT_SWAP/);
});


test("start_implementation keeps wiki root pinned between containment and plan read", async (t) => {
  const root = join(tmpdir(), `ocl-wiki-handoff-swap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WIKI_HANDOFF_READY_FILE;
    delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WIKI_HANDOFF_DELAY_MS;
  });
  const code = join(root, "code");
  const wiki = join(root, "docs", "wiki-handoff");
  const moved = join(root, "docs", "wiki-handoff-real");
  const outside = join(root, "outside");
  const ready = join(root, "wiki-handoff-ready");
  const planName = "handoff-plan.md";
  await mkdir(join(code, ".git"), { recursive: true });
  await mkdir(wiki, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(wiki, planName), "# SAFE_WIKI_HANDOFF_PLAN\n");
  await writeFile(join(outside, planName), "# SECRET_WIKI_HANDOFF_SWAP\n");

  const tool = await registerPlugin(root);
  const req = await tool.execute("wiki-handoff-1", { action: "request_plan", project: "wiki-handoff", projectRoot: code, projectWikiPath: wiki });
  assert.equal(req.details.ok, true, JSON.stringify(req.details));
  const rec = await tool.execute("wiki-handoff-plan", {
    action: "record_plan",
    project: "wiki-handoff",
    runId: req.details.runId,
    projectRoot: code,
    projectWikiPath: wiki,
    planText: "# Implementation plan\n\n## Project paths\n- code\n- wiki\n\n## Tasks\n1. safe\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- safe\n",
    force: true,
  });
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
  process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WIKI_HANDOFF_READY_FILE = ready;
  process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WIKI_HANDOFF_DELAY_MS = "300";
  const pending = tool.execute("wiki-handoff-2", {
    action: "start_implementation",
    project: "wiki-handoff",
    runId: req.details.runId,
    projectRoot: code,
    projectWikiPath: wiki,
    planPath: join(wiki, planName),
  });
  let signaled = false;
  for (let i = 0; i < 100; i++) {
    try { await access(ready); signaled = true; break; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.equal(signaled, true, "wiki handoff did not reach pinned-root hook");
  await rename(wiki, moved);
  await symlink(outside, wiki);
  await pending;
  const request = await readFile(join(req.details.dir, "implementation_request.md"), "utf8");
  assert.match(request, /SAFE_WIKI_HANDOFF_PLAN/);
  assert.doesNotMatch(request, /SECRET_WIKI_HANDOFF_SWAP/);
});


test("validation config stays pinned after projectRoot validation", async (t) => {
  const root = join(tmpdir(), `ocl-pcfg-root-swap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_PROJECT_ROOT_READ_READY_FILE;
    delete process.env.DEVELOPMENT_CYCLE_TEST_PINNED_PROJECT_ROOT_READ_DELAY_MS;
  });
  const code = join(root, "code");
  const moved = join(root, "code-real");
  const outside = join(root, "outside");
  const ready = join(root, "project-root-read-ready");
  const validationPath = join(code, "validation.json");
  await mkdir(join(code, ".git"), { recursive: true });
  await mkdir(join(outside, ".git"), { recursive: true });
  await writeFile(validationPath, JSON.stringify({ commands: ["true"], preserveDiff: false, commandTimeoutMs: 11111 }));
  await writeFile(join(outside, "validation.json"), JSON.stringify({ commands: ["true"], preserveDiff: false, commandTimeoutMs: 22222 }));

  const tool = await registerPlugin(root);
  const req = await tool.execute("pcfg-race-1", { action: "request_plan", project: "pcfg-race", projectRoot: code });
  assert.equal(req.details.ok, true, JSON.stringify(req.details));
  const rec = await tool.execute("pcfg-race-2", {
    action: "record_plan",
    project: "pcfg-race",
    runId: req.details.runId,
    projectRoot: code,
    planText: "# Implementation plan\n\n## Project paths\n- x\n\n## Tasks\n1. x\n\n## Validation checks\n- true\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- x\n",
    force: true,
  });
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
  const statusPath = join(req.details.dir, "status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  status.phase = "implementation_delivered";
  await writeFile(statusPath, JSON.stringify(status));

  process.env.DEVELOPMENT_CYCLE_TEST_PINNED_PROJECT_ROOT_READ_READY_FILE = ready;
  process.env.DEVELOPMENT_CYCLE_TEST_PINNED_PROJECT_ROOT_READ_DELAY_MS = "300";
  const pending = tool.execute("pcfg-race-3", {
    action: "run_final_validation",
    project: "pcfg-race",
    runId: req.details.runId,
    projectRoot: code,
    validationConfigPath: validationPath,
  });
  let signaled = false;
  for (let i = 0; i < 100; i++) {
    try { await access(ready); signaled = true; break; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.equal(signaled, true, "projectRoot config read did not reach pinned-root hook");
  await rename(code, moved);
  await symlink(outside, code);

  const result = await pending;
  const validation = JSON.parse(await readFile(result.details.validationResult, "utf8"));
  assert.equal(validation.config.commandTimeoutMs, 11111, JSON.stringify(validation.config));
  assert.notEqual(validation.config.commandTimeoutMs, 22222, JSON.stringify(validation.config));
});


test("run_final_validation fails closed for a non-Git projectRoot", async (t) => {
  const root = join(tmpdir(), `ocl-validation-nongit-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = join(root, "code");
  const marker = join(code, "MALICIOUS_RAN");
  await mkdir(code, { recursive: true });
  await writeFile(join(code, "package.json"), JSON.stringify({
    name: "nongit-malicious",
    scripts: { test: "node -e \"require('fs').writeFileSync('MALICIOUS_RAN','yes')\"" },
  }));

  const tool = await registerPlugin(root);
  const req = await tool.execute("nongit-1", { action: "request_plan", project: "nongit-validation", projectRoot: code });
  assert.equal(req.details.ok, true, JSON.stringify(req.details));
  const rec = await tool.execute("nongit-2", {
    action: "record_plan",
    project: "nongit-validation",
    runId: req.details.runId,
    projectRoot: code,
    planText: "# Implementation plan\n\n## Project paths\n- code\n\n## Tasks\n1. x\n\n## Validation checks\n- npm test\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- none\n",
    force: true,
  });
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
  const statusPath = join(req.details.dir, "status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  status.phase = "implementation_delivered";
  await writeFile(statusPath, JSON.stringify(status));

  const result = await tool.execute("nongit-3", {
    action: "run_final_validation",
    project: "nongit-validation",
    runId: req.details.runId,
    projectRoot: code,
  });
  assert.equal(result.details.ok, false, JSON.stringify(result.details));
  assert.equal(result.details.decision, "stop", JSON.stringify(result.details));
  assert.match(JSON.stringify(result.details.failures), /trusted Git checkout/);
  await assert.rejects(access(marker));
});

test("run_final_validation keeps the checkout pinned after config load", async (t) => {
  const root = join(tmpdir(), `ocl-validation-root-swap-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.DEVELOPMENT_CYCLE_TEST_VALIDATION_ROOT_READY_FILE;
    delete process.env.DEVELOPMENT_CYCLE_TEST_VALIDATION_ROOT_DELAY_MS;
  });
  const code = join(root, "code");
  const moved = join(root, "code-real");
  const outside = join(root, "outside");
  const ready = join(root, "validation-root-ready");
  await mkdir(code, { recursive: true });
  await mkdir(outside, { recursive: true });
  execFileSync("git", ["init", "-q", code]);
  execFileSync("git", ["init", "-q", outside]);
  await writeFile(join(code, "validation.json"), JSON.stringify({ commands: "auto", preserveDiff: false }));
  await writeFile(join(outside, "validation.json"), JSON.stringify({ commands: "auto", preserveDiff: false }));
  await writeFile(join(code, "package.json"), JSON.stringify({
    name: "safe-checkout",
    scripts: { test: "node -e \"require('fs').writeFileSync('SAFE_VALIDATION_RAN','safe')\"" },
  }));
  await writeFile(join(outside, "package.json"), JSON.stringify({
    name: "evil-checkout",
    scripts: { test: "node -e \"require('fs').writeFileSync('EVIL_VALIDATION_RAN','evil')\"" },
  }));

  const tool = await registerPlugin(root);
  const req = await tool.execute("vswap-1", { action: "request_plan", project: "validation-swap", projectRoot: code });
  assert.equal(req.details.ok, true, JSON.stringify(req.details));
  const rec = await tool.execute("vswap-2", {
    action: "record_plan",
    project: "validation-swap",
    runId: req.details.runId,
    projectRoot: code,
    planText: "# Implementation plan\n\n## Project paths\n- code\n\n## Tasks\n1. x\n\n## Validation checks\n- npm test\n\n## Stop conditions\n- none\n\n## Expected artifacts\n- SAFE_VALIDATION_RAN\n",
    force: true,
  });
  assert.equal(rec.details.ok, true, JSON.stringify(rec.details));
  const statusPath = join(req.details.dir, "status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  status.phase = "implementation_delivered";
  await writeFile(statusPath, JSON.stringify(status));

  process.env.DEVELOPMENT_CYCLE_TEST_VALIDATION_ROOT_READY_FILE = ready;
  process.env.DEVELOPMENT_CYCLE_TEST_VALIDATION_ROOT_DELAY_MS = "300";
  const pending = tool.execute("vswap-3", {
    action: "run_final_validation",
    project: "validation-swap",
    runId: req.details.runId,
    projectRoot: code,
    validationConfigPath: join(code, "validation.json"),
  });
  let signaled = false;
  for (let i = 0; i < 100; i++) {
    try { await access(ready); signaled = true; break; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.equal(signaled, true, "validation did not reach post-config pinned-root hook");
  await rename(code, moved);
  await symlink(outside, code);

  const result = await pending;
  assert.ok(result.details.commandResults.some((r) => r.command === "npm test"), JSON.stringify(result.details));
  assert.equal(await readFile(join(moved, "SAFE_VALIDATION_RAN"), "utf8"), "safe");
  await assert.rejects(access(join(outside, "EVIL_VALIDATION_RAN")));
  await assert.rejects(access(join(outside, "SAFE_VALIDATION_RAN")));
});

// --- NFC/NFD containment semantics (from fix/pathwithin-nfc-normalize) ---
import { pathWithin } from "../dist/core/paths.js";
const NFC = "caf\u00e9";
const NFD = "cafe\u0301";
function codes(name) {
  return [...String(name)].map((c) => c.codePointAt(0).toString(16)).join(" ");
}
async function sameEntry(left, right) {
  try {
    const a = await stat(left);
    const b = await stat(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
test("pathWithin accepts the same existing entry across NFC/NFD only when inodes match", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dc-path-same-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nfcDir = join(root, NFC);
  const nfdDir = join(root, NFD);
  await mkdir(nfcDir);

  assert.equal(pathWithin(nfcDir, nfcDir), true);
  assert.equal(NFC.normalize("NFC"), NFD.normalize("NFC"));

  const unified = await sameEntry(nfcDir, nfdDir);
  assert.equal(
    pathWithin(nfcDir, nfdDir),
    unified,
    `same-entry nfc=[${codes(NFC)}] nfd=[${codes(NFD)}] unified=${unified}`,
  );
  if (unified) {
    const child = join(nfdDir, "plans");
    assert.equal(pathWithin(nfcDir, child), true, "macOS-style same inode must accept NFD child");
  } else {
    assert.equal(await exists(nfdDir), false, "Linux must not treat a missing NFD alias as the NFC entry");
  }
});
