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
  process.stdout.write(JSON.stringify({number:42,url:"https://github.test/acme/demo/pull/42",state:merged?"MERGED":"OPEN",mergedAt:merged?"2026-08-20T17:00:00Z":null,autoMergeRequest:process.env.TEST_PR_AUTO_MERGE==="1"?{mergeMethod:"SQUASH"}:null}));
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
  const env = { ...process.env, GH_TOKEN:"test-token", PATH:`${f.bin}:${process.env.PATH}`, TEST_STATE_DIR:f.state, TEST_GIT_STATUS:f.status, TEST_BRANCH:"feat/test", ...extraEnv };
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
