# Implementation adapters

The control plane launches implementation work through a small adapter contract. The state machine, storage, supervision, validation, and notifications do not depend on a particular coding agent or orchestrator.

## Command adapter

The command adapter is the default and the recommended extension point.

Configuration:

```bash
export DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER=command
export DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND=/path/to/runner
export DEVELOPMENT_CYCLE_IMPLEMENTATION_ARGS_JSON='["--optional-flag"]'
```

Invocation:

```text
/path/to/runner --optional-flag /path/to/request.json
```

The process runs with the source checkout as its working directory. It inherits the OpenClaw environment plus these values:

```text
DEVELOPMENT_CYCLE_PROJECT
DEVELOPMENT_CYCLE_RUN_ID
DEVELOPMENT_CYCLE_MODE
DEVELOPMENT_CYCLE_PROJECT_ROOT
DEVELOPMENT_CYCLE_REQUEST_PATH
DEVELOPMENT_CYCLE_PROMPT_PATH
DEVELOPMENT_CYCLE_OBSERVER_SESSION_ID
```

The adapter should write human-readable progress to stdout and errors to stderr. Both streams are captured by the supervised runner.

Exit code `0` means the adapter process completed. It does not by itself mean the implementation is accepted; validation and the final gate remain separate.

## Request schema v1

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

`mode` is `delivery` or `corrections`. During corrections, `validationPath` points to the feedback that caused the correction pass.

Adapters should treat unknown fields as forward-compatible additions and reject unsupported `schemaVersion` values explicitly.

## Example adapter

`examples/command-runner.sh` is a non-destructive fixture. It reads the request and writes an example delivery artifact inside `resultsRoot`.

```bash
chmod +x examples/command-runner.sh
export DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND="$PWD/examples/command-runner.sh"
```

Direct implementation and corrections runners use immutable per-attempt directories under `implementation_session/attempts/<attemptId>/` and `corrections_session/attempts/<attemptId>/`. The cycle persists the active attempt id and exact status path; retries must never reuse terminal markers, logs, or `status.json` from an earlier attempt, and reconciliation ignores state whose attempt id does not match the active cycle attempt.

## Octopus adapter

The optional Octopus adapter translates the generic request into:

```text
scripts/orchestrate.sh --dir <projectRoot> --timeout <seconds> tangle <prompt>
```

Configuration:

```bash
export DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER=octopus
export DEVELOPMENT_CYCLE_OCTOPUS_ROOT=/path/to/claude-octopus
export DEVELOPMENT_CYCLE_OCTOPUS_SANDBOX=workspace-write
```

When the optional observer integration is enabled, the adapter maps generic observer metadata to the Octopus and Crabfleet lifecycle environment expected by that ecosystem.

Codex seats use the owned `bin/codex` compatibility shim. The shim intercepts non-interactive `codex exec` calls, reads the current OpenClaw `openai` OAuth profile directly through the public auth-profile store API, and supplies the resulting ChatGPT auth ephemerally to `codex app-server`. The shim creates a temporary empty `CODEX_HOME` for the child process and removes it afterwards, so Octopus does not depend on a second persistent `$OPENCLAW_STATE_DIR/codex/auth.json`.

The bridge is deliberately narrow: it does not choose models, alter canonical Octopus role routing, copy OAuth credentials into repository/runtime state, or patch Octopus upstream. Commands other than `codex exec` are forwarded to the real Codex CLI unchanged.

If the OpenClaw OAuth profile cannot be resolved, the bridge fails closed before launching a Codex turn.

When Octopus `providers.json` contains exact `{provider, model}` routes, the adapter treats those canonical routing roles as the single source of truth for model selection. It maps them into upstream model-qualified seat overrides at launch time: Design Review uses `implementer`, `researcher`, `code-reviewer`, and `synthesizer`; contextual review maps logic/verifier to `code-reviewer`, security to `security-reviewer`, architecture to `architect`, CVE research to `researcher`, diversity/debate to `strategist`, and synthesis to `synthesizer`. The emitted `OCTOPUS_*_AGENT` values are transport only and are not a second persistent model table. Explicit process-level seat overrides take precedence; missing, malformed, or non-exact role routes leave upstream Octopus behavior unchanged.

Council review and council-driven corrections are adapter-specific capabilities and only run when the active adapter is `octopus`. An explicit `autoCouncilCorrectionsMax: 0` disables automatic council corrections: the cycle records `council_review_waiting_human` immediately instead of silently falling back to the default two correction attempts.

## Other adapters

A command adapter can wrap:

- Codex CLI;
- Claude Code;
- Aider;
- a GitHub Actions dispatcher;
- an internal build or change-management service;
- a container or remote-job launcher.

Keep adapter-specific authentication, provider selection, and sandbox policy outside the control-plane core.

