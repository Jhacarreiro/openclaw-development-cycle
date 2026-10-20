export function transientRuntimeObservationRecoveryPatch(status: any, currentClassification: any) {
  if (String(status?.failureClass || "") !== "runtime_observation_blocker") return null;
  if (currentClassification?.failureClass) return null;

  const phase = String(status?.phase || "");
  const nextAction = phase === "implementation_launched"
    ? "Continue observing the supervised implementation; no current runtime observation blocker is detected."
    : phase === "corrections_launched"
      ? "Continue observing the supervised corrections; no current runtime observation blocker is detected."
      : phase === "implementation_delivered" && status?.nextAction === status?.failureRecommendedAction
        ? "Run mechanical final validation, then council code review."
        : phase === "corrections_completed" && status?.nextAction === status?.failureRecommendedAction
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
    failureClearedAt: new Date().toISOString(),
    ...(nextAction ? { nextAction } : {}),
  };
}
