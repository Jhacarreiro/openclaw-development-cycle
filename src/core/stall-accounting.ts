export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;

export type StallQuietAccountingInput = {
  nowMs: number;
  activityLatestMs: number;
  stallQuietAccumMs: number;
  stallLastCheckAt: number;
  stallLastActivityMtime: number;
  quietThresholdMs: number;
  heartbeatIntervalMs: number;
};

export type StallQuietAccounting = {
  stallQuietAccumMs: number;
  stallLastCheckAt: number;
  stallLastActivityMtime: number;
  shouldStop: boolean;
};

export function stallQuietCapMs(heartbeatIntervalMs: number): number {
  const heartbeat =
    Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0
      ? heartbeatIntervalMs
      : DEFAULT_HEARTBEAT_INTERVAL_SECONDS * 1000;
  return Math.max(heartbeat * 3, 1000);
}

export function nextStallQuietAccounting(input: StallQuietAccountingInput): StallQuietAccounting {
  const nowMs = Number(input.nowMs);
  const activityLatestMs = Number(input.activityLatestMs || 0);
  const prevAccum = Math.max(0, Number(input.stallQuietAccumMs || 0));
  const lastCheck = Number(input.stallLastCheckAt || 0);
  const lastActivityMtime = Number(input.stallLastActivityMtime || 0);
  const quietThresholdMs = Number(input.quietThresholdMs);
  const capMs = stallQuietCapMs(Number(input.heartbeatIntervalMs));
  const threshold = Number.isFinite(quietThresholdMs) && quietThresholdMs > 0 ? quietThresholdMs : 0;

  // Fresh activity is a changed artifact mtime, not (now - mtime) < threshold.
  // The wall-clock comparison hides backward clock jumps and delays
  // accumulation until the threshold has already elapsed.
  if (lastActivityMtime > 0 && activityLatestMs !== lastActivityMtime) {
    return {
      stallQuietAccumMs: 0,
      stallLastCheckAt: nowMs,
      stallLastActivityMtime: activityLatestMs,
      shouldStop: false,
    };
  }

  let delta = lastCheck > 0 ? nowMs - lastCheck : 0;
  if (delta < 0) delta = 0;
  if (delta > capMs) delta = capMs;

  const stallQuietAccumMs = threshold > 0 ? Math.min(prevAccum + delta, threshold) : prevAccum + delta;
  return {
    stallQuietAccumMs,
    stallLastCheckAt: nowMs,
    stallLastActivityMtime: activityLatestMs || lastActivityMtime,
    shouldStop: threshold > 0 && stallQuietAccumMs >= threshold,
  };
}
