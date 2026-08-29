export function councilNeedsCorrectionsText(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  const cleaned = normalized.replace(/\bno (?:blocking|blockers?)\b/g, "pass-signal");
  if (/\b(pass-signal|ready to ship|ship as-is|go\b)/i.test(cleaned)
      && !/conditional go|must fix|blocker|before ship|before deploy|high\s+[—-]|critical\s+[—-]/i.test(cleaned)) {
    return false;
  }
  return /conditional go|must fix|blocker|before ship|before deploy|do not ship|revise|high\s+[—-]|critical\s+[—-]/i.test(cleaned)
    || cleaned.includes("corrections required");
}

export function resolveAutoCouncilCorrectionsMax(value: unknown): number {
  if (value === undefined || value === null || value === "") return 2;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(0, parsed);
}
