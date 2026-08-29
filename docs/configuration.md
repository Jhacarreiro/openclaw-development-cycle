# Configuration

Configuration is read from environment variables when the plugin loads. Empty values are treated as unset.

## Core paths

| Variable | Default | Description |
| --- | --- | --- |
| `DEVELOPMENT_CYCLE_STATE_ROOT` | `$HOME/.openclaw/development-cycle` | Durable run state and artifacts. |
| `DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT` | `<state-root>/projects` | Per-project documentation root. |
| `DEVELOPMENT_CYCLE_PROJECT_DOCS_GIT_ROOT` | empty | Optional Git checkout containing project documentation. Enables scoped plan commits. |
| `DEVELOPMENT_CYCLE_RETENTION_DAYS` | `30` | Retention policy value. |
| `DEVELOPMENT_CYCLE_OPENCLAW_BIN` | `openclaw` | OpenClaw CLI used for events and messages. |

`projectRoot` is always the source checkout. `projectWikiPath` is the tool parameter for the project documentation directory; it must not be used as the source checkout.

## Implementation adapter

The command adapter is the portable default.

| Variable | Default | Description |
| --- | --- | --- |
| `DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER` | `command` | `command` or `octopus`. |
| `DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND` | empty | Absolute executable path for the command adapter. |
| `DEVELOPMENT_CYCLE_IMPLEMENTATION_ARGS_JSON` | `[]` | JSON array of fixed string arguments placed before the request path. |
| `DEVELOPMENT_CYCLE_OCTOPUS_ROOT` | empty | Root of an optional Octopus checkout. |
| `DEVELOPMENT_CYCLE_OCTOPUS_SANDBOX` | `workspace-write` | Sandbox value passed by the Octopus adapter. |
| `DEVELOPMENT_CYCLE_LOOP_UNTIL_APPROVED` | `true` | Retry failed Octopus subtasks until the configured quality retry limit is reached. Set `false` only for deliberate one-shot runs. |

Example command adapter:

```bash
export DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER=command
export DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND=/opt/dev-runner/bin/implement
export DEVELOPMENT_CYCLE_IMPLEMENTATION_ARGS_JSON='["--format","json"]'
```

Example Octopus adapter:

```bash
export DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER=octopus
export DEVELOPMENT_CYCLE_OCTOPUS_ROOT=$HOME/src/claude-octopus
```

A tool call may override the configured adapter with `implementationAdapter` and the adapter subcommand with `implementationCommand`.

See [Implementation adapters](adapters.md).

## Repository delivery adapter

Repository delivery is opt-in and disabled by default. The core lifecycle writes a durable `repository_delivery_request.json`, then invokes a configured adapter. This keeps forge-specific behavior out of the development-cycle core.

| Variable | Default | Description |
| --- | --- | --- |
| `DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED` | `false` | Allow `finalize_delivery` to publish repository state. |
| `DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_COMMAND` | empty | Executable for the repository-delivery adapter. |
| `DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ARGS_JSON` | `[]` | Fixed arguments placed before the request JSON path. |
| `DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_AUTO_MERGE_SUCCESSFUL` | `true` | Ask the adapter to auto-merge successful deliveries after repository checks permit it. |
| `DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_BASE_BRANCH` | `main` | Default base branch for delivery PRs. |

`finalize_delivery` classifies `final_validated` as `success`; recoverable terminal failure/correction phases as `partial`; and other explicitly requested outcomes as `invalid`. A partial delivery should publish the coherent work as a normal PR and create repository issues for residual findings. A successful delivery may queue auto-merge. While checks are pending, `reconcile` performs a read-only PR status check and promotes `delivery_published` to `merged` once the forge confirms the merge. Invalid output is recorded but not published. When repository delivery is disabled (the default), `finalize_delivery` performs no forge action and closes the cycle locally as `closed_success` or `closed_partial`, preserving an explicit terminal path without pretending anything was published.

The bundled `scripts/github-delivery-runner.mjs` is a GitHub adapter. It refuses direct publication from `main`/`master`, runs `git diff --check`, refuses changed paths that look like credentials/auth/tokens/secrets/`.env`, commits coherent changes, pushes the current branch, opens a normal PR, de-duplicates exact-title follow-up issues, and uses GitHub auto-merge for successful runs.

Example:

```bash
export DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED=true
export DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_COMMAND=node
export DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ARGS_JSON='["/opt/openclaw-development-cycle/scripts/github-delivery-runner.mjs"]'
export DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_AUTO_MERGE_SUCCESSFUL=true
export DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_BASE_BRANCH=main
```

