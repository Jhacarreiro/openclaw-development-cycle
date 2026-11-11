#!/usr/bin/env node
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const requestPath = process.argv[2];
if (!requestPath) throw new Error("usage: github-delivery-runner.mjs REQUEST_JSON");
const req = JSON.parse(await readFile(requestPath, "utf8"));
const cwd = String(req.projectRoot || "");
if (!cwd) throw new Error("projectRoot_missing");

const runRaw = (cmd, args, options = {}) =>
  String(execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  }) || "");
const run = (cmd, args, options = {}) => runRaw(cmd, args, options).trim();

async function pushWithGitHubToken(branch) {
  const token = String(process.env.GH_TOKEN || "").trim();
  if (!token) throw new Error("GH_TOKEN_missing_for_git_push");
  const dir = await mkdtemp(join(tmpdir(), "development-cycle-git-askpass-"));
  const askpass = join(dir, "askpass.sh");
  await writeFile(askpass, [
    "#!/bin/sh",
    'case "$1" in',
    '  *Username*) echo x-access-token ;;',
    '  *Password*) echo "$GH_TOKEN" ;;',
    "esac",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(askpass, 0o700);
  try {
    return run("git", ["push", "-u", "origin", branch], {
      env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const safe = (value) => String(value || "").replace(/[\r\n]+/g, " ").trim();

// A fresh container has no git identity, and `git commit` then refuses.
// Without a configured one, commit as the GitHub account the delivery pushes
// and opens the PR with, using its noreply address.
function commitIdentityArgs() {
  try {
    if (run("git", ["config", "user.email"])) return [];
  } catch {}
  const account = JSON.parse(run("gh", ["api", "user"]));
  if (!account?.login || !account?.id) throw new Error("git_identity_unavailable");
  return ["-c", `user.name=${account.login}`, "-c", `user.email=${account.id}+${account.login}@users.noreply.github.com`];
}


if (req.operation === "status") {
  const existing = req.existingDelivery || {};
  const prRef = existing?.pullRequest?.number || existing?.pullRequest?.url || existing?.pullRequest || null;
  if (!prRef) throw new Error("repository_delivery_status_missing_pull_request");
  const repository = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  const pullRequest = JSON.parse(run("gh", ["pr", "view", String(prRef), "--json", "number,url,state,mergedAt"]));
  const merged = pullRequest.state === "MERGED" || Boolean(pullRequest.mergedAt);
  process.stdout.write(JSON.stringify({
    ok: true,
    operation: "status",
    repository,
    branch: existing.branch || null,
    commit: existing.commit || null,
    pullRequest,
    issues: existing.issues || [],
    merged,
    mergeQueued: Boolean(existing.mergeQueued),
  }));
  process.exit(0);
}

// A follow-up run reads the current state of the issues an earlier partial
// delivery opened, so only the ones still open become its tasks.
if (req.operation === "issues") {
  const issues = [];
  for (const number of req.issueNumbers || []) {
    if (!Number.isInteger(number) || number <= 0) continue;
    issues.push(JSON.parse(run("gh", ["issue", "view", String(number), "--json", "number,title,body,state,url"])));
  }
  const pullRequest = req.pullRequest ? JSON.parse(run("gh", ["pr", "view", String(req.pullRequest), "--json", "number,url,state,headRefName,headRefOid"])) : null;
  process.stdout.write(JSON.stringify({ ok: true, operation: "issues", issues, pullRequest }));
  process.exit(0);
}

// List every untracked file, not just its new top-level directory, so a
// secret inside a new directory is still checked. NUL-terminated entries keep
// paths with spaces or special characters unquoted.
const porcelain = runRaw("git", ["status", "--porcelain", "-z", "--untracked-files=all"]);
const paths = [];
{
  const entries = porcelain.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy is followed by its source path.
    if (/[RC]/.test(entry.slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]);
  }
}
if (req.preservedBaseline) {
  const baseline = String(req.preservedBaseline);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseline)) throw new Error("invalid_preserved_baseline");
  run("git", ["merge-base", "--is-ancestor", baseline, "HEAD"]);
  paths.push(...runRaw("git", ["diff", "--name-only", "-z", baseline, "HEAD"]).split("\0").filter(Boolean));
}
// Secret-looking paths: anything under a secrets or credentials directory,
// env files, private keys and key stores, and files named after secrets,
// credentials, tokens or auth. Source and test code is not refused for its
// name (an OAuth signer and its tests); text and data files are.
const SECRET_DIR = /^(?:\.?secrets?|\.?credentials?|\.ssh|\.gnupg|\.aws)$/i;
const SOURCE_CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|sh)$/i;
const isSensitivePath = (path) => {
  const parts = String(path).split("/").filter(Boolean);
  const name = parts.pop() || "";
  if (parts.some((dir) => SECRET_DIR.test(dir))) return true;
  if (/^\.env(?:\.|$)/i.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(name)) return true;
  if (/\.(?:pem|key|p12|pfx|keystore)$/i.test(name)) return true;
  return /secret|credential|token|auth/i.test(name) && !SOURCE_CODE.test(name);
};
const forbidden = paths.filter(isSensitivePath);
if (forbidden.length) throw new Error(`refusing_sensitive_paths:${forbidden.slice(0, 10).join(",")}`);

run("git", ["diff", "--check"]);
const branch = run("git", ["branch", "--show-current"]);
if (!branch || ["main", "master"].includes(branch)) {
  throw new Error(`refusing_delivery_from_base_branch:${branch || "detached"}`);
}

if (porcelain) {
  run("git", ["add", "-A"]);
  const staged = run("git", ["diff", "--cached", "--name-only"]);
  if (staged) {
    process.stderr.write(`${run("git", ["diff", "--cached", "--stat"])}\nStaged files: ${staged.split("\n").length}\n`);
    run("git", [...commitIdentityArgs(), "commit", "-m", `development-cycle: ${req.classification} delivery for ${req.project} ${req.runId}`]);
  }
}
const commit = run("git", ["rev-parse", "HEAD"]);
// A follow-up run starts from the head of an open delivery PR and adds its
// commits to that PR's branch. A plain push only fast-forwards, so it fails
// instead of dropping commits if the branch moved since.
const targetBranch = safe(req.targetBranch);
const prBranch = targetBranch || branch;
const findPullRequest = () => {
  try {
    return JSON.parse(run("gh", ["pr", "view", prBranch, "--json", "number,url,state,isDraft"]));
  } catch {
    return null;
  }
};
// Check before pushing: commits pushed to a closed or merged PR's branch
// would land outside any PR.
const beforePush = findPullRequest();
if (targetBranch && beforePush?.state !== "OPEN") throw new Error(`followup_pull_request_not_open:${prBranch}`);
if (req.classification === "partial" && beforePush?.state === "MERGED") throw new Error(`partial_pull_request_already_merged:${prBranch}`);
await pushWithGitHubToken(targetBranch ? `HEAD:refs/heads/${targetBranch}` : branch);

const repository = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
let pullRequest = findPullRequest();
if (!pullRequest || pullRequest.state === "CLOSED") {
  const bodyDir = await mkdtemp(join(tmpdir(), "development-cycle-pr-body-"));
  const bodyPath = join(bodyDir, `development-cycle-${safe(req.runId)}-pr.md`);
  try {
    await writeFile(bodyPath, [
      `Development-cycle run: ${req.runId}`,
      `Classification: ${req.classification}`,
      `Source phase: ${req.sourcePhase}`,
      "",
      req.classification === "partial"
        ? "This draft preserves partial work. The approved scope, validation and review remain to be checked through the residual issues. Continue from this branch; do not treat preservation as validation."
        : "This PR is the materialized output of the supervised development cycle.",
    ].join("\n"));
    const url = run("gh", [
      "pr", "create",
      "--base", safe(req.baseBranch || "main"),
      "--head", branch,
      "--title", `${req.project}: ${req.classification} delivery ${req.runId}`,
      "--body-file", bodyPath,
      ...(req.classification === "partial" ? ["--draft"] : []),
    ]);
    pullRequest = JSON.parse(run("gh", ["pr", "view", url, "--json", "number,url,state,isDraft"]));
  } finally {
    await rm(bodyDir, { recursive: true, force: true });
  }
}

const issues = [];
// Keep each published issue durable even if a later GitHub operation fails.
// The next attempt must not recreate an issue outside the list window.
const progressPath = join(dirname(requestPath), "repository_delivery_progress.json");
let previousProgress = null;
try { previousProgress = JSON.parse(await readFile(progressPath, "utf8")); } catch {}
const knownIssues = [
  ...(req.existingDelivery?.issues || []),
  ...(previousProgress?.runId === req.runId && previousProgress?.project === req.project
    && previousProgress?.repository === repository && previousProgress?.branch === prBranch
    && previousProgress?.pullRequest?.number === pullRequest.number ? previousProgress.issues || [] : []),
];
async function recordProgress() {
  const dir = await mkdtemp(join(dirname(requestPath), ".delivery-progress-"));
  try {
    const path = join(dir, "progress.json");
    const published = [...new Map([...knownIssues, ...issues].map((issue) => [issue.number, issue])).values()];
    await writeFile(path, JSON.stringify({ project:req.project, runId:req.runId, repository, branch:prBranch, commit, pullRequest, issues:published }), { mode:0o600 });
    await rename(path, progressPath);
  } finally { await rm(dir, { recursive:true, force:true }); }
}
if (req.classification === "partial") {
  if (pullRequest.state === "OPEN") {
    if (!pullRequest.isDraft) run("gh", ["pr", "ready", String(pullRequest.number), "--undo"]);
    const current = JSON.parse(run("gh", ["pr", "view", String(pullRequest.number), "--json", "autoMergeRequest"]));
    if (current.autoMergeRequest) run("gh", ["pr", "merge", String(pullRequest.number), "--disable-auto"]);
  }
  let existing = [];
  try {
    existing = JSON.parse(run("gh", ["issue", "list", "--state", "all", "--limit", "100", "--json", "number,title,url"]));
  } catch {}
  existing.push(...knownIssues);
  for (const finding of req.findings || []) {
    const clean = safe(finding).replace(/^\[(?:critical|high|medium|low)\]\s*/i, "");
    if (!clean) continue;
    const fullTitle = `Follow-up: ${clean}`;
    const title = fullTitle.length <= 120 ? fullTitle
      : `${fullTitle.slice(0, 108)} [${createHash("sha256").update(clean).digest("hex").slice(0, 8)}]`;
    const exact = existing.find((item) => String(item.title || "").toLowerCase() === title.toLowerCase());
    if (exact) {
      issues.push(exact);
      await recordProgress();
      continue;
    }
    const body = [
      `Created from development-cycle run ${req.runId}.`,
      `Related PR: ${pullRequest.url}`,
      "",
      "Finding:",
      finding,
      "",
      "Acceptance criteria:",
      "- Inspect the preserved branch against this task and the approved plan; retain completed work and finish only the remaining scope.",
      "- Add or update meaningful validation where the behavior is not already covered.",
      "- Re-run the relevant development-cycle validation before closing.",
    ].join("\n");
    const bodyDir = await mkdtemp(join(tmpdir(), "development-cycle-issue-body-"));
    let url;
    try {
      const path = join(bodyDir, "issue.md");
      await writeFile(path, body, { mode:0o600 });
      url = run("gh", ["issue", "create", "--title", title, "--body-file", path]);
    } finally { await rm(bodyDir, { recursive:true, force:true }); }
    const number = Number((url.match(/\/(\d+)$/) || [])[1] || 0);
    const issue = { number, url, title };
    issues.push(issue);
    existing.push(issue);
    await recordProgress();
  }
  if (issues.length) {
    run("gh", [
      "pr", "comment", String(pullRequest.number),
      "--body", `Residual follow-ups: ${issues.map((item) => `#${item.number}`).join(", ")}`,
    ]);
  }
}

if (req.classification === "success" && pullRequest?.isDraft) {
  run("gh", ["pr", "ready", String(pullRequest.number)]);
}

// When a follow-up run succeeds, the PR now carries the whole delivery: give
// it a success title and close the issues it resolved when it merges.
const closesIssues = (req.closesIssues || []).filter((number) => Number.isInteger(number) && number > 0);
if (targetBranch && req.classification === "success") {
  const current = JSON.parse(run("gh", ["pr", "view", String(pullRequest.number), "--json", "body"]));
  const closing = closesIssues.map((number) => `Closes #${number}`).join("\n");
  const bodyDir = await mkdtemp(join(tmpdir(), "development-cycle-pr-edit-"));
  const editPath = join(bodyDir, "edit.json");
  try {
    await writeFile(editPath, JSON.stringify({
      title: `${req.project}: delivery ${req.runId}`,
      body: [String(current.body || "").trim(), `Completed by follow-up run ${req.runId}.`, closing].filter(Boolean).join("\n\n"),
    }));
    run("gh", ["api", "-X", "PATCH", `repos/${repository}/pulls/${pullRequest.number}`, "--input", editPath]);
  } finally {
    await rm(bodyDir, { recursive: true, force: true });
  }
}

const pendingDecisions = Array.isArray(req.pendingDecisions) ? req.pendingDecisions : [];
if (pendingDecisions.length && pullRequest?.state === "OPEN") {
  const commentDir = await mkdtemp(join(tmpdir(), "development-cycle-pr-decision-"));
  const commentPath = join(commentDir, "decision.md");
  try {
    await writeFile(commentPath, [
      "Decision pending before merge. The implementation left a question it was not allowed to decide:",
      ...pendingDecisions.map((decision) => [
        "",
        `**${safe(decision.id)}**: ${String(decision.question || "")}`,
        ...(decision.options || []).map((option) => `- ${String(option)}`),
      ].join("\n")),
    ].join("\n"));
    run("gh", ["pr", "comment", String(pullRequest.number), "--body-file", commentPath]);
    // An earlier delivery may have queued auto-merge on this PR.
    const { autoMergeRequest } = JSON.parse(run("gh", ["pr", "view", String(pullRequest.number), "--json", "autoMergeRequest"]));
    if (autoMergeRequest) run("gh", ["pr", "merge", String(pullRequest.number), "--disable-auto"]);
  } finally {
    await rm(commentDir, { recursive: true, force: true });
  }
}

let merged = pullRequest?.state === "MERGED";
let mergeQueued = false;
if (req.classification === "success" && req.autoMerge && !merged) {
  run("gh", ["pr", "merge", String(pullRequest.number), "--squash", "--auto"]);
  mergeQueued = true;
  try {
    const after = JSON.parse(run("gh", ["pr", "view", String(pullRequest.number), "--json", "state,mergedAt"]));
    merged = after.state === "MERGED" || Boolean(after.mergedAt);
  } catch {}
}

process.stdout.write(JSON.stringify({
  ok: true,
  repository,
  branch: prBranch,
  commit,
  pullRequest,
  issues,
  merged,
  mergeQueued,
}));
