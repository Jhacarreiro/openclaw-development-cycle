# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and the project follows Semantic Versioning once stable releases begin.

## [Unreleased]

### Added

- `start_followup`: when a review does not converge, `reconcile` starts a follow-up run from the issues the partial delivery opened that are still open. It runs on the delivered checkout and pushes to the same PR branch (fast-forward only), so the PR accumulates the work; a successful follow-up retitles the PR and closes the issues when it merges. Bounded by `DEVELOPMENT_CYCLE_FOLLOWUP_MAX_GENERATIONS` (default 2); turn the automatic start off with `DEVELOPMENT_CYCLE_FOLLOWUP_AUTO_START=false`.
- Run tracking for new runs: `status.json` records `createdAt`, `startedAt` (first implementation launch), `closedAt`, `interventionAnswerCount` and `correctionRoundCount`, and the run reader reports them. Runs created earlier keep these fields absent instead of receiving partial values.
- `docs/reliability-baseline.md`: a proposed criterion and per-run record for measuring whether linear cycles reach a recorded decision on a meaningful real task chosen by the user, with acceptance checks defined before the runs and sanitized public evidence.

### Changed

- Octopus implementation launches stop after 3 review/correction rounds instead of Octopus's default 10 (`DEVELOPMENT_CYCLE_OCTOPUS_CORRECTION_ROUNDS`).

### Fixed

- Codex bridge: without `DEVELOPMENT_CYCLE_OPENCLAW_PROFILE_ID`, it now takes the first usable OpenAI OAuth profile in OpenClaw's own profile order instead of always `openai:default`. Newer OpenClaw keeps the live login under an account-keyed profile and can leave a stale `openai:default` behind, which made every Codex seat fail. When no profile is usable, the error now says whether it was unavailable, incomplete or expired.

- An Octopus run that stops at its review/correction round ceiling is now classified `review_non_convergence` instead of whichever generic pattern its log happened to match (an `EACCES` in reviewed code text made it `local_runtime_fault`). The partial delivery opens one follow-up issue per blocking finding left in Octopus's last review, instead of an issue built from the failure's recommended action.
- Octopus launches pass a 64000-token prompt budget (`DEVELOPMENT_CYCLE_OCTOPUS_CONTEXT_BUDGET`) for implementation and council reviews instead of inheriting Octopus's 12000-token default, which truncated the tail of planning, adequacy-review and council prompts after a slow summarizer attempt that always failed.
- Octopus launches no longer fail Codex's health check after a container update: the runner links a missing `$HOME/.codex/auth.json` to the OpenClaw-managed Codex auth file before launching, without reading or replacing an existing file.
- Repository delivery checks every untracked file by name instead of only its new top-level directory, so a secret inside a new directory is no longer committed unchecked, paths with spaces are read unquoted, and it no longer refuses source or test code whose names mention auth or tokens (for example an OAuth signer's tests). Paths under secrets or credentials directories, env files, private keys and key stores, and text or data files named after secrets, credentials, tokens or auth are still refused.
- Repository delivery no longer fails with "Author identity unknown" on a host without a git identity: when the checkout has no `user.email`, the delivery commit is authored as the GitHub account behind `GH_TOKEN`, with its noreply address.
- The `provider_processes_outside_observed_tree` runtime alert, which marks a run `runtime_observation_blocker`, now counts only provider processes whose working directory is in the run's source checkout or its current attempt's worktree, and also watches Command Code implementers. It no longer flags the host's own idle agent harnesses or interactive CLI sessions, and it now catches an implementer that outlived its helper.
- The Codex bridge waits up to 60 seconds, instead of 15, to read the OpenClaw OAuth profile, so a loaded server no longer drops the Codex seat during decomposition.
- Council NO-GO, FAIL, STOP and inconclusive reviews no longer count as acceptance; rejected reviews do not auto-launch corrections.
- Requested delivery classification cannot promote failed phases to success or auto-merge.
- Resumed finalization enforces mechanical validation and rechecks checkout evidence before GO and successful publication.
- Revalidation clears previous council verdicts, and each council invocation uses a fresh output directory so old review artifacts cannot be reused.
- Invalid validation policy stops acceptance; stopped mechanical validation supports retry or partial finalization.
- Corrupt status blocks updates without discarding history; atomic status writes synchronize files and retain the previous valid state.
- Notification jobs survive plugin restarts, retry failed delivery and retain exhausted attempts for inspection.
- Cancellation verifies Linux process identity; command timeouts terminate descendants, and exit callbacks run outside the cleaned runner group.
- Runner logs rotate at 16 MiB per file and tail reads avoid loading whole files.
- Published packages include the documented GitHub delivery adapter; troubleshooting and routing documentation match runtime behavior.
- Octopus launch tests now use a shared review-routing fixture instead of depending on the machine's home directory.
- Notification documentation and tool parameter descriptions now describe Gateway message delivery and its connection settings.
- README status, Node.js requirements, and basic usage formatting now match the current package and pinned OpenClaw dependency.

### Removed

- The unused OpenClaw CLI binary configuration option and its obsolete test assertions.
- The unused retention-days configuration option, which had no runtime consumer or retention implementation.
- An unused filesystem helper import.
- Root `dist/decisions.js` and `dist/state-machine.js` re-export shims; import from `dist/core/` instead.

### Changed

- Phase-notification dedupe state and audit events are now written to `phase_notification_state.json` and `phase_notification_events.jsonl` (event types `development_cycle.phase_notification` and `development_cycle.phase_notification_delivery`), replacing channel-specific legacy names. Runs started before the rename still read their last signature from the legacy state file, so an upgrade does not repeat a phase notification.
- The coordinator is split into factory modules under `src/cycle/`; `src/index.ts` keeps tool registration, the parameter schema and the action dispatcher.
- README: the research proposal moved below the operational sections and the Octopus contextual-read notes moved into the Octopus adapter section.
- The coordinator is checked by TypeScript without `@ts-nocheck`; tool arguments derive from the public schema and builds reject unused locals and parameters.
- The pinned development SDK uses OpenClaw `2026.9.2`, retaining Node 22 and 24 support. Its MCP SDK dependency is overridden to `1.31.0` to fix OAuth credential issuer validation (GHSA-6qxp-vccf-f47h).
- Audit JSONL writers serialize rotations and compress history at 8 MiB per file. Archives are preserved by default; finite archive retention is opt-in and does not remove run state or notification jobs.
- Notification, process supervision, validation evidence, log reads and validation policy now have separate typed modules.
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
