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

## Notifications are skipped

A notification requires:

- notifications enabled globally or `notify=true`;
- a supported `notificationChannel`;
- a valid `notificationTarget`;
- a working OpenClaw CLI and configured channel account.

Use `notificationDryRun=true` to validate arguments without sending.

## Observer data is absent

The observer is disabled by default and is not required by the command adapter. Enable it only after configuring compatible helper and hook paths.

## A supervised process does not stop

Use `stop_implementation` rather than killing only the root PID. The plugin stops the process group with a TERM/KILL policy.

## Public audit fails

```bash
npm run audit:public
```

Remove the reported private address, fixed operator path, local-only branch reference, or credential. Do not add exceptions for real environment values.
