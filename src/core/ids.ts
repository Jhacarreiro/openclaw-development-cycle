import { createHash } from "node:crypto";

export function cleanId(input: unknown, fallback = "run", maxLength = 120): string {
  const raw = String(input ?? "");
  const trimmed = raw.trim();
  const cleaned = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  const base = cleaned || fallback;
  // Preserve injectivity: when sanitization actually changed the input
  // (disallowed chars replaced, edges trimmed, or truncation) append a
  // digest of the RAW input so distinct inputs can never collapse to the
  // same id ("foo bar" vs "foo-bar" both sanitize to "foo-bar"). Inputs
  // that are already clean pass through unchanged.
  if (cleaned !== trimmed || raw.length > maxLength) {
    const digest = createHash("sha256").update(raw).digest("hex").slice(0, 8);
    return `${base.slice(0, Math.max(1, maxLength - 9))}-${digest}`;
  }
  return base;
}

export function newRunId(project: unknown, now = new Date()): string {
  // Millisecond precision + random tiebreaker: second precision meant two
  // parallel plan requests for one project within the same second produced
  // the identical run id and therefore the identical run directory (status
  // overwrite / mixed plans); ms precision alone still collides when two
  // requests land in the same millisecond.
  const timestamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
  const tiebreaker = Math.random().toString(36).slice(2, 8);
  return `${cleanId(project)}-${timestamp}-${tiebreaker}`;
}
