# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and the project follows Semantic Versioning once stable releases begin.

## [Unreleased]

### Fixed

- Sanitized project and run directory names use a full SHA-256 identity suffix instead of an 8-hex digest.
- Existing pre-upgrade sanitized directories remain readable when the canonical name is absent.
- Generated run IDs stay within the 120-character path contract after a second `cleanId` pass.

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
