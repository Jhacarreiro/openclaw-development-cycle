import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { jsonShellQuote, shellQuote } from "../dist/adapters/implementation.js";

const execFileAsync = promisify(execFile);
const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

test("runner heartbeat interpolates a JSON-encoded observer session id", () => {
  assert.match(source, /observerSessionId":%s/);
  assert.match(source, /jsonShellQuote\(observerRootSessionId\)/);
  assert.doesNotMatch(source, /observerSessionId":"%s"/);
});

test("generated runner stays shell-safe and emits parseable heartbeat JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-generated-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const observerIds = [
    "plain-session",
    `id with spaces`,
    `id'with'singles`,
    `id"with"doubles`,
    `id\\with\\backslashes`,
    "id\nwith\nnewlines",
    `$(touch ${join(root, "PWNED-id")})`,
    `\`touch ${join(root, "PWNED-backtick")}\``,
    `id; touch ${join(root, "PWNED-semi")}`,
  ];

  for (const [index, observerRootSessionId] of observerIds.entries()) {
    const caseDir = join(root, `case-${index}`);
    const projectRoot = join(caseDir, "proj $(touch PWNED-cd)");
    const stdoutPath = join(caseDir, "out $(touch PWNED-out).log");
    const stderrPath = join(caseDir, "err.log");
    const heartbeatPath = join(caseDir, "heartbeat.json");
    await mkdir(projectRoot, { recursive: true });

    const runnerScript = `#!/bin/sh
set -u
HEARTBEAT_FILE=${JSON.stringify(heartbeatPath)}
printf '{"at":"%s","pid":%s,"observerSessionId":%s}\\n' "$(date -Is)" "$$" ${jsonShellQuote(observerRootSessionId)} > "$HEARTBEAT_FILE"
cd ${shellQuote(projectRoot)}
true > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}
`;
    const runnerPath = join(caseDir, "run-implementation-session.sh");
    await writeFile(runnerPath, runnerScript, { mode: 0o755 });
    await execFileAsync("/bin/sh", [runnerPath], { cwd: caseDir });

    const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
    assert.equal(heartbeat.observerSessionId, observerRootSessionId);
    assert.equal(typeof heartbeat.at, "string");
    assert.equal(typeof heartbeat.pid, "number");
    assert.ok(heartbeat.at.length > 0);
    assert.ok(Number.isInteger(heartbeat.pid));
    await access(stdoutPath);
    await access(stderrPath);
    await assert.rejects(() => access(join(caseDir, "PWNED-cd")));
    await assert.rejects(() => access(join(caseDir, "PWNED-out")));
  }

  for (const name of ["PWNED-id", "PWNED-backtick", "PWNED-semi"]) {
    await assert.rejects(() => access(join(root, name)));
  }
});
