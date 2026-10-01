# OpenClaw Development Cycle

[![CI](https://github.com/Jhacarreiro/openclaw-development-cycle/actions/workflows/ci.yml/badge.svg)](https://github.com/Jhacarreiro/openclaw-development-cycle/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An experimental OpenClaw control plane for durable software-development cycles. It keeps durable state, enforces workflow transitions, supervises implementation processes, gathers evidence, and supports correction loops. The architecture is intended to support both human-supervised and policy-driven automatic cycles.

The control plane is implementation-runner agnostic. A generic command adapter is the default. Octopus is available as an optional adapter.

## Workflow

The plugin registers one OpenClaw tool, `development_cycle`:

1. create a planning request and context pack;
2. record an approved implementation plan;
3. start a configured implementation adapter;
4. monitor or reconcile the supervised process;
5. collect delivery and validation evidence;
6. record `go`, `revise`, or `stop` according to the supervising human or automation policy;
7. run targeted corrections when required;
8. close the cycle.

State is persisted under `$HOME/.openclaw/development-cycle` by default, so runs survive OpenClaw turns and process restarts.

### Supervision modes

The state machine is designed to support two operating styles:

- **Human-supervised** — an operator or supervising agent explicitly records the final `go`, `revise`, or `stop` decision.
- **Policy-driven automatic** — automation may derive and record the same state-machine decision when an external policy allows a fully automatic cycle.

The public tool API represents the final decision explicitly through `record_final_validation`; automation should use that same action rather than bypassing the state machine.

## Status

Experimental. The state machine, storage, adapters, shell quoting, and process-supervision boundaries are tested. Use a disposable or backed-up checkout for initial evaluation.

## Requirements

- Linux with `/proc/self/fd` support for guarded project-root filesystem operations
- `projectRoot` must be an existing Git checkout for implementation and mechanical validation actions
- Node.js 22.22.3+ on the 22.x line or 24.15.0+ on the 24.x line (the CI-tested versions supported by the pinned OpenClaw dependency)
- Python 3
- `jq`
- GNU coreutils `timeout` for validation, council and delivery command process groups
- OpenClaw `2026.5.17` or newer
- an executable implementation adapter

The filesystem hardening deliberately fails closed when `projectRoot` is not a trusted Git checkout or when the host cannot provide the Linux descriptor-path semantics used to pin the checkout during reads, handoff, and validation execution.

## Install

```bash
git clone https://github.com/Jhacarreiro/openclaw-development-cycle.git
cd openclaw-development-cycle
npm ci
npm run build
openclaw plugins install --link .
openclaw plugins enable development-cycle
openclaw plugins doctor
```

## Quickstart without Octopus

The repository includes a harmless example command adapter. It reads the cycle request and writes an example delivery artifact without modifying the source checkout.

```bash
chmod +x examples/command-runner.sh
export DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER=command
export DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND="$PWD/examples/command-runner.sh"
```

A command adapter is invoked as:

```text
<configured command> [configured arguments...] <request.json>
```

The request contains:

```json
{
  "schemaVersion": 1,
  "project": "example",
  "runId": "example-20260716",
  "mode": "delivery",
  "projectRoot": "/path/to/source-checkout",
  "promptPath": "/path/to/prompt.txt",
  "planPath": "/path/to/implementation_plan.md",
  "validationPath": "",
  "resultsRoot": "/path/to/run",
  "timeoutSeconds": 7200,
  "command": "implement"
}
```

The same values are exposed as `DEVELOPMENT_CYCLE_*` environment variables.

## Basic usage

OpenClaw agents call the tool in sequence:

```text
development_cycle action=request_plan project=my-project projectRoot=/path/to/repo

development_cycle action=record_plan project=my-project runId=<run-id> planPath=/path/to/implementation-plan.md

development_cycle action=start_implementation project=my-project runId=<run-id> projectRoot=/path/to/repo

development_cycle action=reconcile project=my-project runId=<run-id>

development_cycle action=request_final_validation project=my-project runId=<run-id>

development_cycle action=record_final_validation project=my-project runId=<run-id> validationText="go\nValidated by the operator."

development_cycle action=close project=my-project runId=<run-id>
```

`start_implementation` is the host's explicit authorization to execute the already-approved plan for that run. Generic plan wording such as `draft for human approval`, `after human approval`, or `do not start until approved` is therefore satisfied by the action itself and must not trigger a second approval gate. If a new risky/protected/out-of-scope decision arises after launch, the implementation must use the structured intervention protocol (`intervention.json` -> `implementation_waiting_human` -> `answer_intervention`) rather than leaving the request only as prose in review output.

Final validation records exactly one state-machine decision token, whether supplied by a human supervisor or by approved automation:

```text
go
revise
stop
```

`go` produces a successful terminal delivery. `revise` is also terminal for the current plan: the implementation is materialized as a partial delivery and unresolved findings become follow-up work (for example repository issues or a new development plan). It does not automatically launch another correction attempt. `stop` materializes a stopped/partial outcome when repository delivery policy permits it.

## Actions

| Action | Purpose |
| --- | --- |
| `request_plan` | Create a planning request and context pack. |
| `record_plan` | Persist an approved implementation plan. |
| `start_implementation` | Launch the configured adapter. |
| `status` | Read persisted state without mutation. |
| `reconcile` | Refresh runtime state and apply enabled follow-up behavior. |
| `stop_implementation` | Stop the supervised process group. |
| `resume_finalization` | Revalidate a preserved Octopus output after a narrowly classified review-infrastructure-only failure; never relaunches implementation. |
| `record_delivery` | Record externally supplied delivery evidence. |
| `run_final_validation` | Run configured validation commands. |
| `request_final_validation` | Build the final validation pack. |
| `record_final_validation` | Record `go`, `revise`, or `stop`. |
| `start_corrections` | Optional/manual targeted correction pass for legacy or explicitly supervised correction workflows. A final `revise` no longer launches corrections automatically. |
| `close` | Close a validated or stopped cycle. |

Invalid phase transitions are rejected by the state machine.

When an Octopus attempt exits non-zero only because contextual review infrastructure explicitly reports `No changes found to review`, while a trusted Tangle output handoff is already materialized, `reconcile` records `review_infrastructure_failed` instead of flattening the run into a generic implementation failure. The output is preserved and marked resume-eligible. `resume_finalization` revalidates the exact attempt manifest, source checkout, worktree, and branch before moving back to `implementation_delivered`; `run_final_validation` is still mandatory before final review or repository delivery. Other non-zero failures do not use this recovery path.

### Approved-plan normalization

`record_plan` validates semantic plan requirements separately from formatting. Alternate headings are normalized only when implementation tasks, validation checks, stop conditions, expected artifacts, and relevant project paths are already present. The approved source plan is preserved verbatim under the canonical envelope.

If semantic content is genuinely missing, `record_plan` fails with `plan_incomplete` and reports the missing fields instead of inventing them. `force=true` remains an explicit escape hatch and records unresolved gaps in `status.planValidation`.

## Implementation adapters

### Command adapter — default

Configure any executable that accepts the request JSON path:

```bash
export DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER=command
export DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND=/path/to/runner
export DEVELOPMENT_CYCLE_IMPLEMENTATION_ARGS_JSON='["--format","json"]'
```

This can wrap Codex CLI, Claude Code, Aider, a company runner, a CI dispatcher, or any other local executable.

### Octopus adapter — optional

```bash
export DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER=octopus
export DEVELOPMENT_CYCLE_OCTOPUS_ROOT=/path/to/claude-octopus
export DEVELOPMENT_CYCLE_OCTOPUS_SANDBOX=danger-full-access
export DEVELOPMENT_CYCLE_OCTOPUS_WRITE_SCOPE_MODE=adaptive
```

The adapter translates the generic cycle request into Octopus `scripts/orchestrate.sh` calls. For Codex seats, it prepends an owned compatibility bridge that reads the existing OpenClaw `openai` OAuth profile directly from the public auth-profile store at runtime and passes ephemeral ChatGPT auth to `codex app-server`. It does not require or persist a separate Codex CLI login under `CODEX_HOME`. Non-Codex providers and Octopus model routing remain unchanged.

Managed Octopus launches fail closed on review routing. `~/.claude-octopus/config/providers.json` must define every canonical role used by Design Review and contextual review as an exact `{provider, model}` object. Missing/malformed routes abort launch instead of allowing Octopus to fall back silently to its standalone defaults. The adapter also sets `OCTOPUS_REQUIRE_EXPLICIT_REVIEW_ROUTING=true` so compatible Octopus versions refuse seat substitution after launch.

Octopus council review remains available only when this adapter is active.

See [Adapters](docs/adapters.md) and [Configuration](docs/configuration.md).

## Notifications

Notifications use the `message` tool through the already-running OpenClaw Gateway's `/tools/invoke` endpoint. Nothing is enabled or addressed by default.

```bash
export DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED=true
export DEVELOPMENT_CYCLE_NOTIFICATION_CHANNEL=slack
export DEVELOPMENT_CYCLE_NOTIFICATION_TARGET='channel:C0123456789'
```

Any channel configured in the Gateway and supported by its `message` tool can be used. Optional `DEVELOPMENT_CYCLE_NOTIFICATION_DELIVERY_JSON` is parsed into the tool's structured `delivery` argument.

When notifications are enabled, the plugin sends best-effort, deduplicated messages for material lifecycle phase transitions only. Heartbeats and same-phase status refreshes remain silent. Current material notifications include implementation launch/running/delivery/failure, correction rounds, mechanical validation outcomes, council review outcomes, final validation decisions, stop, repository delivery, merge and close. Human-intervention/council-interrupt messages keep their dedicated notification paths and are not duplicated by the phase notifier.

Lifecycle notification dedupe is persisted per run in `telegram_update_state.json`; audit events are appended to `telegram_update_events.jsonl`. Notification delivery failures are recorded in those event files but do not mutate the Development Cycle phase or fail the lifecycle action.

Notification delivery uses `OPENCLAW_GATEWAY_TOKEN` for bearer authentication when set. The Gateway URL is selected from `DEVELOPMENT_CYCLE_GATEWAY_URL`, then `OPENCLAW_GATEWAY_URL`, then `http://127.0.0.1:18789`. See [Configuration](docs/configuration.md#openclaw-notifications) for notification settings.

Gateway message delivery is deferred until the current `development_cycle` tool execution has returned. Notifications are saved under `<state-root>/notification-outbox/` before they are queued, then drained when the active-action count reaches zero. Pending jobs are recovered when the plugin starts and checked every 30 seconds. Failed delivery retries up to five times with backoff; exhausted jobs remain on disk for inspection. Delivery is at least once: a crash after the Gateway sends a message but before acknowledgement is saved can cause a duplicate. Phase delivery results are appended asynchronously to `telegram_update_events.jsonl`.

The supervisor performs one best-effort `reconcile` callback through the configured Gateway after runner exit and process-group cleanup. This lets the control plane observe terminal runner state without polling. For one narrowly classified Octopus planner-reconsideration contract failure, `reconcile` may automatically relaunch the same approved plan exactly once, but only when the attempt worktree is pristine, its HEAD still matches the source checkout, and there is no pending human intervention. Unknown failures, dirty/committed worktrees, interventions, or a second occurrence fail closed and require normal operator handling. Recovery events are appended to `automatic_recovery_events.jsonl`.

## Safety model

- mutating actions are phase-gated;
- adapters, notifications, observers, and external gates are opt-in;
- project documentation and source checkout paths are separate;
- JSON state writes are atomic;
- adapter arguments and environment values are shell-quoted;
- child work is supervised as a process group;
- final validation remains explicit in durable state even when the decision is produced automatically;
- no credentials, private addresses, or operator-specific paths are embedded.

## Development

```bash
npm ci
npm run check
```

The check runs tests, the public-leak audit, and OpenClaw plugin validation.

See [Contributing](CONTRIBUTING.md), [Architecture](docs/architecture.md), [Troubleshooting](docs/troubleshooting.md), and [Security](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).


### Contextual reads for Octopus

`DEVELOPMENT_CYCLE_OCTOPUS_READ_SCOPE_MODE` defaults to `contextual`; `strict`
keeps repository-relative reads only. Invalid values are rejected. Implementation
and correction launches can select `readScopeMode: "strict"` or `"contextual"`.

The adapter passes `OCTOPUS_TANGLE_READ_SCOPE_MODE` and
`OCTOPUS_TANGLE_CONTEXTUAL_READ_ROOTS` from validated launch metadata: project
root, project documentation root, this run-specific handoff directory, approved
plan, request and prompt files. File entries never grant their parent directories.
Task prose and inherited read-root environment variables cannot expand the list.

This requires an Octopus revision supporting contextual reads. External read
grants never authorize writing. Known secret/auth paths and symlink escapes are
rejected. This is declaration validation and guidance, not OS sandboxing or
complete secret isolation in full-access execution.
