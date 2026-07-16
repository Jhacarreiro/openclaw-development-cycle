# OpenClaw Development Cycle

[![CI](https://github.com/Jhacarreiro/openclaw-development-cycle/actions/workflows/ci.yml/badge.svg)](https://github.com/Jhacarreiro/openclaw-development-cycle/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An experimental OpenClaw control plane for supervised software-development cycles. It keeps durable state, enforces workflow transitions, supervises implementation processes, gathers evidence, supports correction loops, and requires an explicit final decision.

The control plane is implementation-runner agnostic. A generic command adapter is the default. Octopus is available as an optional adapter.

## Workflow

The plugin registers one OpenClaw tool, `development_cycle`:

1. create a planning request and context pack;
2. record an approved implementation plan;
3. start a configured implementation adapter;
4. monitor or reconcile the supervised process;
5. collect delivery and validation evidence;
6. record `go`, `revise`, or `stop`;
7. run targeted corrections when required;
8. close the cycle.

State is persisted under `$HOME/.openclaw/development-cycle` by default, so runs survive OpenClaw turns and process restarts.

## Status

Experimental `v0.1.0`. The state machine, storage, adapters, shell quoting, and process-supervision boundaries are tested. Use a disposable or backed-up checkout for initial evaluation.

## Requirements

- Node.js 22 or newer
- Python 3
- `jq`
- OpenClaw `2026.5.17` or newer
- an executable implementation adapter

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

Final validation must begin with exactly one token:

```text
go
revise
stop
```

## Actions

| Action | Purpose |
| --- | --- |
| `request_plan` | Create a planning request and context pack. |
| `record_plan` | Persist an approved implementation plan. |
| `start_implementation` | Launch the configured adapter. |
| `status` | Read persisted state without mutation. |
| `reconcile` | Refresh runtime state and apply enabled follow-up behavior. |
| `stop_implementation` | Stop the supervised process group. |
| `record_delivery` | Record externally supplied delivery evidence. |
| `run_final_validation` | Run configured validation commands. |
| `request_final_validation` | Build the final validation pack. |
| `record_final_validation` | Record `go`, `revise`, or `stop`. |
| `start_corrections` | Launch a targeted correction pass after `revise`. |
| `close` | Close a validated or stopped cycle. |

Invalid phase transitions are rejected by the state machine.

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
export DEVELOPMENT_CYCLE_OCTOPUS_SANDBOX=workspace-write
```

The adapter translates the generic cycle request into Octopus `scripts/orchestrate.sh` calls. Octopus council review remains available only when this adapter is active.

See [Adapters](docs/adapters.md) and [Configuration](docs/configuration.md).

## Notifications

Notifications use OpenClaw's generic messaging CLI. Nothing is enabled or addressed by default.

```bash
export DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED=true
export DEVELOPMENT_CYCLE_NOTIFICATION_CHANNEL=slack
export DEVELOPMENT_CYCLE_NOTIFICATION_TARGET='channel:C0123456789'
```

Any channel supported by `openclaw message send` can be used.

## Safety model

- mutating actions are phase-gated;
- adapters, notifications, observers, and external gates are opt-in;
- project documentation and source checkout paths are separate;
- JSON state writes are atomic;
- adapter arguments and environment values are shell-quoted;
- child work is supervised as a process group;
- final validation is explicit;
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
