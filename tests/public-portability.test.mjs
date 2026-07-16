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

test("Gallivanter runtime profile keeps channel destinations configurable", () => {
  assert.match(config, /DEVELOPMENT_CYCLE_STATE_ROOT/);
  assert.match(config, /DEVELOPMENT_CYCLE_OCTOPUS_ROOT/);
  assert.match(config, /DEVELOPMENT_CYCLE_OBSERVER_ENABLED/);
  assert.match(config, /notifications:\s*\{/);
  assert.doesNotMatch(config, /7929509196|notificationTarget:\s*["'][^"']+["']/);
});
