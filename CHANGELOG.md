# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and the project follows Semantic Versioning once stable releases begin.

## [Unreleased]

### Changed

- Octopus Codex seats now reuse the existing OpenClaw OAuth profile through an owned ephemeral `codex app-server` bridge that reads the auth-profile store directly instead of requiring a second persistent Codex CLI login.

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
