// Pre-fix state under escaped dot paths (e.g. ".." dirs) is intentionally not migrated.
import test from "node:test";
import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { cleanId } from "../dist/core/ids.js";

test("cleanId rejects path traversal tokens", () => {
  assert.equal(cleanId(".."), "run");
  assert.equal(cleanId("."), "run");
  assert.equal(cleanId("..."), "run");
  assert.equal(cleanId("ok-project"), "ok-project");
  const root = "/tmp/ocl-state";
  const dir = join(root, "runs", cleanId(".."), cleanId("rid"));
  const rel = relative(join(root, "runs"), dir);
  assert.ok(rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"));
  const siblingRel = relative(join(root, "runs"), join(root, "runs-evil"));
  assert.ok(siblingRel.startsWith("../"));
});
