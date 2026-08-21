import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  nextStallQuietAccounting,
  stallQuietCapMs,
} from "../dist/core/stall-accounting.js";

const configuredHeartbeatMs = DEFAULT_HEARTBEAT_INTERVAL_SECONDS * 1000;
const quietThresholdMs = 900_000;

function account(overrides = {}) {
  const activityLatestMs = overrides.activityLatestMs ?? 900_000;
  return nextStallQuietAccounting({
    nowMs: 1_000_000,
    stallQuietAccumMs: 0,
    stallLastCheckAt: 970_000,
    stallLastActivityMtime: activityLatestMs,
    quietThresholdMs,
    heartbeatIntervalMs: configuredHeartbeatMs,
    activityLatestMs,
    ...overrides,
  });
}

test("configured heartbeat cap is three 30-second intervals", () => {
  assert.equal(DEFAULT_HEARTBEAT_INTERVAL_SECONDS, 30);
  assert.equal(stallQuietCapMs(configuredHeartbeatMs), 90_000);
  assert.equal(stallQuietCapMs(0), 90_000);
  assert.equal(stallQuietCapMs(Number.NaN), 90_000);
  assert.equal(stallQuietCapMs(60_000), 180_000);
});

test("forward clock jump adds only the configured heartbeat cap", () => {
  const lastCheck = 1_000_000;
  const activityLatestMs = 990_000;
  const next = account({
    stallLastCheckAt: lastCheck,
    stallLastActivityMtime: activityLatestMs,
    stallQuietAccumMs: 10_000,
    activityLatestMs,
    nowMs: lastCheck + 25 * 60 * 1000,
  });
  assert.equal(next.stallQuietAccumMs, 10_000 + 90_000);
  assert.equal(next.stallLastCheckAt, lastCheck + 25 * 60 * 1000);
  assert.equal(next.stallLastActivityMtime, activityLatestMs);
  assert.equal(next.shouldStop, false);
});

test("backward clock jump keeps the accumulator and re-anchors last check", () => {
  const activityLatestMs = 1_999_000;
  const next = account({
    nowMs: 50_000,
    activityLatestMs,
    stallLastActivityMtime: activityLatestMs,
    stallQuietAccumMs: 120_000,
    stallLastCheckAt: 2_000_000,
  });
  assert.equal(next.stallQuietAccumMs, 120_000);
  assert.equal(next.stallLastCheckAt, 50_000);
  assert.equal(next.stallLastActivityMtime, activityLatestMs);
  assert.equal(next.shouldStop, false);

  const later = account({
    nowMs: 80_000,
    activityLatestMs,
    stallLastActivityMtime: next.stallLastActivityMtime,
    stallQuietAccumMs: next.stallQuietAccumMs,
    stallLastCheckAt: next.stallLastCheckAt,
  });
  assert.equal(later.stallQuietAccumMs, 150_000);
  assert.equal(later.shouldStop, false);
});

test("fresh activity resets both persisted accounting fields", () => {
  const nowMs = 200_100;
  const next = account({
    nowMs,
    activityLatestMs: 200_000,
    stallLastActivityMtime: 90_000,
    stallQuietAccumMs: 60_000,
    stallLastCheckAt: 100_000,
  });
  assert.equal(next.stallQuietAccumMs, 0);
  assert.equal(next.stallLastCheckAt, nowMs);
  assert.equal(next.stallLastActivityMtime, 200_000);
  assert.equal(next.shouldStop, false);

  const afterQuiet = account({
    nowMs: nowMs + 30_000,
    activityLatestMs: 200_000,
    stallLastActivityMtime: next.stallLastActivityMtime,
    stallQuietAccumMs: next.stallQuietAccumMs,
    stallLastCheckAt: next.stallLastCheckAt,
  });
  assert.equal(afterQuiet.stallQuietAccumMs, 30_000);
  assert.equal(afterQuiet.shouldStop, false);
});

test("quiet time accumulates before wall-clock quiet reaches the threshold", () => {
  const lastCheck = 100_000;
  const activityLatestMs = lastCheck - 1_000;
  const next = account({
    nowMs: lastCheck + 30_000,
    activityLatestMs,
    stallLastActivityMtime: activityLatestMs,
    stallQuietAccumMs: 0,
    stallLastCheckAt: lastCheck,
  });
  assert.equal(next.stallQuietAccumMs, 30_000);
  assert.equal(next.shouldStop, false);
});

test("accumulated quiet time still stops a real stall", () => {
  const next = account({
    nowMs: 1_030_000,
    activityLatestMs: 100_000,
    stallLastActivityMtime: 100_000,
    stallQuietAccumMs: 870_000,
    stallLastCheckAt: 1_000_000,
  });
  assert.equal(next.stallQuietAccumMs, quietThresholdMs);
  assert.equal(next.shouldStop, true);
});

test("first check only anchors the clock and does not count as quiet", () => {
  const nowMs = 500_000;
  const next = account({
    nowMs,
    activityLatestMs: 100_000,
    stallLastActivityMtime: 0,
    stallQuietAccumMs: 0,
    stallLastCheckAt: 0,
  });
  assert.equal(next.stallQuietAccumMs, 0);
  assert.equal(next.stallLastCheckAt, nowMs);
  assert.equal(next.stallLastActivityMtime, 100_000);
  assert.equal(next.shouldStop, false);
});

test("stall detector uses extracted accounting and the configured heartbeat", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /nextStallQuietAccounting/);
  assert.match(source, /runnerHeartbeatIntervalSeconds/);
  assert.match(source, /stallLastActivityMtime/);
  assert.doesNotMatch(source, /naiveQuietMs/);
  assert.doesNotMatch(source, /heartbeatIntervalSeconds \|\| 60/);
});
