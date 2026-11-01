import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the npm package contains its documented delivery adapter and runtime helpers", { skip: !process.env.npm_execpath }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [process.env.npm_execpath, "pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const files = new Set(JSON.parse(stdout)[0].files.map(file => file.path));
  for (const path of ["scripts/github-delivery-runner.mjs", "runner-supervisor.py", "bin/bounded-log.py", "dist/runtime/notifications.js", "dist/runtime/processes.js", "dist/runtime/validation-evidence.js"]) assert.ok(files.has(path), `missing packaged file: ${path}`);
});
