import { createHash } from "node:crypto";

export const CLEAN_ID_MAX_LENGTH = 120;

const RUN_TIMESTAMP_LENGTH = 17;
const RUN_TIEBREAKER_LENGTH = 6;
const RUN_ID_SUFFIX_LENGTH = 1 + RUN_TIMESTAMP_LENGTH + 1 + RUN_TIEBREAKER_LENGTH;
const RUN_PROJECT_PREFIX_MAX = CLEAN_ID_MAX_LENGTH - RUN_ID_SUFFIX_LENGTH;

export function legacyCleanId(input: unknown, fallback = "run", maxLength = CLEAN_ID_MAX_LENGTH): string {
  const cleaned = String(input ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return cleaned || fallback;
}

function identityDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function cleanId(input: unknown, fallback = "run", maxLength = CLEAN_ID_MAX_LENGTH): string {
  const raw = String(input ?? "");
  const trimmed = raw.trim();
  const sanitized = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  // path.join treats "." / ".." as traversal; never emit them as directory names.
  const dotToken = /^\.+$/.test(sanitized);
  // Match current main: ".", "..", and pure-dot tokens map to the stable
  // fallback so existing runs/run state stay discoverable after upgrade.
  if (dotToken) return fallback;
  const base = sanitized ? sanitized : fallback;
  const emptyInput = !trimmed;
  const needsIdentity = !emptyInput && (raw !== sanitized || !sanitized || raw.length > maxLength);
  if (!needsIdentity) return base;

  const digest = identityDigest(raw);
  const prefixLength = maxLength - digest.length - 1;
  if (prefixLength < 1) return digest.slice(0, maxLength);
  return `${base.slice(0, prefixLength)}-${digest}`;
}

export function idPathCandidates(input: unknown, fallback = "run", maxLength = CLEAN_ID_MAX_LENGTH): string[] {
  const next = cleanId(input, fallback, maxLength);
  const prev = legacyCleanId(input, fallback, maxLength);
  if (prev === next || /^\.+$/.test(prev)) return [next];
  return [next, prev];
}

export function newRunId(project: unknown, now = new Date()): string {
  // Millisecond precision + random tiebreaker: second precision meant two
  // parallel plan requests for one project within the same second produced
  // the identical run id and therefore the identical run directory (status
  // overwrite / mixed plans); ms precision alone still collides when two
  // requests land in the same millisecond.
  // Bound the project prefix so the full id stays <= 120 and a later cleanId
  // pass cannot drop the timestamp or tiebreaker.
  const timestamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, RUN_TIMESTAMP_LENGTH);
  const tiebreaker = Math.random().toString(36).slice(2, 8).padEnd(RUN_TIEBREAKER_LENGTH, "0");
  return `${cleanId(project, "run", RUN_PROJECT_PREFIX_MAX)}-${timestamp}-${tiebreaker}`;
}
