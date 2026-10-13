import assert from "node:assert/strict";
import test from "node:test";
import { defaultValidationConfig, mergeValidationConfig, parseGitPorcelain, validationRuleMatches } from "../dist/core/validation-config.js";

test("malformed validation policy is rejected rather than silently using defaults", () => {
  for (const value of [null, [], "policy", { commands: 0 }, { commands: ["true", 1] }, { strictDirty: "false" }, { commandTimeoutMs: 0 }, { portsMustBeFree: [70000] }, { stall: { quietSeconds: -1 } }]) {
    assert.throws(() => mergeValidationConfig(defaultValidationConfig(), value), /validation_config_invalid_shape/);
  }
  const config = mergeValidationConfig(defaultValidationConfig(), { commands: ["npm test"], stall: { autoStop: false } });
  assert.deepEqual(config.commands, ["npm test"]);
  assert.equal(config.stall.autoStop, false);
  assert.equal(config.stall.quietSeconds, 900);
});

test("dirty paths retain spaces, unicode, newlines and rename destinations", () => {
  const paths = parseGitPorcelain("?? .env\0R  new name\nñ.js\0old.js\0 M next.js\0");
  assert.deepEqual(paths, [{ status: "??", path: ".env" }, { status: "R ", path: "new name\nñ.js" }, { status: " M", path: "next.js" }]);
  assert.equal(validationRuleMatches(paths[0].path, [".env"]), true);
  assert.equal(validationRuleMatches("build/output.txt", ["build/"]), true);
  assert.equal(validationRuleMatches("builder/output.txt", ["build/"]), false);
});
