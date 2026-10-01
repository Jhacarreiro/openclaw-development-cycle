# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and the project follows Semantic Versioning once stable releases begin.

## [Unreleased]

### Fixed

- Octopus launch tests now use a shared review-routing fixture instead of depending on the machine's home directory.
- Notification documentation and tool parameter descriptions now describe Gateway message delivery and its connection settings.
- README status, Node.js requirements, and basic usage formatting now match the current package and pinned OpenClaw dependency.

### Removed

- The unused OpenClaw CLI binary configuration option and its obsolete test assertions.
- The unused retention-days configuration option, which had no runtime consumer or retention implementation.
- An unused filesystem helper import.

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
