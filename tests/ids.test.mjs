import assert from "node:assert/strict";
import test from "node:test";
import { cleanId, newRunId } from "../dist/core/ids.js";

test("cleanId produces bounded path-safe identifiers", () => {
  assert.equal(cleanId("alpha"), "alpha");
  assert.equal(cleanId("alpha-beta"), "alpha-beta");
  assert.equal(cleanId("  alpha / beta  "), "alpha-beta-a52df7f5");
  assert.equal(cleanId("***", "fallback").startsWith("fallback-"), true);
  assert.equal(cleanId("x".repeat(200)).length, 120);
});

test("cleanId is injective for colliding inputs", () => {
  // Distinct inputs must never collapse to the same id.
  const pairs = [
    ["foo bar", "foo-bar"],
    ["foo/bar", "foo-bar"],
    ["my api", "my-api"],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(cleanId(a), cleanId(b), `${JSON.stringify(a)} collides with ${JSON.stringify(b)}`);
  }
  // Two distinct 121-char names stay distinct after truncation.
  assert.notEqual(cleanId("a".repeat(121)), cleanId("b".repeat(121)));
});

test("newRunId is deterministic with an injected clock", () => {
  const now = new Date("2026-07-16T12:34:56.000Z");
  const id = newRunId("Example Project", now);
  assert.ok(id.startsWith("Example-Project-791490b6-20260716123456000-"));
  const id2 = newRunId("", now);
  assert.ok(id2.startsWith("run-20260716123456000-"));
});

test("newRunId differs within the same second (ms precision)", () => {
  const base = new Date("2026-07-16T12:34:56.000Z");
  const later = new Date("2026-07-16T12:34:56.999Z");
  assert.notEqual(newRunId("Example Project", base), newRunId("Example Project", later));
});
