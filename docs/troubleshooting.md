# Troubleshooting

## Plugin is not discovered

```bash
npm run build
openclaw plugins inspect development-cycle
openclaw plugins doctor
```

For a development checkout:

```bash
openclaw plugins install --link --force .
openclaw plugins enable development-cycle
```

## Plugin metadata is stale

```bash
npm run plugin:build
npm run plugin:validate
```

## `implementation_command_not_configured`

The default adapter is `command`. Configure an executable:

```bash
export DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND=/absolute/path/to/runner
```

For a harmless test:

```bash
chmod +x examples/command-runner.sh
export DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND="$PWD/examples/command-runner.sh"
```

## Implementation executable is missing or not executable

```bash
printf '%s\n' "$DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND"
test -x "$DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND"
```

For Octopus:

```bash
printf '%s\n' "$DEVELOPMENT_CYCLE_OCTOPUS_ROOT"
test -x "$DEVELOPMENT_CYCLE_OCTOPUS_ROOT/scripts/orchestrate.sh"
```

The `projectRoot` passed to the tool must be an existing source checkout, not the project documentation directory.

## Invalid phase transition

Read state without mutation:

```text
development_cycle action=status project=<project> runId=<run-id>
```

Use the returned `allowedPhases`. Do not edit `status.json` to bypass the state machine.

## Adapter completed but the cycle did not close

This is expected. Adapter exit, validation, and acceptance are separate stages. Run `reconcile`, request final validation, record `go`, `revise`, or `stop`, and then close the cycle.

## Octopus produced output but contextual review says `No changes found to review`

Run `reconcile` first. If and only if the cycle reports:

```text
phase: review_infrastructure_failed
reviewInfrastructureResumeEligible: true
```

then call `resume_finalization` for the same project/run. The tool revalidates the exact Octopus attempt manifest, source repository, integration worktree, and expected run branch before returning to `implementation_delivered`. It persists recovery evidence and requires `run_final_validation` next.

Do not use this path for authentication failures, timeouts, build/test failures, real review findings, missing manifests, or changed output identity. Those remain fail-closed and require their normal recovery path.

## Notifications are skipped

A notification requires:

- notifications enabled globally or `notify=true`;
- a supported `notificationChannel`;
- a valid `notificationTarget`;
- a reachable OpenClaw Gateway, valid Gateway authentication and a configured channel account.

Use `notificationDryRun=true` to validate arguments without sending.

Pending and exhausted notifications are stored under `<state-root>/notification-outbox/`. Inspect `attempts`, `failed` and `lastResult` when delivery fails. Fix the Gateway or channel configuration first. Pending jobs resume after plugin restart; jobs marked `failed: true` require an explicit retry by the operator. Preserve the job's channel, target and payload when resetting `attempts`, `failed` and `nextAttemptAt` for retry. A job may already have reached its recipient if the process crashed before saving acknowledgement.

## Validation stopped or evidence became stale

`external_validation_stopped` can be recovered with `run_final_validation` after fixing the reported blocker. An invalid or rejected validation config stops the gate without executing fallback commands. `finalize_delivery` can instead close that attempt with a partial outcome.

`resume_finalization` requires mechanical validation before requesting final review. `mechanical_validation_required` means that validation has not passed. `validation_evidence_stale` means the attempt, checkout, HEAD, index, tracked diff or untracked content differs from the saved evidence. Run `run_final_validation` again, then repeat final review before acceptance.

## State is unreadable

`state_unreadable` preserves the damaged file and blocks the action. Stop other writers, copy the damaged state for diagnosis, and inspect `status.previous.json`, the last valid state before the latest update. Restore it explicitly only after checking runner state and delivery side effects, then call `reconcile`. The snapshot may precede an external side effect and is not a transaction rollback.

## Observer data is absent

The observer is disabled by default and is not required by the command adapter. Enable it only after configuring compatible helper and hook paths.

## A supervised process does not stop

Use `stop_implementation` rather than killing only the root PID. The plugin stops the process group with a TERM/KILL policy.

New sessions record the Linux boot ID, PID, process group and process start time. Cancellation refuses a missing or changed identity rather than signalling a reused PID. Sessions created before this identity was recorded require operator verification before manual cancellation.

Runner stdout and stderr each retain a current file and one `.previous` file, capped at 16 MiB per file. Very old runner output is rotated away. Audit JSONL files rotate at 8 MiB into compressed files under `event-archives/<event-file>/`; all archives are retained by default. Use the [event history configuration](configuration.md#event-history) to opt into a finite archive count. Run directories and attempt artifacts still require an operator backup and retention policy.

## Public audit fails

```bash
npm run audit:public
```

Remove the reported private address, fixed operator path, local-only branch reference, or credential. Do not add exceptions for real environment values.
