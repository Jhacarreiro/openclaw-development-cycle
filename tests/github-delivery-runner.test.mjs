import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const runner = resolve("scripts/github-delivery-runner.mjs");

async function fixture(status = " M src/app.ts\n", { worktreeGitFile = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dc-delivery-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const state = join(root, "state");
  await mkdir(bin); await mkdir(repo); await mkdir(state);
  if (worktreeGitFile) await writeFile(join(repo, ".git"), "gitdir: /tmp/fake-worktree-gitdir\n");
  else await mkdir(join(repo, ".git"));
  const git = `#!/usr/bin/env node
const fs=require("fs"), a=process.argv.slice(2), d=process.env.TEST_STATE_DIR;
fs.appendFileSync(d+"/git.log",JSON.stringify(a)+"\\n");
if(a[0]==="push") fs.writeFileSync(d+"/git-push-env.json",JSON.stringify({askpass:process.env.GIT_ASKPASS||"",terminal:process.env.GIT_TERMINAL_PROMPT||"",tokenVisible:Boolean(process.env.GH_TOKEN)}));
if(a[0]==="status") process.stdout.write(a.includes("-z")?(process.env.TEST_GIT_STATUS||"").replace(/\\n/g,"\\0"):(process.env.TEST_GIT_STATUS||""));
else if(a[0]==="branch") process.stdout.write(process.env.TEST_BRANCH||"feat/test");
else if(a[0]==="diff"&&a.includes("--cached")) process.stdout.write("src/app.ts\\n");
else if(a[0]==="diff"&&a.includes("--name-only")) process.stdout.write((process.env.TEST_COMMITTED_PATHS||"").replace(/\\n/g,"\\0"));
else if(a[0]==="rev-parse") process.stdout.write("abc123def456\\n");
else if(a[0]==="config") { if(process.env.TEST_GIT_EMAIL) process.stdout.write(process.env.TEST_GIT_EMAIL+"\\n"); else process.exit(1); }
`;
  const gh = `#!/usr/bin/env node
const fs=require("fs"), a=process.argv.slice(2), d=process.env.TEST_STATE_DIR;
fs.appendFileSync(d+"/gh.log",JSON.stringify(a)+"\\n");
if(a[0]==="repo") process.stdout.write("acme/demo\\n");
else if(a[0]==="api"&&a[1]==="user") process.stdout.write(JSON.stringify({login:"octo-bot",id:4242}));
else if(a[0]==="pr"&&a[1]==="view") {
  if(!fs.existsSync(d+"/pr")) process.exit(1);
  const merged=process.env.TEST_PR_MERGED==="1";
  process.stdout.write(JSON.stringify({number:42,url:"https://github.test/acme/demo/pull/42",state:merged?"MERGED":"OPEN",isDraft:fs.existsSync(d+"/draft")||process.env.TEST_PR_DRAFT==="1",mergedAt:merged?"2026-08-20T17:00:00Z":null,autoMergeRequest:process.env.TEST_PR_AUTO_MERGE==="1"?{mergeMethod:"SQUASH"}:null}));
} else if(a[0]==="pr"&&a[1]==="create") {
  fs.writeFileSync(d+"/pr","1");
  if(a.includes("--draft")) fs.writeFileSync(d+"/draft","1");
  process.stdout.write("https://github.test/acme/demo/pull/42\\n");
} else if(a[0]==="issue"&&a[1]==="list") process.stdout.write("[]");
else if(a[0]==="issue"&&a[1]==="create") {
  let n=100; try{n=Number(fs.readFileSync(d+"/issue-n","utf8"))}catch{}
  if(process.env.TEST_ISSUE_FAIL_AT===String(n+1)&&!fs.existsSync(d+"/issue-failed")) { fs.writeFileSync(d+"/issue-failed","1"); process.exit(1); }
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
  const env = { ...process.env, GH_TOKEN:"test-token", PATH:`${f.bin}:${process.env.PATH}`, TEST_STATE_DIR:f.state, TEST_GIT_STATUS:f.status, TEST_BRANCH:"feat/test", ...extraEnv };
  const stdout = execFileSync(process.execPath, [runner, requestPath], { encoding:"utf8", env });
  return JSON.parse(stdout);
}

test("partial delivery opens a draft PR and residual issues without merge", async () => {
  const f = await fixture();
  const out = await runFixture(f, { classification:"partial", autoMerge:false, findings:["race condition","port mismatch"] });
  assert.equal(out.ok, true);
  assert.equal(out.pullRequest.number, 42);
  assert.equal(out.issues.length, 2);
  assert.equal(out.mergeQueued, false);
  const gh = await readFile(join(f.state, "gh.log"), "utf8");
  assert.match(gh, /"pr","create"/);
  assert.match(gh, /"--draft"/);
  assert.match(gh, /"issue","create"/);
  assert.doesNotMatch(gh, /"pr","merge"/);
});

test("a publication retry reuses issues recorded before a later operation failed", async () => {
  const f = await fixture();
  const request = { classification:"partial", autoMerge:false, findings:["remaining work one", "remaining work two"] };
  await assert.rejects(runFixture(f, request, { TEST_ISSUE_FAIL_AT:"102" }));
  const out = await runFixture(f, request);
  assert.deepEqual(out.issues.map(issue => issue.number), [101,102]);
  await runFixture(f, request);
  const calls = (await readFile(join(f.state,"gh.log"),"utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter(a => a[0]==="pr" && a[1]==="create").length,1);
  assert.equal(calls.filter(a => a[0]==="issue" && a[1]==="create").length,3);
  const journal = JSON.parse(await readFile(join(f.root,"repository_delivery_progress.json"),"utf8"));
  assert.equal(journal.issues.length,2);
});

test("recovered commits receive the same sensitive-path checks as dirty files", async () => {
  const f = await fixture("");
  await assert.rejects(runFixture(f, { classification:"partial", preservedBaseline:"a".repeat(40), findings:[] }, { TEST_COMMITTED_PATHS:"config/credentials.json\n" }), /refusing_sensitive_paths/);
  assert.equal(await readFile(join(f.state,"gh.log"),"utf8").catch(()=>""), "");
});

test("a validated continuation marks its draft ready before queuing merge", async () => {
  const f = await fixture("");
  await writeFile(join(f.state,"pr"),"1");
  await runFixture(f, { classification:"success", targetBranch:"feat/test", autoMerge:true }, { TEST_PR_DRAFT:"1" });
  const calls = (await readFile(join(f.state,"gh.log"),"utf8")).trim().split("\n").map(JSON.parse);
  const ready = calls.findIndex(a => a[0]==="pr" && a[1]==="ready" && !a.includes("--undo"));
  const merge = calls.findIndex(a => a[0]==="pr" && a[1]==="merge" && a.includes("--auto"));
  assert.ok(ready >= 0 && merge > ready);
});

test("long findings with the same title prefix remain distinct issues", async () => {
  const f = await fixture();
  const prefix = "Complete the remaining acceptance check ".repeat(5);
  const out = await runFixture(f, { classification:"partial", findings:[prefix+"one",prefix+"two"] });
  assert.equal(new Set(out.issues.map(issue => issue.number)).size,2);
  assert.equal(new Set(out.issues.map(issue => issue.title)).size,2);
});

test("partial publication disables any previously queued auto-merge", async () => {
  const f = await fixture(""); await writeFile(join(f.state,"pr"),"1");
  await runFixture(f, { classification:"partial", autoMerge:true }, { TEST_PR_AUTO_MERGE:"1" });
  const calls = (await readFile(join(f.state,"gh.log"),"utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.filter(a => a[0]==="pr"&&a[1]==="merge"), [["pr","merge","42","--disable-auto"]]);
});

test("successful delivery queues GitHub auto-merge without local branch deletion", async () => {
  const f = await fixture();
  const out = await runFixture(f, { classification:"success", autoMerge:true, findings:[] });
  assert.equal(out.ok, true);
  assert.equal(out.issues.length, 0);
  assert.equal(out.mergeQueued, true);
  const gh = await readFile(join(f.state, "gh.log"), "utf8");
  assert.match(gh, /"pr","merge"/);
  assert.match(gh, /"--auto"/);
  assert.doesNotMatch(gh, /"--delete-branch"/);
});

test("a pending decision is listed on the open PR and stops an auto-merge an earlier delivery queued", async () => {
  const f = await fixture();
  await writeFile(join(f.state, "pr"), "1");
  const out = await runFixture(f, { classification:"success", autoMerge:false, findings:[], pendingDecisions:[{ id:"operator-auth", question:"Which operator authentication?", options:["tokens","none"] }] }, { TEST_PR_AUTO_MERGE:"1" });
  assert.equal(out.ok, true);
  assert.equal(out.mergeQueued, false);
  const calls = (await readFile(join(f.state, "gh.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((a) => a[0] === "pr" && a[1] === "comment"), JSON.stringify(calls));
  assert.deepEqual(calls.filter((a) => a[0] === "pr" && a[1] === "merge"), [["pr", "merge", "42", "--disable-auto"]]);
});

test("retry recognizes an already merged PR without invoking merge again", async () => {
  const f = await fixture("");
  await writeFile(join(f.state, "pr"), "1");
  const out = await runFixture(f, { classification:"success", autoMerge:true, findings:[] }, { TEST_PR_MERGED:"1" });
  assert.equal(out.ok, true);
  assert.equal(out.merged, true);
  assert.equal(out.mergeQueued, false);
  const gh = await readFile(join(f.state, "gh.log"), "utf8");
  assert.doesNotMatch(gh, /"pr","merge"/);
});

test("git push uses ephemeral GIT_ASKPASS without putting the token in argv", async () => {
  const f = await fixture();
  const out = await runFixture(f, { classification:"success", autoMerge:false, findings:[] });
  assert.equal(out.ok, true);
  const pushEnv = JSON.parse(await readFile(join(f.state, "git-push-env.json"), "utf8"));
  assert.match(pushEnv.askpass, /development-cycle-git-askpass-/);
  assert.equal(pushEnv.terminal, "0");
  assert.equal(pushEnv.tokenVisible, true);
  const git = await readFile(join(f.state, "git.log"), "utf8");
  assert.doesNotMatch(git, /test-token/);
});

test("PR body creation works when .git is a worktree pointer file", async () => {
  const f = await fixture(" M src/app.ts\n", { worktreeGitFile:true });
  const out = await runFixture(f, { classification:"success", autoMerge:false, findings:[] });
  assert.equal(out.ok, true);
  assert.equal(out.pullRequest.number, 42);
  const gh = await readFile(join(f.state, "gh.log"), "utf8");
  assert.match(gh, /"pr","create"/);
  assert.match(gh, /development-cycle-pr-body-/);
});

test("delivery runner refuses sensitive changed paths", async () => {
  const f = await fixture(" M .env\n");
  const requestPath = join(f.root, "request.json");
  await writeFile(requestPath, JSON.stringify({ project:"demo", runId:"run-1", projectRoot:f.repo, baseBranch:"main", classification:"partial", autoMerge:false, findings:[] }));
  const env = { ...process.env, PATH:`${f.bin}:${process.env.PATH}`, TEST_STATE_DIR:f.state, TEST_GIT_STATUS:f.status, TEST_BRANCH:"feat/test" };
  assert.throws(() => execFileSync(process.execPath, [runner, requestPath], { encoding:"utf8", stdio:["ignore","pipe","pipe"], env }), /Command failed/);
});


test("delivery refuses secret-looking paths but not source or tests that mention auth", async () => {
  for (const status of ["A  config/credentials.json\n", "?? deploy/server key.pem\n", "?? .codex/auth.json\n", "?? secrets/prod.json\n", "?? notes/token.txt\n", "R  docs/setup.md\n.env\n"]) {
    const f = await fixture(status);
    await assert.rejects(runFixture(f, { classification:"success", autoMerge:false, findings:[] }), /refusing_sensitive_paths/);
  }
  const code = await fixture("A  src/publish/oauth.ts\nA  tests/unit/oauth.test.mjs\nA  src/auth/session.ts\n");
  const out = await runFixture(code, { classification:"success", autoMerge:false, findings:[] });
  assert.equal(out.ok, true);
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

test("delivery commits as the GitHub account when the host has no git identity, and keeps a configured one", async () => {
  const bare = await fixture();
  await runFixture(bare, { classification:"success", autoMerge:false, findings:[] });
  const bareCommit = (await readFile(join(bare.state, "git.log"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((a) => a.includes("commit"));
  assert.deepEqual(bareCommit.slice(0, 4), ["-c", "user.name=octo-bot", "-c", "user.email=4242+octo-bot@users.noreply.github.com"]);

  const configured = await fixture();
  await runFixture(configured, { classification:"success", autoMerge:false, findings:[] }, { TEST_GIT_EMAIL:"dev@example.test" });
  const configuredCommit = (await readFile(join(configured.state, "git.log"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((a) => a.includes("commit"));
  assert.equal(configuredCommit[0], "commit");
});
