# Security Policy

## Supported versions

The project is experimental. Security fixes are applied to the latest commit on the default branch.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository when available. Do not include secrets, access tokens, private keys, personal data, or production configuration in a public issue.

Include:

- affected commit or version;
- reproduction steps using non-sensitive test data;
- expected and observed behavior;
- impact assessment;
- a suggested mitigation, when known.

## Security boundaries

This plugin coordinates tools that can modify source checkouts. Its safety depends on the permissions and configuration of OpenClaw, the implementation orchestrator, model providers, sandbox, and optional adapters.

Operators should:

- run with the least privileges required;
- grant exclusive ownership of `DEVELOPMENT_CYCLE_STATE_ROOT` to the plugin process owner (no other user or process may create, replace, or delete entries under that root; retention pruning assumes this contract);
- use disposable or backed-up checkouts for initial testing;
- review sandbox and protected-path policies;
- keep notifications and external services disabled until configured;
- store credentials outside the repository;
- inspect generated plans before handoff;
- require explicit final validation before closing a cycle.

The repository must not contain operator-specific network addresses, credentials, runtime state, or local filesystem paths. CI runs `npm run audit:public` to detect common leaks.
