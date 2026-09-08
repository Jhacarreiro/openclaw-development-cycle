# AGENTS.md

## Vision

This project supervises a software-development cycle. It coordinates planning, implementation, validation, and correction; it is not itself the coding agent.

The same cycle should support both supervised human-in-the-loop operation and fully automatic execution when policy allows it.

## Guardrails

- Public artifacts must remain portable and free of operator-specific infrastructure. Never commit private IPs, internal hostnames, operator paths/users, private repository relationships, runtime state, private service identifiers, credentials or deployment topology. Use synthetic examples and external runtime configuration instead.
- Public `main` is the canonical implementation. Do not create operator-specific runtime code branches; local differences belong in configuration outside the public repository.
- Before public merge/release, run `npm run audit:public` and keep the audit covered by negative fixtures for representative private-path/IP patterns.

- Stay runner-agnostic: Codex, Claude, or another implementation backend should be replaceable without changing the development-cycle model.
- Durable, restartable state is essential. A cycle must be resumable after process or host restarts.
- Human approval may be present, but the architecture must also permit 100% automatic flows.
- Prefer a clear state machine and explicit transitions; configurability may grow as long as state and failure semantics remain understandable.
- The project owns plan -> implement -> validate -> correct. Release, deployment, and unrelated repository automation belong elsewhere unless explicitly integrated through a boundary.
- Preserve observability: the current stage, decision, failure, and next action should always be recoverable from durable state.
