export type DeliveryClassification = "success" | "partial" | "invalid";

export function inferDeliveryClassification(phase: string, requested: unknown): DeliveryClassification {
  const raw = String(requested || "").trim().toLowerCase();
  if (raw === "invalid") return "invalid";
  if (phase === "final_validated" || phase === "council_validated") return raw === "partial" ? "partial" : "success";
  if ([
    "final_revised",
    "needs_corrections",
    "implementation_failed",
    "corrections_failed",
    "council_review_needs_corrections",
    "council_review_failed",
    "council_review_waiting_human",
    "external_validation_failed",
    "external_validation_stopped",
    "external_validation_needs_revision",
    "stopped",
  ].includes(phase)) return "partial";
  return "invalid";
}
