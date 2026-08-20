#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const requestPath = process.argv[2];
if (!requestPath) throw new Error("usage: github-delivery-runner.mjs REQUEST_JSON");
const req = JSON.parse(await readFile(requestPath, "utf8"));
const cwd = String(req.projectRoot || "");
if (!cwd) throw new Error("projectRoot_missing");

const runRaw = (cmd, args) =>
  String(execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  }) || "");
const run = (cmd, args) => runRaw(cmd, args).trim();
const safe = (value) => String(value || "").replace(/[\r\n]+/g, " ").trim();


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

const porcelain = runRaw("git", ["status", "--porcelain"]);
const paths = porcelain.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).split(" -> ").pop() || "");
const forbidden = paths.filter((path) =>
  /(^|\/)(\.env(?:\.|$)|.*(?:secret|credential|token|auth).*|id_[rd]sa(?:\.pub)?$)/i.test(path),
);
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
    run("git", ["commit", "-m", `development-cycle: ${req.classification} delivery for ${req.project} ${req.runId}`]);
  }
}
const commit = run("git", ["rev-parse", "HEAD"]);
run("git", ["push", "-u", "origin", branch]);

const repository = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
let pullRequest = null;
try {
  pullRequest = JSON.parse(run("gh", ["pr", "view", branch, "--json", "number,url,state"]));
} catch {}
if (!pullRequest || pullRequest.state === "CLOSED") {
  const bodyPath = join(cwd, ".git", `development-cycle-${safe(req.runId)}-pr.md`);
  await writeFile(bodyPath, [
    `Development-cycle run: ${req.runId}`,
    `Classification: ${req.classification}`,
    `Source phase: ${req.sourcePhase}`,
    "",
    "This PR is the materialized output of the supervised development cycle.",
  ].join("\n"));
  const url = run("gh", [
    "pr", "create",
    "--base", safe(req.baseBranch || "main"),
    "--head", branch,
    "--title", `${req.project}: ${req.classification} delivery ${req.runId}`,
    "--body-file", bodyPath,
  ]);
  pullRequest = JSON.parse(run("gh", ["pr", "view", url, "--json", "number,url,state"]));
}

const issues = [];
if (req.classification === "partial") {
  let existing = [];
  try {
    existing = JSON.parse(run("gh", ["issue", "list", "--state", "all", "--limit", "100", "--json", "number,title,url"]));
  } catch {}
  for (const finding of req.findings || []) {
    const clean = safe(finding).replace(/^\[(?:critical|high|medium|low)\]\s*/i, "");
    if (!clean) continue;
    const title = (`Follow-up: ${clean}`).slice(0, 120);
    const exact = existing.find((item) => String(item.title || "").toLowerCase() === title.toLowerCase());
    if (exact) {
      issues.push(exact);
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
      "- Resolve the finding and add/update validation that prevents regression.",
      "- Re-run the relevant development-cycle validation before closing.",
    ].join("\n");
    const url = run("gh", ["issue", "create", "--title", title, "--body", body]);
    const number = Number((url.match(/\/(\d+)$/) || [])[1] || 0);
    const issue = { number, url, title };
    issues.push(issue);
    existing.push(issue);
  }
  if (issues.length) {
    run("gh", [
      "pr", "comment", String(pullRequest.number),
      "--body", `Residual follow-ups: ${issues.map((item) => `#${item.number}`).join(", ")}`,
    ]);
  }
}

let merged = false;
let mergeQueued = false;
if (req.classification === "success" && req.autoMerge) {
  run("gh", ["pr", "merge", String(pullRequest.number), "--squash", "--auto", "--delete-branch"]);
  mergeQueued = true;
  try {
    const after = JSON.parse(run("gh", ["pr", "view", String(pullRequest.number), "--json", "state,mergedAt"]));
    merged = after.state === "MERGED" || Boolean(after.mergedAt);
  } catch {}
}

process.stdout.write(JSON.stringify({
  ok: true,
  repository,
  branch,
  commit,
  pullRequest,
  issues,
  merged,
  mergeQueued,
}));
