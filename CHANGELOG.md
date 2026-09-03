# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and the project follows Semantic Versioning once stable releases begin.

## [Unreleased]

### Added

- Optional deploy track (`deploy_prepare`, `deploy_execute`, `deploy_verify`, `deploy_status`, and optionally `deploy_stop`) on the same `development_cycle` tool. Disabled by default (`DEVELOPMENT_CYCLE_DEPLOY_ENABLED=false`). Independently invocable without planning, implementation, final validation, or repository delivery; does not auto-run after them. Durable, separate state under `<state-root>/tracks/deploy/<project>/<deployId>/` with `deploy_status.json`, `deploy_request.json`, `deploy_manifest.json` (durable prepare artifact emitted by `src/adapters/deploy.ts`), `authorization_evidence.md` (only when provided), `rollback.json`, and immutable attempt directories (`prepare/`, `execute/attempts/<attemptId>/`, `verify/attempts/<attemptId>/`). Independent deploy status set (`prepared`, `prepare_failed`, `execution_launched`, `execution_running`, `deployed`, `execution_failed`, `verification_running`, `verified`, `verification_failed`, `stopped`) not part of `src/core/state-machine.ts`. Generic deploy adapter `src/adapters/deploy.ts` alongside the implementation lifecycle adapter `src/adapters/implementation.ts` via the command adapter contract (`DEVELOPMENT_CYCLE_DEPLOY_ADAPTER=command`, `DEVELOPMENT_CYCLE_DEPLOY_COMMAND`, `DEVELOPMENT_CYCLE_DEPLOY_ARGS_JSON`, `DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS`) with a versioned `schemaVersion: 1, track: deploy` request (`prepare | execute | verify`) and a `prepare`-emitted `deploy_manifest.json` (`sourceCommit`, `expectedMutations[]`, `protectedPaths[]`, `requiredAuthorizations[]`, `verificationChecks[]`, `rollback.*`). Safety: `deploy_prepare` performs no production mutation, exact source commit is persisted before execute, missing required authorization fails closed and is never inferred, execution is supervised through the process-group supervisor, verification is bounded, and v1 has no automatic rollback or security gate. V1 non-goals: no automatic lifecycle chaining, security gating, promotion graphs, canary/blue-green, secret management, Docker/Cloudflare/GitHub logic in core, or authorization heuristics.

### Changed

- Octopus Codex seats now reuse the existing OpenClaw OAuth profile through an owned ephemeral `codex app-server` bridge that reads the auth-profile store directly instead of requiring a second persistent Codex CLI login.
- Octopus review-infrastructure-only failures with a validated materialized output are now classified separately as `review_infrastructure_failed`; the new fail-closed `resume_finalization` action revalidates the exact output and resumes at `implementation_delivered` without rerunning implementation.
- Review-infrastructure recovery now recognizes the real Octopus `/octo:review` / `Quality Gate` output envelope instead of depending on one literal contextual-review heading, while keeping provider/auth blockers scoped to the final review segment.

## [0.1.0] - 2026-07-16

### Added

- public OpenClaw `development_cycle` tool;
- durable filesystem state with atomic JSON updates;
- explicit state-machine transition validation;
- planning, implementation handoff, delivery, validation, correction, and close actions;
- process-group supervision and stop behavior;
- portable typed environment configuration;
- opt-in notifications through any OpenClaw-supported channel;
- optional external validation-gate and observer integrations;
- public repository documentation, CI, contribution guidance, and leak auditing.
