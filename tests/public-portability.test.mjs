import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const config = await readFile(new URL("../src/config.ts", import.meta.url), "utf8");

test("notifications use generic OpenClaw channel parameters", () => {
  assert.match(source, /notificationChannel/);
  assert.match(source, /notificationTarget/);
  assert.match(source, /developmentCycleConfig\.openclawBin/);
  assert.doesNotMatch(source, /telegramTarget|notifyTelegram|sendCycleTelegram/);
  assert.doesNotMatch(source, /--channel["',\s]+telegram/);
});

test("portable defaults do not embed a private network or fixed operator path", () => {
  const combined = `${source}\n${config}`;
  assert.doesNotMatch(combined, /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/);
  assert.doesNotMatch(combined, /\/(?:data|home)\/[A-Za-z0-9._-]+\/(?:workspace|\.openclaw)(?:\/|\b)/);
  assert.match(config, /\.openclaw", "development-cycle/);
  assert.match(config, /notifications:\s*\{/);
  assert.match(config, /OBSERVER_ENABLED", false/);
});