## Deploy adapter (optional)

Disabled by default. When enabled, the same `development_cycle` tool exposes an
independent deploy track. It is independently invocable, does not require a
development `runId`, and its state is durable and separate from the
implementation lifecycle. The deploy adapter is `src/adapters/deploy.ts`
(the implementation lifecycle's adapter is `src/adapters/implementation.ts`); the
prepare step's durable artifact is `deploy_manifest.json`.

### Actions

`deploy_prepare`, `deploy_execute`, `deploy_verify`, `deploy_status`, and
optionally `deploy_stop`. `deploy_status` is read-only and never mutates
`status.phase`.

`deploy_prepare` inputs: `project`, `projectRoot`, optional `deployId` (created
if absent), `sourceRef` (resolved and persisted as an exact commit),
`sourceRunId` (metadata only), `deploymentAdapter`, `deploymentTarget`, and
`objective`. It validates/pins the trusted Git checkout, creates the deploy
track, invokes the adapter in `prepare` mode, and emits a durable manifest
without mutating production. `deploy_execute` requires a prepared manifest and
fails closed when `requiredAuthorizations` are declared without explicit
`authorizationText` evidence; it never infers authorization from chat or
history and runs through the supervisor. `deploy_verify` runs bounded
adapter-defined checks; terminal result is `verified` or
`verification_failed` — failure surfaces rollback metadata without
automatically rolling back.

When `deployId` is absent, `deploy_status` returns the latest deploy for the
project when it can do so safely.

### Independent status set

Local to this track; not part of `src/core/state-machine.ts`:

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

```text
<state-root>/tracks/deploy/<project>/<deployId>/
  deploy_status.json
  deploy_request.json
  deploy_manifest.json            # durable prepare artifact (see src/adapters/deploy.ts)
  authorization_evidence.md      # only when provided
  rollback.json
  prepare/
  execute/attempts/<attemptId>/
  verify/attempts/<attemptId>/
```

The prepare step's durable artifact is `deploy_manifest.json` — emitted by
the deploy adapter at `src/adapters/deploy.ts`. Retries use immutable attempt
directories; terminal markers, logs, and status from a prior attempt are never
reused.

### Versioned request schema

One generic command can handle `prepare | execute | verify`:

```json
{
  "schemaVersion": 1,
  "track": "deploy",
  "mode": "prepare",
  "project": "example",
  "deployId": "...",
  "projectRoot": "/repo",
  "sourceRefRequested": "main",
  "sourceCommit": "<exact sha>",
  "deploymentTarget": "production",
  "resultsRoot": "/state/tracks/deploy/...",
  "manifestPath": "/state/tracks/deploy/.../deploy_manifest.json",
  "authorizationPath": "",
  "timeoutSeconds": 900
}
```

### Prepare manifest fields (`deploy_manifest.json`)

`prepare` (via `src/adapters/deploy.ts`) must emit `deploy_manifest.json` with at least:

```text
sourceCommit
expectedMutations[]
protectedPaths[]
requiredAuthorizations[]
verificationChecks[]
rollback.available / description / artifacts
```

### Configuration

```bash
export DEVELOPMENT_CYCLE_DEPLOY_ENABLED=true
export DEVELOPMENT_CYCLE_DEPLOY_ADAPTER=command
export DEVELOPMENT_CYCLE_DEPLOY_COMMAND=/absolute/path/to/deploy-adapter
export DEVELOPMENT_CYCLE_DEPLOY_ARGS_JSON='[]'
export DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS=900
```

See [Configuration](configuration.md).

### Safety requirements

- Disabled by default.
- No project/vendor-specific logic in core.
- No secrets in requests, manifests, or logs.
- No shell interpolation of user-controlled values.
- `deploy_prepare` must not mutate production.
- Exact source commit is persisted before execute.
- Missing required authorization fails closed.
- Work is supervised; verification is bounded.
- No automatic rollback and no automatic security gate in v1.

### V1 non-goals

Automatic chaining from the implementation lifecycle, security gating, CI/CD
environment promotion graphs, canary/blue-green rollouts, secret management,
Docker/Cloudflare/GitHub logic in core, and authorization heuristics are out of
scope for v1. The first real adapter fixture (for example, Shopping Assistant)
is an adapter example only and is never hard-coded in core. The deploy
adapter (`src/adapters/deploy.ts`) and implementation adapter
(`src/adapters/implementation.ts`) remain separate; `deploy_manifest.json`
belongs to the deploy track only.

## Security guidance

- use an absolute executable path;
- avoid shell wrappers that interpolate untrusted request values;
- parse the JSON request with a real JSON parser;
- constrain source checkout permissions;
- keep credentials outside the request and repository;
- write artifacts only under documented paths;
- return non-zero on incomplete or failed execution;
- do not bypass final validation or state transitions.
