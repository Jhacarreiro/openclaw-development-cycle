import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("implementation request schema v1 matches the emitted contract", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/implementation-request-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.properties.mode.enum, ["delivery", "corrections"]);
  const required = new Set(schema.required);
  for (const field of ["schemaVersion", "project", "runId", "mode", "projectRoot", "promptPath", "resultsRoot", "command"]) {
    assert.equal(required.has(field), true, field);
  }
  assert.equal(required.has("timeoutSeconds"), false, "timeoutSeconds is optional when timeout policy is delegated");
  assert.equal(schema.properties.timeoutSeconds.type, "integer");
  assert.equal(schema.properties.timeoutSeconds.minimum, 1);

  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  for (const field of schema.required) {
    assert.match(source, new RegExp(`\\b${field}\\b`), field);
  }
});
