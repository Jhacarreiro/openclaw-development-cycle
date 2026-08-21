import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const runner = resolve("scripts/github-delivery-runner.mjs");

async function fixture(status = " M src/app.ts\n") {
  const root = await mkdtemp(join(tmpdir(), "dc-delivery-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const state = join(root, "state");
  await mkdir(bin); await mkdir(repo); await mkdir(join(repo, ".git")); await mkdir(state);
  const git = `#!/usr/bin/env node
const fs=require("fs"), a=process.argv.slice(2), d=process.env.TEST_STATE_DIR;
fs.appendFileSync(d+"/git.log",JSON.stringify(a)+"\\n");
if(a[0]==="status") process.stdout.write(process.env.TEST_GIT_STATUS||"");
else if(a[0]==="branch") process.stdout.write(process.env.TEST_BRANCH||"feat/test");
else if(a[0]==="diff"&&a.includes("--cached")) process.stdout.write("src/app.ts\\n");
else if(a[0]==="rev-parse") process.stdout.write("abc123def456\\n");
`;
  const gh = `#!/usr/bin/env node
const fs=require("fs"), a=process.argv.slice(2), d=process.env.TEST_STATE_DIR;
fs.appendFileSync(d+"/gh.log",JSON.stringify(a)+"\\n");
if(a[0]==="repo") process.stdout.write("acme/demo\\n");
else if(a[0]==="pr"&&a[1]==="view") {
  if(!fs.existsSync(d+"/pr")) process.exit(1);
  const merged=process.env.TEST_PR_MERGED==="1";
  process.stdout.write(JSON.stringify({number:42,url:"https://github.test/acme/demo/pull/42",state:merged?"MERGED":"OPEN",mergedAt:merged?"2026-08-20T17:00:00Z":null}));
} else if(a[0]==="pr"&&a[1]==="create") {
  fs.writeFileSync(d+"/pr","1");
  process.stdout.write("https://github.test/acme/demo/pull/42\\n");
} else if(a[0]==="issue"&&a[1]==="list") process.stdout.write("[]");
else if(a[0]==="issue"&&a[1]==="create") {
  let n=100; try{n=Number(fs.readFileSync(d+"/issue-n","utf8"))}catch{}
  n++; fs.writeFileSync(d+"/issue-n",String(n));
  process.stdout.write("https://github.test/acme/demo/issues/"+n+"\\n");
}
`;
  await writeFile(join(bin, "git"), git); await chmod(join(bin, "git"), 0o755);
  await writeFile(join(bin, "gh"), gh); await chmod(join(bin, "gh"), 0o755);
  return { root, bin, repo, state, status };
}

async function runFixture(f, request, extraEnv = {}) {
  const requestPath = join(f.root, "request.json");
  await writeFile(requestPath, JSON.stringify({ project:"demo", runId:"run-1", projectRoot:f.repo, baseBranch:"main", ...request }));
  const env = { ...process.env, PATH:`${f.bin}:${process.env.PATH}`, TEST_STATE_DIR:f.state, TEST_GIT_STATUS:f.status, TEST_BRANCH:"feat/test", ...extraEnv };
  const stdout = execFileSync(process.execPath, [runner, requestPath], { encoding:"utf8", env });
  return JSON.parse(stdout);
}

test("partial delivery opens normal PR and residual issues without merge", async () => {
  const f = await fixture();
  const out = await runFixture(f, { classification:"partial", autoMerge:false, findings:["race condition","port mismatch"] });
  assert.equal(out.ok, true);
  assert.equal(out.pullRequest.number, 42);
  assert.equal(out.issues.length, 2);
  assert.equal(out.mergeQueued, false);
  const gh = await readFile(join(f.state, "gh.log"), "utf8");
  assert.match(gh, /"pr","create"/);
  assert.match(gh, /"issue","create"/);
  assert.doesNotMatch(gh, /"pr","merge"/);
});

test("successful delivery queues GitHub auto-merge", async () => {
  const f = await fixture();
  const out = await runFixture(f, { classification:"success", autoMerge:true, findings:[] });
  assert.equal(out.ok, true);
  assert.equal(out.issues.length, 0);
  assert.equal(out.mergeQueued, true);
  const gh = await readFile(join(f.state, "gh.log"), "utf8");
  assert.match(gh, /"pr","merge"/);
  assert.match(gh, /"--auto"/);
});

test("delivery runner refuses sensitive changed paths", async () => {
  const f = await fixture(" M .env\n");
  const requestPath = join(f.root, "request.json");
  await writeFile(requestPath, JSON.stringify({ project:"demo", runId:"run-1", projectRoot:f.repo, baseBranch:"main", classification:"partial", autoMerge:false, findings:[] }));
  const env = { ...process.env, PATH:`${f.bin}:${process.env.PATH}`, TEST_STATE_DIR:f.state, TEST_GIT_STATUS:f.status, TEST_BRANCH:"feat/test" };
  assert.throws(() => execFileSync(process.execPath, [runner, requestPath], { encoding:"utf8", stdio:["ignore","pipe","pipe"], env }), /Command failed/);
});


test("status operation is read-only and reports pending PR", async () => {
  const f = await fixture("");
  await writeFile(join(f.state, "pr"), "1");
  const existingDelivery = {
    branch: "feat/test",
    commit: "abc123def456",
    pullRequest: { number: 42, url: "https://github.test/acme/demo/pull/42", state: "OPEN" },
    issues: [],
    mergeQueued: true,
  };
  const out = await runFixture(f, { operation:"status", classification:"success", autoMerge:true, existingDelivery });
  assert.equal(out.ok, true);
  assert.equal(out.operation, "status");
  assert.equal(out.merged, false);
  assert.equal(out.mergeQueued, true);
  const git = await readFile(join(f.state, "git.log"), "utf8").catch(() => "");
  assert.equal(git, "");
  const gh = await readFile(join(f.state, "gh.log"), "utf8");
  assert.doesNotMatch(gh, /"pr","create"/);
  assert.doesNotMatch(gh, /"pr","merge"/);
});

test("status operation reports completed merge", async () => {
  const f = await fixture("");
  await writeFile(join(f.state, "pr"), "1");
  const existingDelivery = {
    branch: "feat/test",
    commit: "abc123def456",
    pullRequest: { number: 42, url: "https://github.test/acme/demo/pull/42", state: "OPEN" },
    issues: [],
    mergeQueued: true,
  };
  const out = await runFixture(f, { operation:"status", classification:"success", autoMerge:true, existingDelivery }, { TEST_PR_MERGED:"1" });
  assert.equal(out.ok, true);
  assert.equal(out.merged, true);
  assert.equal(out.pullRequest.state, "MERGED");
  assert.ok(out.pullRequest.mergedAt);
});
