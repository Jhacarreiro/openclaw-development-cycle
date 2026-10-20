export function transientRuntimeObservationRecoveryPatch(status: any, currentClassification: any) {
  if (String(status?.failureClass || "") !== "runtime_observation_blocker") return null;
  if (currentClassification?.failureClass) return null;

  const phase = String(status?.phase || "");
  // The blocker replaced the phase's next action; give it back unless something else has set one since.
  const blockerStillDirects = status?.nextAction === status?.failureRecommendedAction;
  const nextAction = phase === "implementation_launched"
    ? "Continue observing the supervised implementation; no current runtime observation blocker is detected."
    : phase === "corrections_launched"
      ? "Continue observing the supervised corrections; no current runtime observation blocker is detected."
      : !blockerStillDirects
        ? null
        : status?.failureReplacedNextAction
          ? status.failureReplacedNextAction
          : phase === "implementation_delivered"
            ? "Run mechanical final validation, then council code review."
            : phase === "corrections_completed"
              ? "Run mechanical validation and council code review again for the corrected delivery."
              : null;

  return {
    failureClass: null,
    failureSeverity: null,
    failureHumanRequired: null,
    failureSafeToAutoRetry: null,
    failureAutoStopRecommended: null,
    failureRecommendedAction: null,
    failureMatched: null,
    failureDetectedAt: null,
    failureReplacedNextAction: null,
    failureClearedAt: new Date().toISOString(),
    ...(nextAction ? { nextAction } : {}),
  };
}
