export type CouncilDecision = "go" | "revise" | "stop" | "unknown";

export function parseCouncilDecision(text: string, structuredDecision?: unknown): CouncilDecision {
  const normalized = String(text || "").toLowerCase().replace(/\*\*|__/g, "").replace(/^\s*#{1,6}\s*/gm, "");
  const cleaned = normalized.replace(/\bno (?:blocking|blockers?)\b/g, "pass-signal");
  // Negative evidence takes precedence over positive phrases, including a
  // structured GO. Completion of the review process is not an acceptance.
  if (/\bno[-\s]+go\b|(?:^|\n)\s*(?:(?:decision|verdict|recommendation|result):?\s*)?(?:fail|failed|stop)\b|do not ship|\b(?:tests?|build|validation|review)\s+(?:has\s+)?failed\b/.test(cleaned)) return "stop";
  if (/conditional go|must fix|blocker|before ship|before deploy|revise|high\s+[—-]|critical\s+[—-]|corrections required/.test(cleaned)) return "revise";
  const explicit = String(structuredDecision || "").trim().toLowerCase();
  if (["go", "pass", "approved"].includes(explicit)) return "go";
  if (["revise", "conditional go"].includes(explicit)) return "revise";
  if (["stop", "fail", "no-go", "rejected"].includes(explicit)) return "stop";
  if (explicit) return "unknown";
  if (/\b(?:pass-signal|ready to ship|ship as-is)\b|(?:^|\n)\s*(?:(?:decision|verdict|recommendation):?\s*)?go\b/.test(cleaned)) return "go";
  return "unknown";
}

export function councilNeedsCorrectionsText(text: string): boolean {
  return parseCouncilDecision(text) !== "go";
}

export function resolveAutoCouncilCorrectionsMax(value: unknown): number {
  if (value === undefined || value === null || value === "") return 2;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(0, parsed);
}
