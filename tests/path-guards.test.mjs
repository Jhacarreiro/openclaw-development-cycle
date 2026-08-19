import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { pathWithin } from "../dist/core/paths.js";

const NFC = "caf\u00e9";
const NFD = "cafe\u0301";
const PLAN_BODY = `# Implementation plan

## Project paths
- projectRoot
- projectWikiPath

## Ordered implementation tasks
1. x

## Validation checks
- npm test

## Stop conditions
- none

## Expected artifacts
- file
`;

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

async function registerPlugin(root, docsRoot = join(root, "docs")) {
  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = docsRoot;
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

async function recordPlan(tool, { project, projectRoot, projectWikiPath, runId }) {
  if (!runId) {
    const planReq = await tool.execute(
      `req-${project}`,
      { action: "request_plan", project, projectRoot, projectWikiPath, direction: "path guard" },
      undefined,
      undefined,
    );
    assert.equal(planReq.details.ok, true, JSON.stringify(planReq.details));
    runId = planReq.details.runId;
  }
  const recorded = await tool.execute(
    `rec-${project}`,
    {
      action: "record_plan",
      project,
      runId,
      projectRoot,
      projectWikiPath,
      planText: PLAN_BODY,
      force: true,
    },
    undefined,
    undefined,
  );
  return recorded.details;
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

test("pathWithin rejects distinct NFC/NFD siblings and their children", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dc-path-sib-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nfcDir = join(root, NFC);
  const nfdDir = join(root, NFD);
  await mkdir(nfcDir);
  try {
    await mkdir(nfdDir);
  } catch (err) {
    if (await sameEntry(nfcDir, nfdDir)) {
      t.skip("filesystem unifies NFC/NFD names; distinct-sibling case does not exist here");
      return;
    }
    throw err;
  }

  const nfcStat = await stat(nfcDir);
  const nfdStat = await stat(nfdDir);
  assert.notEqual(nfcStat.ino, nfdStat.ino, `expected distinct inodes; nfc=${nfcStat.ino} nfd=${nfdStat.ino}`);
  assert.equal(pathWithin(nfcDir, nfdDir), false, `sibling nfc=[${codes(NFC)}] nfd=[${codes(NFD)}]`);
  assert.equal(pathWithin(nfcDir, join(nfdDir, "plans")), false);
  assert.equal(pathWithin(nfdDir, nfcDir), false);
});

test("pathWithin rejects traversal even when NFC-normalized strings look contained", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dc-path-trav-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nfcDir = join(root, NFC);
  const outside = join(root, "outside");
  await mkdir(nfcDir);
  await mkdir(outside);
  assert.equal(pathWithin(nfcDir, join(nfcDir, "..", "outside")), false);
  assert.equal(pathWithin(nfcDir, join(nfcDir, "..", NFD)), false);
  assert.equal(pathWithin(nfcDir, join(nfcDir, "..")), false);
  assert.equal(pathWithin(nfcDir, "/"), false);
  assert.equal(pathWithin("", nfcDir), false);
  assert.equal(pathWithin(nfcDir, ""), false);
});

