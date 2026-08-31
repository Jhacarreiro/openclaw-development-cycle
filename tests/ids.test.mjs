import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import test from "node:test";
import { cleanId, idPathCandidates, legacyCleanId, newRunId } from "../dist/core/ids.js";

const ALPHA_BETA_RAW = "  alpha / beta  ";
const ALPHA_BETA_DIGEST = createHash("sha256").update(ALPHA_BETA_RAW).digest("hex");
const EXAMPLE_PROJECT_DIGEST = createHash("sha256").update("Example Project").digest("hex");

test("cleanId produces bounded path-safe identifiers", () => {
  assert.equal(cleanId("alpha"), "alpha");
  assert.equal(cleanId("alpha-beta"), "alpha-beta");
  assert.equal(cleanId(ALPHA_BETA_RAW), `alpha-beta-id-${ALPHA_BETA_DIGEST}`);
  assert.equal(cleanId("***", "fallback"), `fallback-id-${createHash("sha256").update("***").digest("hex")}`);
  assert.equal(cleanId("x".repeat(200)).length, 120);
  assert.match(cleanId("x".repeat(200)), /^x{52}-id-[0-9a-f]{64}$/);
});

test("cleanId disambiguates colliding sanitized inputs", () => {
  const pairs = [
    ["foo bar", "foo-bar"],
    ["foo/bar", "foo-bar"],
    ["my api", "my-api"],
    [" foo", "foo"],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(cleanId(a), cleanId(b), `${JSON.stringify(a)} collides with ${JSON.stringify(b)}`);
  }
  assert.notEqual(cleanId("a".repeat(121)), cleanId("b".repeat(121)));
});

test("cleanId distinguishes the eight-hex digest collision class", () => {
  const a = "+=@ !foo";
  const b = "foo#@!= ";
  assert.equal(legacyCleanId(a), "foo");
  assert.equal(legacyCleanId(b), "foo");
  assert.equal(createHash("sha256").update(a).digest("hex").slice(0, 8), "01df1767");
  assert.equal(createHash("sha256").update(b).digest("hex").slice(0, 8), "01df1767");
  assert.notEqual(cleanId(a), cleanId(b));
  assert.equal(cleanId(a), `foo-id-${createHash("sha256").update(a).digest("hex")}`);
  assert.equal(cleanId(b), `foo-id-${createHash("sha256").update(b).digest("hex")}`);
});

test("cleanId does not emit path traversal tokens", () => {
  assert.notEqual(cleanId("."), ".");
  assert.notEqual(cleanId(".."), "..");
  assert.notEqual(cleanId("..."), "...");
  assert.equal(cleanId("."), "run");
  assert.equal(cleanId(".."), "run");
  assert.equal(cleanId("..."), "run");
  const root = "/tmp/ocl-state";
  const dir = join(root, "runs", cleanId(".."), cleanId("rid"));
  const rel = relative(join(root, "runs"), dir);
  assert.ok(rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"));
});

test("idPathCandidates preserve the pre-digest sanitized name", () => {
  assert.deepEqual(idPathCandidates("alpha"), ["alpha"]);
  assert.deepEqual(idPathCandidates("Project / One"), [cleanId("Project / One"), "Project-One"]);
  assert.deepEqual(idPathCandidates(".."), ["run"]);
});

test("newRunId is deterministic with an injected clock", () => {
  const now = new Date("2026-07-16T12:34:56.000Z");
  const id = newRunId("Example Project", now);
  assert.ok(id.startsWith(`Example-Project-id-${EXAMPLE_PROJECT_DIGEST}-20260716123456000-`));
  const id2 = newRunId("", now);
  assert.ok(id2.startsWith("run-20260716123456000-"));
});

test("newRunId differs within the same second (ms precision)", () => {
  const base = new Date("2026-07-16T12:34:56.000Z");
  const later = new Date("2026-07-16T12:34:56.999Z");
  assert.notEqual(newRunId("Example Project", base), newRunId("Example Project", later));
});

test("newRunId stays within the bounded path contract", () => {
  const now = new Date("2026-07-16T12:34:56.000Z");
  const longClean = "a".repeat(96);
  const id = newRunId(longClean, now);
  assert.ok(id.length <= 120, id);
  assert.equal(cleanId(id), id);
  assert.match(id, /20260716123456000-[0-9a-z]{6}$/);
});

test("cleanId digest namespace does not collide with a clean lookalike", () => {
  const hashed = cleanId("foo ");
  assert.match(hashed, /-id-[0-9a-f]{64}$/);
  assert.equal(cleanId(hashed), hashed);
  const lookalike = `foo-${createHash("sha256").update("foo ").digest("hex")}`;
  assert.notEqual(cleanId(lookalike), hashed);
  assert.equal(cleanId(lookalike), lookalike);
});
