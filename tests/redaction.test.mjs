import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

function extractRedactRemoteCredentials() {
  const match = source.match(/function redactRemoteCredentials[\s\S]*?\n}/);
  assert.ok(match, "redactRemoteCredentials source not found");
  const fnText = match[0].replace(/\(text: string\)/, "(text)");
  // eslint-disable-next-line no-new-func
  return new Function(`return (${fnText});`)();
}

test("redactRemoteCredentials scrubs userinfo through the LAST @ before the host", () => {
  const redact = extractRedactRemoteCredentials();
  // userinfo that itself contains '@' must not leak past the redaction point
  assert.equal(redact("https://user:token@part@host/repo.git"), "https://***@host/repo.git");
  assert.equal(redact("https://alice:pw@one@two@example.com/x.git"), "https://***@example.com/x.git");
  // single-segment userinfo still redacted
  assert.equal(redact("https://user:token@host/repo.git"), "https://***@host/repo.git");
  assert.equal(redact("https://user@host/repo.git"), "https://***@host/repo.git");
  assert.equal(redact("ssh://git@github.com/org/repo.git"), "ssh://***@github.com/org/repo.git");
  // URLs without userinfo are untouched
  assert.equal(redact("https://host/repo.git"), "https://host/repo.git");
  // Repository path containing @ must not be treated as userinfo
  assert.equal(redact("https://host/org/repo@branch.git"), "https://host/org/repo@branch.git");
  assert.equal(redact("https://user:token@host/org/repo@branch.git"), "https://***@host/org/repo@branch.git");
  assert.equal(redact("https://user:token@host/repo@branch.git"), "https://***@host/repo@branch.git");
  assert.equal(redact(""), "");
  assert.equal(redact(null), "");
});

// Production-boundary integration test: drive the real plugin's request_plan
// action, which calls writePlanningPack -> git remote -v -> redactRemoteCredentials
// -> context_pack.md. A future regression that stops redacting (or stops
// running the redaction on the git remote output) must make this fail.
test("writePlanningPack redacts git remote credentials in the generated context_pack.md", async (t) => {
  const root = join(tmpdir(), `redaction-integration-${process.pid}-${Date.now()}`);
  const projectRoot = join(root, "code");
  const secret = "supersecrettoken";
  const remoteUrl = `https://user:${secret}@github.com/org/credrepo.git`;

  // Fresh git repo whose origin remote carries credentials in the URL.
  await mkdir(projectRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
  await execFileAsync("git", ["remote", "add", "origin", remoteUrl], { cwd: projectRoot });
  t.after(() => rm(root, { recursive: true, force: true }));

  process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
  process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
  process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
  process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";

  const { default: plugin } = await import(`../dist/index.js?redaction=${Date.now()}`);
  let registered;
  plugin.register({ pluginConfig: {}, registerTool(tool) { registered = tool; } });

  const result = await registered.execute(
    "redaction-integration-call",
    { action: "request_plan", project: "cred-fixture", projectRoot },
    undefined,
    undefined,
  );
  assert.equal(result.details.ok, true);

  const contextPack = join(result.details.dir, "context_pack.md");
  const pack = await readFile(contextPack, "utf8");

  // The credential must be redacted, not leaked, and the redaction marker must
  // be present in the Git remotes section.
  assert.ok(!pack.includes(secret), "credential leaked into context_pack.md");
  assert.ok(!pack.includes(remoteUrl), "full credentialed remote URL leaked into context_pack.md");
  assert.match(pack, /https:\/\/\*\*\*@github\.com\/org\/credrepo\.git/);
});