describe("persistApprovedPlan destination", { concurrency: false }, () => {
test("record_plan writes the final plan under the real wiki dest, not a Unicode sibling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dc-path-dest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = join(root, "docs");
  const wiki = join(docs, "fixture");
  const code = join(root, "code");
  await mkdir(wiki, { recursive: true });
  await mkdir(code, { recursive: true });

  const tool = await registerPlugin(root, docs);
  const details = await recordPlan(tool, { project: "fixture", projectRoot: code, projectWikiPath: wiki });
  assert.equal(details.ok, true, JSON.stringify(details));
  assert.ok(details.canonicalPlan, JSON.stringify(details));
  const realWiki = await realpath(wiki);
  const realPlan = await realpath(details.canonicalPlan);
  assert.equal(realPlan.startsWith(`${realWiki}/plans/`), true, realPlan);
  assert.match(realPlan, /implementation-plan\.md$/);
  const written = await readFile(realPlan, "utf8");
  assert.match(written, /Implementation plan/);
  const names = await readdir(docs);
  assert.deepEqual(names.filter((name) => name.normalize("NFC") === NFC.normalize("NFC")), []);
});

test("record_plan does not create or write an NFD sibling of the write root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dc-path-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docsParent = join(root, "parent");
  const nfcRoot = join(docsParent, NFC);
  const nfdRoot = join(docsParent, NFD);
  const code = join(root, "code");
  await mkdir(nfcRoot, { recursive: true });
  await mkdir(code, { recursive: true });

  const tool = await registerPlugin(root, nfcRoot);
  const details = await recordPlan(tool, {
    project: "unicode-root",
    projectRoot: code,
    projectWikiPath: nfdRoot,
  });
  assert.equal(details.ok, true, JSON.stringify(details));

  const unified = await sameEntry(nfcRoot, nfdRoot);
  if (unified) {
    assert.ok(details.canonicalPlan, "same-entry NFD spelling must persist into the existing wiki dir");
    const realPlan = await realpath(details.canonicalPlan);
    const realRoot = await realpath(nfcRoot);
    assert.equal(realPlan.startsWith(`${realRoot}/plans/`), true, realPlan);
  } else {
    assert.equal(details.canonicalPlan, null, JSON.stringify(details));
    assert.equal(await exists(nfdRoot), false, `must not create NFD alias [${codes(NFD)}]`);
    const nfcPlans = join(nfcRoot, "plans");
    assert.equal(await exists(nfcPlans), false, "rejected NFD alias must not write into the NFC root either");
  }
});

test("record_plan rejects a distinct NFC/NFD sibling write root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dc-path-dsib-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docsParent = join(root, "parent");
  const nfcRoot = join(docsParent, NFC);
  const nfdRoot = join(docsParent, NFD);
  const code = join(root, "code");
  await mkdir(nfcRoot, { recursive: true });
  try {
    await mkdir(nfdRoot);
  } catch (err) {
    if (await sameEntry(nfcRoot, nfdRoot)) {
      t.skip("filesystem unifies NFC/NFD names; distinct-sibling case does not exist here");
      return;
    }
    throw err;
  }
  await mkdir(code, { recursive: true });

  const tool = await registerPlugin(root, nfcRoot);
  const details = await recordPlan(tool, {
    project: "unicode-sib",
    projectRoot: code,
    projectWikiPath: nfdRoot,
  });
  assert.equal(details.ok, true, JSON.stringify(details));
  assert.equal(details.canonicalPlan, null, JSON.stringify(details));
  assert.equal(await exists(join(nfdRoot, "plans")), false, `leaked into NFD sibling [${codes(NFD)}]`);
  assert.equal(await exists(join(nfcRoot, "plans")), false);
});

test("record_plan rejects traversal outside the write root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dc-path-esc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = join(root, "docs");
  const outside = join(root, "outside");
  const code = join(root, "code");
  await mkdir(docs, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(code, { recursive: true });

  const tool = await registerPlugin(root, docs);
  const details = await recordPlan(tool, {
    project: "traverse",
    projectRoot: code,
    projectWikiPath: join(docs, "..", "outside"),
  });
  assert.equal(details.ok, true, JSON.stringify(details));
  assert.equal(details.canonicalPlan, null, JSON.stringify(details));
  assert.equal(await exists(join(outside, "plans")), false);
});

test("record_plan rejects a wiki dir that is a symlink leaving the write root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dc-path-sym-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = join(root, "docs");
  const outside = join(root, "outside-target");
  const code = join(root, "code");
  await mkdir(docs, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(code, { recursive: true });
  const escape = join(docs, "escape-dir");
  await symlink(outside, escape);

  const tool = await registerPlugin(root, docs);
  const details = await recordPlan(tool, {
    project: "symlink",
    projectRoot: code,
    projectWikiPath: escape,
  });
  assert.equal(details.ok, true, JSON.stringify(details));
  assert.equal(details.canonicalPlan, null, JSON.stringify(details));
  assert.equal(await exists(join(outside, "plans")), false, `symlink write escaped to ${outside}`);
  assert.equal(await exists(join(escape, "plans")), false);
});
});
