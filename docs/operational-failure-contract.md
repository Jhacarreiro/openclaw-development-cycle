# Operational failure evidence

Review text, stdout excerpts, prior explanations and application diagnostics do not establish a provider failure. They remain available for inspection; generic unsuccessful executions still use their normal failed phase and exit code.

An implementation adapter can atomically write a bounded JSON record to the runner-owned `DEVELOPMENT_CYCLE_OPERATIONAL_FAILURE_PATH`. The path is also recorded in `request.json`. It is the current attempt's `operational-failure.json`; the classifier never follows a record-supplied path or symlink.

```json
{
  "schemaVersion": 1,
  "attemptId": "current-attempt-id",
  "source": "provider",
  "provider": "configured-provider",
  "failureClass": "rate_limited",
  "errorCode": "HTTP_429",
  "occurredAt": "2026-01-01T00:00:00Z"
}
```

The adapter must derive this record from an actual failed operation, never from model-generated prose. Supported classes are `rate_limited`, `auth_failed`, `billing_or_quota_blocked`, `provider_fleet_failed` and `local_runtime_fault`. `source: "runner"` is limited to local runtime faults. Records are limited to 16 KiB and must belong to the active attempt and its session. Adapters without this optional protocol retain generic failure reporting; the control plane does not guess a provider cause from arbitrary text.

`safeToAutoRetry=false` forbids an automatic new attempt. It does not request cancellation of active work. Main updates now expose `autoStopRecommended` separately. Policy-driven callers should use `stop_implementation` with `stopIntent: "failure-policy"`; this refuses a stop unless that independent recommendation is true. Explicit operator cancellation remains `stopIntent: "manual"` (also the compatibility default).

Old lexical classifications are retracted with an audit record when no current attributed evidence supports them. This neither restarts a stopped run nor deletes its stop reason or worktree. A transient retry, when configured, must back off and preserve completed work; continuation must inspect the remaining tasks rather than reconstructing the implementation from scratch.
