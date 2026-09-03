export const ACTIONS = [
  "status",
  "reconcile",
  "request_plan",
  "record_plan",
  "start_implementation",
  "stop_implementation",
  "resume_finalization",
  "run_final_validation",
  "record_delivery",
  "request_final_validation",
  "record_final_validation",
  "start_corrections",
  "finalize_delivery",
  "close",
] as const;

export type DevelopmentCycleAction = (typeof ACTIONS)[number];

const ALWAYS_ALLOWED = new Set<DevelopmentCycleAction>(["status", "reconcile", "request_plan"]);

const ALLOWED_PHASES: Partial<Record<DevelopmentCycleAction, ReadonlySet<string>>> = {
  record_plan: new Set(["", "waiting_external_plan", "plan_ready_for_implementation"]),
  start_implementation: new Set(["plan_ready_for_implementation", "implementation_failed"]),
  resume_finalization: new Set(["review_infrastructure_failed"]),
  stop_implementation: new Set([
    "implementation_launched",
    "implementation_running",
    "implementation_failed",
    "corrections_launched",
    "corrections_running",
    "corrections_failed",
  ]),
  run_final_validation: new Set([
    "implementation_delivered",
    "corrections_completed",
    "external_validation_failed",
    "external_validation_needs_revision",
  ]),
  record_delivery: new Set(["implementation_launched", "implementation_running", "implementation_failed"]),
  request_final_validation: new Set([
    "implementation_delivered",
    "corrections_completed",
    "external_validation_passed",
  ]),
  record_final_validation: new Set(["waiting_final_validation"]),
  start_corrections: new Set(["needs_corrections", "council_review_needs_corrections"]),
  finalize_delivery: new Set([
    "final_validated",
    "final_revised",
    "needs_corrections",
    "implementation_failed",
    "corrections_failed",
    "council_review_needs_corrections",
    "council_review_failed",
    "council_validated",
    "council_review_waiting_human",
    "external_validation_failed",
    "stopped",
    "repository_delivery_failed",
  ]),
  close: new Set(["merged", "closed_success", "closed_partial", "closed_invalid"]),
};

export type TransitionCheck =
  | { ok: true; action: DevelopmentCycleAction; phase: string }
  | {
      ok: false;
      error: "invalid_phase_transition";
      action: DevelopmentCycleAction;
      phase: string;
      allowedPhases: string[];
    };

export function checkActionTransition(action: DevelopmentCycleAction, phaseInput: unknown): TransitionCheck {
  const phase = String(phaseInput ?? "");
  if (ALWAYS_ALLOWED.has(action)) return { ok: true, action, phase };

  const allowed = ALLOWED_PHASES[action] ?? new Set<string>();
  if (allowed.has(phase)) return { ok: true, action, phase };

  return {
    ok: false,
    error: "invalid_phase_transition",
    action,
    phase,
    allowedPhases: [...allowed].sort(),
  };
}
