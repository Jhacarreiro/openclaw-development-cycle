# Architecture

## Overview

```text
OpenClaw agent
  -> development_cycle tool
     -> core state machine
     -> filesystem store
     -> implementation adapter
     -> process-group supervisor
     -> optional observer
     -> optional external gate
     -> optional OpenClaw channel notification
```

The control plane owns workflow and evidence. The adapter owns implementation execution.

## Layers

### `src/core/`

Pure deterministic code:

- actions and phase transitions;
- final-decision parsing;
- path-safe identifiers.

Core modules do not import OpenClaw or runtime adapters.

### `src/storage/`

Filesystem persistence:

- stable run directories;
- JSON and JSONL reads/writes;
- same-directory temporary files and atomic rename.
- file and parent-directory synchronization, plus the previous valid cycle status;
- bounded reads of log tails; corrupt state blocks updates.

### `src/adapters/implementation.ts`

Adapter contract and launch translation:

- generic `command` adapter;
- optional `octopus` adapter;
- POSIX shell quoting for executable, arguments, and environment values.

### `src/config.ts`

Typed environment configuration with command-first portable defaults. Optional integrations are disabled by default.

### `src/index.ts`

OpenClaw tool registration and workflow coordination. It creates adapter requests, starts supervised runs, reconciles status, builds validation packs, and emits optional notifications.

### `src/runtime/`

Typed services for durable notification delivery, Linux process identities and supervised command timeouts, and checkout fingerprints used as validation evidence. Pure validation configuration and council decision rules live under `src/core/`.

### `runner-supervisor.py`

A persistent Python subreaper that launches process groups, records PID and heartbeat state, and cleans residual descendants.

## Adapter request

Each adapter run receives a versioned `request.json`. The command adapter receives its path as the final command-line argument. See [Adapters](adapters.md).

The runner also writes:

```text
payload.json
prompt.txt
status.json
heartbeat.json
logs/stdout.log
logs/stderr.log
exit-code.txt
exited-at.txt
```

## Durable cycle state

Each run lives under:

```text
<state-root>/runs/<project>/<run-id>/
```

Project and run directory names are path-safe. Already-clean names pass through. Names that need sanitization keep a readable prefix and a full SHA-256 suffix so distinct inputs do not share a directory. Generated run IDs stay at or under 120 characters.

Existing directories written by the previous sanitizer (for example `Project / One` → `Project-One`) are still opened when the canonical name is absent. New runs use the canonical name.

Typical cycle artifacts include:

```text
status.json
plan_request.md
context_pack.md
operator_constraints.md
expected_plan_contract.md
implementation_plan.md
implementation_request.md
final_validation_request.md
final_validation_response.md
runtime_observation.json
runtime_timeline.json
runtime_alerts.json
```

Optional integrations may add further records.

JSON status updates synchronize the temporary file before rename and, on Linux, synchronize the containing directory. `status.previous.json` keeps the previous valid cycle state. Unreadable or non-object JSON is an error; only a missing file initializes an empty state. Snapshots support explicit recovery and do not undo external effects.

Notifications are persisted in a separate outbox before deferred delivery. Multiple plugin instances use a per-job lock. Acknowledged jobs are removed; failed jobs retry with backoff and remain inspectable after five attempts. This is at least once delivery, with a possible duplicate if a crash happens after sending but before acknowledgement.

## State transitions

`status` and `reconcile` are always allowed. `request_plan` is allowed in every phase except while a run is live (`implementation_launched`/`implementation_running`/`corrections_launched`/`corrections_running`) — stop the live run first, then request a new plan. Other actions are phase-gated by `src/core/state-machine.ts`.

```text
waiting_external_plan
  -> plan_ready_for_implementation
  -> implementation_launched / implementation_running
  -> implementation_delivered
  -> review_infrastructure_failed --resume_finalization--> implementation_delivered
  -> external_validation_passed | external_validation_needs_revision | external_validation_stopped
  -> waiting_final_validation
  -> final_validated | final_revised | stopped
  -> repository delivery (success or partial)
  -> merged | delivery_published | closed_partial | closed_invalid

```

`start_corrections` remains available only for explicit/manual correction workflows; a final `revise` terminates the current plan as a partial delivery instead of automatically entering another correction loop. Mechanical validation can be rerun after a stopped or revised result, or when accepted evidence becomes stale. Those blocked outcomes can also be finalized as partial delivery.

`review_infrastructure_failed` is deliberately narrow: it requires a non-zero Octopus attempt, a validated output handoff, and explicit contextual-review `No changes found to review` evidence. Its only recovery action is `resume_finalization`, which re-resolves the same Tangle manifest and rejects changed or untrusted output identity. It does not skip mechanical final validation.

Successful mechanical validation records the attempt ID, implementation root, HEAD and a fingerprint of the index, tracked diff and untracked contents. Final GO and successful publication recheck existing evidence. Resumed review-infrastructure failures require this evidence; manual review flows that have never run mechanical validation retain their existing contract. Council completion alone does not mean acceptance: negative verdicts take precedence over pass phrases, unknown verdicts fail closed, and a STOP does not launch automatic corrections. Requested delivery classification can downgrade acceptance but cannot promote a failed phase to success.

There are no legacy Octopus action or phase aliases in the public contract.

## Process supervision

The packaged supervisor:

- creates a process group;
- persists runner identity and heartbeat state;
- captures stdout and stderr;
- records terminal exit state;
- stops the process group with `SIGTERM`, then `SIGKILL` when necessary;
- acts as a subreaper to avoid orphaned descendants.

Cancellation checks the boot ID and process start time before signalling a persisted PID/process group. GNU `timeout` bounds validation, council and delivery process groups, including their descendants. `bin/bounded-log.py` retains two files of at most 16 MiB per runner stream, and tail reads allocate a bounded buffer. The supervisor sends exit callbacks after residual cleanup, outside the runner group.

## Trust boundaries

Operators remain responsible for:

- OpenClaw process permissions;
- adapter executable selection;
- model/provider credentials;
- sandbox and checkout permissions;
- protected-path approval policy;
- notification destinations;
- external observer and gate services.

A successful adapter exit does not mean the work is accepted. Validation and the final decision are separate control-plane stages.
