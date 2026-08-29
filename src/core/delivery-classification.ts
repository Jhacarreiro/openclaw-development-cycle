export type DeliveryClassification = "success" | "partial" | "invalid";

export function inferDeliveryClassification(phase: string, requested: unknown): DeliveryClassification {
  const raw = String(requested || "").trim().toLowerCase();
  if (raw === "success" || raw === "partial" || raw === "invalid") return raw;
  if (phase === "final_validated" || phase === "council_validated") return "success";
  if ([
    "needs_corrections",
    "implementation_failed",
    "corrections_failed",
    "council_review_needs_corrections",
    "council_review_failed",
    "council_review_waiting_human",
    "external_validation_failed",
    "stopped",
  ].includes(phase)) return "partial";
  return "invalid";
}
