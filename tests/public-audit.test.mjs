import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const auditSource = fileURLToPath(new URL("../scripts/audit-public.mjs", import.meta.url));

async function createFixture(content) {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-public-audit-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(auditSource, join(root, "scripts", "audit-public.mjs"));
  await writeFile(join(root, "README.md"), content);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["add", "README.md", "scripts/audit-public.mjs"], { cwd: root }).status, 0);
  return root;
}

function runAudit(root) {
  return spawnSync(process.execPath, ["scripts/audit-public.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
}

test("public audit rejects representative private infrastructure patterns", async () => {
  const rootDataPath = ["/", "data", "/", "workspace", "/", "project"].join("");
  const rootStatePath = ["/", "data", "/", ".openclaw", "/", "state.json"].join("");
  const homePath = ["/", "home", "/", "operator", "/", "workspace", "/", "project"].join("");
  const privateIp = ["192", "168", "42", "7"].join(".");
  const root = await createFixture([rootDataPath, rootStatePath, homePath, privateIp].join("\n"));
  try {
    const result = runAudit(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixed Unix operator path/);
    assert.match(result.stderr, /private IPv4 address/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public audit accepts synthetic public-safe placeholders", async () => {
  const documentationIp = ["192", "0", "2", "10"].join(".");
  const content = ["https://example.invalid", "/srv/project", documentationIp].join("\n");
  const root = await createFixture(content);
  try {
    const result = runAudit(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
