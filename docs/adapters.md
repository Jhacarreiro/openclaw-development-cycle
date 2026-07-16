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

Council review and council-driven corrections are adapter-specific capabilities and only run when the active adapter is `octopus`.

## Other adapters

A command adapter can wrap:

- Codex CLI;
- Claude Code;
- Aider;
- a GitHub Actions dispatcher;
- an internal build or change-management service;
- a container or remote-job launcher.

Keep adapter-specific authentication, provider selection, and sandbox policy outside the control-plane core.

## Security guidance

- use an absolute executable path;
- avoid shell wrappers that interpolate untrusted request values;
- parse the JSON request with a real JSON parser;
- constrain source checkout permissions;
- keep credentials outside the request and repository;
- write artifacts only under documented paths;
- return non-zero on incomplete or failed execution;
- do not bypass final validation or state transitions.
