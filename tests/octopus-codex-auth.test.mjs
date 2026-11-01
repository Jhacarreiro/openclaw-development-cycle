import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureOctopusCodexAuthLink } from "../dist/adapters/octopus-codex-auth.js";

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "dc-codex-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const stateDir = join(root, "state");
  mkdirSync(home);
  return { home, stateDir, linkPath: join(home, ".codex", "auth.json") };
}

test("a missing Codex auth file is linked to the OpenClaw-managed one, and an existing file is left alone", async (t) => {
  const { home, stateDir, linkPath } = sandbox(t);
  assert.equal(await ensureOctopusCodexAuthLink(home, stateDir), "source_missing");

  mkdirSync(join(stateDir, "codex"), { recursive: true });
  writeFileSync(join(stateDir, "codex", "auth.json"), "{}");
  assert.equal(await ensureOctopusCodexAuthLink(home, stateDir), "linked");
  assert.equal(readlinkSync(linkPath), join(stateDir, "codex", "auth.json"));
  assert.equal(await ensureOctopusCodexAuthLink(home, stateDir), "present");

  const other = sandbox(t);
  mkdirSync(join(other.home, ".codex"));
  writeFileSync(other.linkPath, "own");
  assert.equal(await ensureOctopusCodexAuthLink(other.home, stateDir), "present");
  assert.equal(readFileSync(other.linkPath, "utf8"), "own");
});