## Runner

| Variable | Default | Description |
| --- | --- | --- |
| `DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_PATH` | packaged `runner-supervisor.py` | Persistent Python subreaper supervisor. |
| `DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET` | system temp directory | Unix socket used by the supervisor. |
| `DEVELOPMENT_CYCLE_HEARTBEAT_INTERVAL_SECONDS` | `30` | Heartbeat interval for supervised runs. |
| `DEVELOPMENT_CYCLE_DEFAULT_TIMEOUT_SECONDS` | `0` | Default implementation timeout. `0` delegates timeout policy to the implementation orchestrator. |

## OpenClaw notifications

Notifications are disabled unless explicitly enabled. Both a channel and target are required.

| Variable | Default | Description |
| --- | --- | --- |
| `DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED` | `false` | Enable lifecycle messages. |
| `DEVELOPMENT_CYCLE_NOTIFICATION_CHANNEL` | empty | Any channel supported by `openclaw message send`. |
| `DEVELOPMENT_CYCLE_NOTIFICATION_TARGET` | empty | Channel-specific destination. |
| `DEVELOPMENT_CYCLE_NOTIFICATION_ACCOUNT` | empty | Optional OpenClaw channel account id. |
| `DEVELOPMENT_CYCLE_NOTIFICATION_DELIVERY_JSON` | empty | Optional JSON passed to `openclaw message send --delivery`. |

Per-call values take precedence:

```text
notify
notificationChannel
notificationTarget
notificationAccount
notificationDeliveryJson
notificationDryRun
```

Example:

```bash
export DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED=true
export DEVELOPMENT_CYCLE_NOTIFICATION_CHANNEL=slack
export DEVELOPMENT_CYCLE_NOTIFICATION_TARGET='channel:C0123456789'
```

Targets are examples only. Use destinations that exist in your OpenClaw configuration.

## Optional external gate

Manual planning and final validation do not require an external service. A compatible notice endpoint can be configured to signal an external planning or validation gate.

| Variable | Default | Description |
| --- | --- | --- |
| `DEVELOPMENT_CYCLE_EXTERNAL_GATE_URL` | empty | Base URL of a compatible notice API. |
| `DEVELOPMENT_CYCLE_EXTERNAL_GATE_SECRET_PATH` | empty | Env-style file containing `EXTERNAL_GATE_TOKEN` and optionally `EXTERNAL_GATE_URL`. |

When either setting is missing, notices are skipped. A tool call may also set `notifyExternalGate=false`.

## Optional observer

The observer is disabled by default. Enabling it requires a compatible process-observation helper and lifecycle hook.

| Variable | Default | Description |
| --- | --- | --- |
| `DEVELOPMENT_CYCLE_OBSERVER_ENABLED` | `false` | Enable observer integration. |
| `DEVELOPMENT_CYCLE_OBSERVER_ADAPTER_ROOT` | empty | Root used to derive helper paths. |
| `DEVELOPMENT_CYCLE_OBSERVER_HELPER_PATH` | derived or empty | Process observation helper. |
| `DEVELOPMENT_CYCLE_OBSERVER_AGENT_HOOK_PATH` | derived or empty | Agent lifecycle hook. |
| `DEVELOPMENT_CYCLE_OBSERVER_HOOK_LOG_PATH` | derived or empty | Hook log path. |
| `DEVELOPMENT_CYCLE_OBSERVER_SESSIONS_ROOT` | derived or empty | Observer session storage. |
| `DEVELOPMENT_CYCLE_OBSERVER_BASE_URL` | empty | Optional observer UI/API base URL. |
| `DEVELOPMENT_CYCLE_OBSERVER_REPOSITORY` | empty | Repository metadata. |
| `DEVELOPMENT_CYCLE_OBSERVER_BRANCH` | empty | Branch metadata. |
| `DEVELOPMENT_CYCLE_OBSERVER_RUNTIME` | `external` | Runtime label. |
| `DEVELOPMENT_CYCLE_OBSERVER_OWNER` | empty | Operator or team label. |

## Parsing rules

Boolean values accept `1`, `true`, `yes`, or `on`, and `0`, `false`, `no`, or `off`, case-insensitively. Positive integers fall back to defaults when invalid. `DEVELOPMENT_CYCLE_IMPLEMENTATION_ARGS_JSON` must be a JSON array containing only strings; invalid input becomes an empty array.
