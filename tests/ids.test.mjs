import assert from "node:assert/strict";
import test from "node:test";
import { cleanId, newRunId } from "../dist/core/ids.js";

test("cleanId produces bounded path-safe identifiers", () => {
  assert.equal(cleanId("  alpha / beta  "), "alpha-beta");
  assert.equal(cleanId("***", "fallback"), "fallback");
  assert.equal(cleanId("x".repeat(200)).length, 120);
});

test("newRunId is deterministic with an injected clock", () => {
  const now = new Date("2026-07-16T12:34:56.000Z");
  assert.equal(newRunId("Example Project", now), "Example-Project-20260716123456");
  assert.equal(newRunId("", now), "run-20260716123456");
});
