import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("core modules do not import OpenClaw or runtime adapters", async () => {
  const coreDir = new URL("../src/core/", import.meta.url);
  const files = (await readdir(coreDir)).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const source = await readFile(new URL(file, coreDir), "utf8");
    const imports = source
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith("import "))
      .join("\n");
    assert.doesNotMatch(imports, /openclaw|implementation|observer/i, file);
  }
});
