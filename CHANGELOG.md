# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and the project follows Semantic Versioning once stable releases begin.

## [Unreleased]

### Added

- Run driver: a plugin service reconciles each project's latest open run when the gateway starts and every `DEVELOPMENT_CYCLE_RUN_DRIVER_INTERVAL_SECONDS` (default 120), so a restart or a missed event no longer leaves a run stopped. Unless `DEVELOPMENT_CYCLE_RUN_DRIVER_AUTO_FINAL_STEPS=false`, it also runs final validation and council review and, with the new `reconcile` option `autoFinalizeDelivery`, delivers a council-validated run. Runs that rest on a person, are closed, or have been idle longer than `DEVELOPMENT_CYCLE_RUN_DRIVER_MAX_IDLE_HOURS` (default 24) are left alone; turn it off with `DEVELOPMENT_CYCLE_RUN_DRIVER_ENABLED=false`.
- `start_followup`: when a review does not converge, `reconcile` starts a follow-up run from the issues the partial delivery opened that are still open. It runs on the delivered checkout and pushes to the same PR branch (fast-forward only), so the PR accumulates the work; a successful follow-up retitles the PR and closes the issues when it merges. Bounded by `DEVELOPMENT_CYCLE_FOLLOWUP_MAX_GENERATIONS` (default 2); turn the automatic start off with `DEVELOPMENT_CYCLE_FOLLOWUP_AUTO_START=false`.
- Run tracking for new runs: `status.json` records `createdAt`, `startedAt` (first implementation launch), `closedAt`, `interventionAnswerCount` and `correctionRoundCount`, and the run reader reports them. Runs created earlier keep these fields absent instead of receiving partial values.
- `docs/reliability-baseline.md`: a proposed criterion and per-run record for measuring whether linear cycles reach a recorded decision on a meaningful real task chosen by the user, with acceptance checks defined before the runs and sanitized public evidence.

### Changed

- Octopus implementation launches stop after 3 review/correction rounds instead of Octopus's default 10 (`DEVELOPMENT_CYCLE_OCTOPUS_CORRECTION_ROUNDS`).

### Fixed

- Council corrections whose Octopus review hits the correction cap are treated as review non-convergence, like an implementation run: the delivery ships the corrections' own branch instead of the checkout they started from, issues are opened only for the findings the review left, and the follow-up run starts from them. Before, the corrected work stayed on a preserved branch, the PR got the pre-correction code, the issues repeated the council's input, and no follow-up started.
- Council findings written as markdown table rows or bold list items become plain findings (severity and text first, location last), so follow-up issue titles no longer start with table pipes or stray `**`.
- A run is its runner's whole session, not only its process group. Octopus starts some subtasks in process groups of their own; when their parent exited they were reparented to the runner supervisor, fell out of the observed run tree and raised `provider_processes_outside_observed_tree`, which put a healthy run on a person, and stopping the run or the supervisor left them running. The observation now follows the runner's session, and stopping a run or shutting the supervisor down signals every process in it.
- Council review gives every seat a vote. Codex seats go through the cycle's OpenClaw-login shim, as in implementation, and an inherited `CODEX_HOME` no longer makes Octopus treat Codex as the host and leave its seat without a vote. Council seats now follow the configured Octopus routing: one seat for every model the routing names, so a provider routed to several models (commandcode with three) seats each of them, handed to Octopus as its default council policy (Octopus's own provider mix applies when no routing is configured), instead of a fixed `claude,codex,opencode,openrouter` list and a fixed Codex model. A council whose answering seats all ask for changes, which Octopus reports as partial with no synthesis, now sends the run to corrections (or stops it, when a seat vetoes) instead of counting as a failed review. A review that ends without a verdict runs once more before the run waits for a person.
- Final validation gives each check command 15 minutes by default instead of 2, so a real project's full test suite that takes a little over 2 minutes no longer fails validation by timing out.
- A decision the implementation leaves in `intervention.json` when it exits cleanly is no longer dropped: the run records it as `pendingDecision`, notifies, and the delivery PR stays open with a comment listing the question and its options instead of merging itself.
- A run that Octopus completed cleanly no longer stops before final validation on a runtime alert. Octopus review summaries such as "0 provider(s) missing/failed/timed out" no longer count as a timeout, alerts about the run's root process only block while a supervised run is still active (a provider still working in the attempt outside the observed tree blocks in any phase), and clearing a stale blocker on a delivered run restores the delivery next action.
- An Octopus run that gives up on corrections after a review left blocking findings (a stalled correction round, retries it cannot supervise) is now classified `review_non_convergence` like one that hits the round ceiling, so its partial delivery opens one issue per finding left in that review and the follow-up run works them. Before, a stale runtime alert classified it as `runtime_observation_blocker` and no follow-up started.
- A partial delivery no longer opens an issue from the failure's recommended action. That text is an instruction for whoever runs the cycle (for example "Inspect Observer runtime observation before deciding whether to stop or relaunch."), not work left in the code.
- Codex bridge: without `DEVELOPMENT_CYCLE_OPENCLAW_PROFILE_ID`, it now takes the first usable OpenAI OAuth profile in the order OpenClaw's own resolver returns from its config and auth store (authored order respected, profiles in cooldown last) instead of always `openai:default`. Newer OpenClaw keeps the live login under an account-keyed profile and can leave a stale `openai:default` behind, which made every Codex seat fail. When no profile is usable, the error now says whether it was unavailable, incomplete or expired.

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
