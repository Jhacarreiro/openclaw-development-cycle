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

const DIGEST_MARK = "-id-";
const DIGEST_PATTERN = /-id-[0-9a-f]{64}$/;

export function isCanonicalId(input: unknown): boolean {
  return DIGEST_PATTERN.test(String(input ?? ""));
}

export function cleanId(input: unknown, fallback = "run", maxLength = CLEAN_ID_MAX_LENGTH): string {
  const raw = String(input ?? "");
  const trimmed = raw.trim();
  // Reserved canonical handles are opaque API values. Reusing one exactly
  // must be idempotent; inputs that only sanitize to this shape are handled
  // below as distinct identities and may not claim the reserved path.
  if (raw === trimmed && isCanonicalId(raw)) return raw;
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
  const alreadyReserved = DIGEST_PATTERN.test(base);
  // Reserve the digest-shaped namespace too. A literal clean input such as
  // "foo-id-<sha256>" must not alias the canonical identifier generated for
  // some different raw input. Marker-shaped literals are escaped by hashing
  // their own raw bytes and preserving the legacy path as a read fallback.
  const needsIdentity = !emptyInput && (raw !== sanitized || !sanitized || raw.length > maxLength || alreadyReserved);
  if (!needsIdentity) return base;

  const digest = identityDigest(raw);
  const suffix = `${DIGEST_MARK}${digest}`;
  const prefixLength = maxLength - suffix.length;
  if (prefixLength < 1) return digest.slice(0, maxLength);
  const prefix = (alreadyReserved ? base.replace(DIGEST_PATTERN, "") : base).slice(0, prefixLength);
  return `${prefix}${suffix}`;
}

export function idPathCandidates(input: unknown, fallback = "run", maxLength = CLEAN_ID_MAX_LENGTH): string[] {
  const next = cleanId(input, fallback, maxLength);
  const prev = legacyCleanId(input, fallback, maxLength);
  if (prev === next || /^\.+$/.test(prev) || isCanonicalId(prev)) return [next];
  return [next, prev];
}

export function projectPathCandidates(input: unknown, fallback = "run", maxLength = CLEAN_ID_MAX_LENGTH): string[] {
  const raw = String(input ?? "");
  if (isCanonicalId(raw)) return [raw];
  return idPathCandidates(input, fallback, maxLength);
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
  const rawProject = String(project ?? "");
  const projectPrefix = isCanonicalId(rawProject)
    ? rawProject.slice(0, RUN_PROJECT_PREFIX_MAX)
    : cleanId(project, "run", RUN_PROJECT_PREFIX_MAX);
  return `${projectPrefix}-${timestamp}-${tiebreaker}`;
}
