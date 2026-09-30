const PLANNER_RECONSIDERATION_PATTERNS = [
  /Planner reconsideration did not return both DECISIONS and DECOMPOSITION/i,
  /Planner reconsideration decisions could not be materialized/i,
  /Planner reconsideration decomposition could not be materialized/i,
  /Planner reconsideration did not return a usable DECOMPOSITION/i,
];

export function classifyAutomaticImplementationRecovery(input: {
  phase?: string;
  adapter?: string;
  stdout?: string;
  stderr?: string;
  recoveryCount?: number;
  hasIntervention?: boolean;
  pristine?: boolean;
}) {
  if (String(input.phase || "") !== "implementation_failed") return { eligible: false, reason: "phase_not_failed" };
  if (String(input.adapter || "") !== "octopus") return { eligible: false, reason: "adapter_not_octopus" };
  if (Number(input.recoveryCount || 0) >= 1) return { eligible: false, reason: "recovery_limit_reached" };
  if (input.hasIntervention) return { eligible: false, reason: "human_intervention_present" };
  if (input.pristine !== true) return { eligible: false, reason: "worktree_not_pristine" };
  const text = `${input.stdout || ""}\n${input.stderr || ""}`;
  const matched = PLANNER_RECONSIDERATION_PATTERNS.find((pattern) => pattern.test(text));
  if (!matched) return { eligible: false, reason: "failure_not_recognized" };
  return { eligible: true, reason: "planner_reconsideration_contract_failure" };
}
