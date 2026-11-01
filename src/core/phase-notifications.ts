export type PhaseNotification = {
  phase: string;
  title: string;
  text: string;
};

const MATERIAL_PHASES: Record<string, { icon: string; label: string; detail?: string }> = {
  implementation_launched: { icon: "🚀", label: "Implementation launched", detail: "Supervised implementation started. For Octopus/Tangle, Design Review runs before implementation work." },
  implementation_running: { icon: "🛠️", label: "Implementation running" },
  implementation_delivered: { icon: "✅", label: "Implementation delivered" },
  implementation_failed: { icon: "❌", label: "Implementation failed" },
  review_infrastructure_failed: { icon: "⚠️", label: "Review infrastructure failed" },
  corrections_launched: { icon: "🔧", label: "Corrections launched" },
  corrections_running: { icon: "🔧", label: "Corrections running" },
  corrections_completed: { icon: "✅", label: "Corrections completed" },
  corrections_failed: { icon: "❌", label: "Corrections failed" },
  external_validation_passed: { icon: "🧪", label: "Mechanical validation passed" },
  external_validation_needs_revision: { icon: "🧪", label: "Mechanical validation needs revision" },
  external_validation_stopped: { icon: "🛑", label: "Mechanical validation stopped" },
  council_validated: { icon: "✅", label: "Council review validated" },
  council_review_needs_corrections: { icon: "📝", label: "Council review needs corrections" },
  council_review_failed: { icon: "❌", label: "Council review failed" },
  waiting_final_validation: { icon: "⏳", label: "Final validation requested" },
  final_validated: { icon: "🎉", label: "Final decision: go" },
  final_revised: { icon: "📝", label: "Final decision: revise" },
  stopped: { icon: "🛑", label: "Development Cycle stopped" },
  delivery_published: { icon: "📦", label: "Repository delivery published" },
  repository_delivery_failed: { icon: "❌", label: "Repository delivery failed" },
  merged: { icon: "🎉", label: "Repository delivery merged" },
  closed_success: { icon: "🎉", label: "Development Cycle closed successfully" },
  closed_partial: { icon: "📝", label: "Development Cycle closed with partial delivery" },
  closed_invalid: { icon: "🛑", label: "Development Cycle closed without valid delivery" },
  closed: { icon: "✅", label: "Development Cycle closed" },
};

const SPECIFIC_NOTIFICATION_PHASES = new Set([
  "implementation_waiting_human",
  "council_review_waiting_human",
]);

export function phaseNotificationForTransition(previous: any, next: any): PhaseNotification | null {
  const before = String(previous?.phase || "");
  const phase = String(next?.phase || "");
  if (!phase || phase === before || SPECIFIC_NOTIFICATION_PHASES.has(phase)) return null;
  const spec = MATERIAL_PHASES[phase];
  if (!spec) return null;
  const project = String(next?.project || previous?.project || "project");
  const runId = String(next?.runId || previous?.runId || "");
  const nextAction = String(next?.nextAction || "").trim();
  const error = String(next?.error || "").trim();
  const lines = [
    `Project: ${project}`,
    runId ? `Run: ${runId}` : "",
    `Phase: ${phase}`,
    spec.detail || "",
    error ? `Error: ${error}` : "",
    nextAction ? `Next: ${nextAction}` : "",
  ].filter(Boolean);
  return {
    phase,
    title: `${spec.icon} ${spec.label} — ${project}`,
    text: lines.join("\n"),
  };
}
