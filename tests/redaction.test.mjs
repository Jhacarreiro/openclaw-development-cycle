import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

function extractRedactRemoteCredentials() {
  const match = source.match(/function redactRemoteCredentials[\s\S]*?\n}/);
  assert.ok(match, "redactRemoteCredentials source not found");
  const fnText = match[0].replace(/\(text: string\)/, "(text)");
  // eslint-disable-next-line no-new-func
  return new Function(`return (${fnText});`)();
}

test("redactRemoteCredentials scrubs userinfo through the LAST @ before the host", () => {
  const redact = extractRedactRemoteCredentials();
  // userinfo that itself contains '@' must not leak past the redaction point
  assert.equal(redact("https://user:token@part@host/repo.git"), "https://***@host/repo.git");
  assert.equal(redact("https://alice:pw@one@two@example.com/x.git"), "https://***@example.com/x.git");
  // single-segment userinfo still redacted
  assert.equal(redact("https://user:token@host/repo.git"), "https://***@host/repo.git");
  assert.equal(redact("https://user@host/repo.git"), "https://***@host/repo.git");
  assert.equal(redact("ssh://git@github.com/org/repo.git"), "ssh://***@github.com/org/repo.git");
  // URLs without userinfo are untouched
  assert.equal(redact("https://host/repo.git"), "https://host/repo.git");
  assert.equal(redact(""), "");
  assert.equal(redact(null), "");
});
