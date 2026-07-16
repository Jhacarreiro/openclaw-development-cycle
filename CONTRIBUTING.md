# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Development setup

Requirements:

- Node.js 22+
- Python 3
- an OpenClaw installation for plugin validation

```bash
git clone https://github.com/Jhacarreiro/openclaw-development-cycle.git
cd openclaw-development-cycle
npm ci
npm run check
```

## Before opening a pull request

1. Keep changes focused and explain the workflow behavior being changed.
2. Add or update tests for state transitions, parsing, storage, or configuration.
3. Run `npm run check`.
4. Do not commit credentials, tokens, private IP addresses, local usernames, absolute operator paths, runtime state, logs, or generated artifacts.
5. Preserve portable defaults. External services and notification destinations must remain opt-in.
6. Update README or `docs/` when configuration or user-visible behavior changes.

## Architecture rules

- `src/core/` must remain independent of OpenClaw and external runtime adapters.
- Mutating actions require explicit state-machine transitions.
- Filesystem status updates must remain atomic.
- Channel delivery must go through OpenClaw's generic messaging interface rather than a channel-specific implementation.
- Do not add operator-specific defaults.
- Do not patch third-party runtime code in this repository.

## Pull requests

A good pull request includes:

- the problem and intended behavior;
- scope and non-goals;
- validation commands and results;
- compatibility or migration notes;
- security implications, when relevant.

Small, independently reviewable pull requests are preferred.

## Reporting security issues

Do not open a public issue for a suspected vulnerability or exposed credential. Follow [SECURITY.md](SECURITY.md).
