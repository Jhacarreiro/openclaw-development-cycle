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

### `src/adapters/implementation.ts`

Implementation-lifecycle adapter contract and launch translation (the
deploy track's adapter lives in `src/adapters/deploy.ts`; its durable
prepare artifact is `deploy_manifest.json`):

- generic `command` adapter;
- optional `octopus` adapter;
- POSIX shell quoting for executable, arguments, and environment values.

### `src/config.ts`

Typed environment configuration with command-first portable defaults. Optional integrations are disabled by default.

### `src/index.ts`

OpenClaw tool registration and workflow coordination. It creates adapter requests, starts supervised runs, reconciles status, builds validation packs, and emits optional notifications.

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

## State transitions

`status` and `reconcile` are always allowed. `request_plan` is allowed in every phase except while a run is live (`implementation_launched`/`implementation_running`/`corrections_launched`/`corrections_running`) — stop the live run first, then request a new plan. Other actions are phase-gated by `src/core/state-machine.ts`.

```text
waiting_external_plan
  -> plan_ready_for_implementation
  -> implementation_launched / implementation_running
  -> implementation_delivered
  -> review_infrastructure_failed --resume_finalization--> implementation_delivered
  -> waiting_final_validation
  -> final_validated | final_revised | stopped
  -> repository delivery (success or partial)
  -> merged | delivery_published | closed_partial | closed_invalid

`start_corrections` remains available only for explicit/manual correction workflows; a final `revise` terminates the current plan as a partial delivery instead of automatically entering another correction loop.

`review_infrastructure_failed` is deliberately narrow: it requires a non-zero Octopus attempt, a validated output handoff, and explicit contextual-review `No changes found to review` evidence. Its only recovery action is `resume_finalization`, which re-resolves the same Tangle manifest and rejects changed or untrusted output identity. It does not skip mechanical final validation.
```

There are no legacy Octopus action or phase aliases in the public contract.

## Process supervision

The packaged supervisor:

- creates a process group;
- persists runner identity and heartbeat state;
- captures stdout and stderr;
- records terminal exit state;
- stops the process group with `SIGTERM`, then `SIGKILL` when necessary;
- acts as a subreaper to avoid orphaned descendants.

## Deploy track (optional)

Disabled by default. The deploy track is independent from the implementation
lifecycle and does not chain automatically from it.

```text
development_cycle
  |-- implementation lifecycle  (existing: src/core/state-machine.ts)
  |-- deploy track              (new, optional)
  `-- security track            (separate handoff)
```

Still one OpenClaw tool (`development_cycle`). Deploy state is durable and
separate from `status.phase`.

### Actions

`deploy_prepare`, `deploy_execute`, `deploy_verify`, `deploy_status`, and
optionally `deploy_stop`. `deploy_status` is read-only; the rest are
track-scoped and do not mutate the implementation cycle. `deploy_prepare`
must not mutate production. `deploy_execute` requires a prepared manifest and
fails closed when `requiredAuthorizations` are declared without explicit
`authorizationText` evidence; authorization is never inferred from chat or
history. `deploy_verify` is bounded and its failure surfaces rollback metadata
without automatically rolling back.

### Independent status set

Deploy status values are local to this track, not part of
`src/core/state-machine.ts`:

```text
prepared
prepare_failed
execution_launched
execution_running
deployed
execution_failed
verification_running
verified
verification_failed
stopped
```

### Storage and durable artifacts

Deploy state lives outside `runs/`:

```text
<state-root>/tracks/deploy/<project>/<deployId>/
  deploy_status.json
  deploy_request.json
  deploy_manifest.json
  authorization_evidence.md      # only when provided
  rollback.json
  prepare/
  execute/attempts/<attemptId>/
  verify/attempts/<attemptId>/
```

A deploy can exist without a development `runId`; `sourceRunId` is optional
metadata only. The exact source commit is persisted before execute. Retries use
immutable attempt directories and never reuse terminal markers, logs, or status
from a prior attempt. Verification failure does not auto-rollback. The
prepare step's durable artifact is `deploy_manifest.json`; see
`src/adapters/deploy.ts` for the adapter that emits it.

### Adapter and supervision

Deployment logic belongs in an adapter, not `src/index.ts`. The deploy
adapter (`src/adapters/deploy.ts`) reuses the generic command adapter for
`prepare | execute | verify` — `deploy_manifest.json` is the `prepare`
artifact — via the same supervisor used by the implementation adapter
(`src/adapters/implementation.ts`) runner; execution is supervised and
observable and is distinct from verification. See [Adapters](adapters.md) and
[Configuration](configuration.md).

### V1 non-goals

Automatic chaining from the implementation lifecycle, security gating, CI/CD
environment promotion graphs, canary/blue-green rollouts, secret management,
Docker/Cloudflare/GitHub logic in core, and authorization heuristics are out of
scope for v1.

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
