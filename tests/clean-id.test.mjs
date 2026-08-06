import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { cleanId } from "../dist/core/ids.js";

test("cleanId rejects path traversal tokens", () => {
  assert.equal(cleanId(".."), "run");
  assert.equal(cleanId("."), "run");
  assert.equal(cleanId("..."), "run");
  assert.equal(cleanId("ok-project"), "ok-project");
  const root = "/tmp/ocl-state";
  const dir = join(root, "runs", cleanId(".."), cleanId("rid"));
  assert.ok(dir.startsWith(join(root, "runs")));
});
