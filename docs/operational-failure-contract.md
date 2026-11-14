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

The adapter must derive this record from an actual failed operation, never from model-generated prose. Supported classes are `rate_limited`, `turn_limit_reached`, `continuation_limit_reached`, `auth_failed`, `billing_or_quota_blocked`, `provider_fleet_failed` and `local_runtime_fault`. `source: "runner"` is limited to local runtime faults. Records are limited to 16 KiB and must belong to the active attempt and its session. Adapters without this optional protocol retain generic failure reporting; the control plane does not guess a provider cause from arbitrary text.

## Execution limits and account limits

| Class | Required meaning | Recovery guidance |
| --- | --- | --- |
| `turn_limit_reached` | The failed operation reached its CLI/agent turn ceiling | Preserve progress and continue remaining tasks within an approved bounded policy |
| `continuation_limit_reached` | The failed operation exhausted its continuation allowance without a final response | Preserve progress and resume the unfinished stage; unavailable verification remains unverified |
| `rate_limited` | Attributed provider request throttling | Observe other active work and use the provider's backoff policy |
| `billing_or_quota_blocked` | Attributed account billing or financial/service quota failure | Resolve that actual account blocker before continuation |

The canonical execution-limit codes are `TURN_LIMIT_REACHED` and
`CONTINUATION_LIMIT_REACHED`. A receipt pairing either with another class is
rejected. Adapters may retain provider-specific error codes with the correct
explicit limit class. CLI exit numbers are provider/version specific: code 8 or
9 alone is not a universal meaning. The word "budget" alone is not financial
evidence, and event byte growth is not a turn counter.

These classes clarify evidence already supplied by an adapter; they do not add
CLI telemetry, infer limits from log text, or implement early checkpointing.
When the adapter cannot verify the cause, retain the raw exit/result evidence
with a generic failure rather than claiming exhausted account balance.

Both execution-limit classes prohibit a blind in-place retry and do not request
cancelling other active workers. A later continuation needs preserved work,
fresh PR/head and issue checks, stage-specific remaining tasks and its own
approved generation/resource bounds. Raising turn limits, changing models or
merging partial code is not authorized by the classification.

The [execution-budget recovery proposal](execution-budget-recovery.md) separates
this classification from future proactive checkpoints and bounded continuation.

`safeToAutoRetry=false` forbids an automatic new attempt. It does not request cancellation of active work. Main updates now expose `autoStopRecommended` separately. Policy-driven callers should use `stop_implementation` with `stopIntent: "failure-policy"`; this refuses a stop unless that independent recommendation is true. Explicit operator cancellation remains `stopIntent: "manual"` (also the compatibility default).

Old lexical classifications are retracted with an audit record when no current attributed evidence supports them. This neither restarts a stopped run nor deletes its stop reason or worktree. A transient retry, when configured, must back off and preserve completed work; continuation must inspect the remaining tasks rather than reconstructing the implementation from scratch.
