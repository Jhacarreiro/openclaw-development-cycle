# Handoff — Optional Deploy Track for `development_cycle`

Status: design handoff only; not implemented  
Date: 2026-09-02  
Repository: `/data/workspace/plugins/development-cycle`

## Goal

Add a small **optional deploy track** to the existing OpenClaw tool `development_cycle`.

It must be independently callable. It must not require planning, implementation, final validation or repository delivery, and it must not auto-run after them.

```text
development_cycle
  |-- implementation lifecycle  (existing)
  |-- deploy track              (new, optional)
  `-- security track            (separate handoff)
```

Deployment state must be separate from the existing main `status.phase` state machine.

## Read first

- `README.md`
- `docs/architecture.md`
- `docs/adapters.md`
- `docs/configuration.md`
- `src/core/state-machine.ts`
- `src/index.ts`
- `src/adapters/implementation.ts`
- repository-delivery code in `src/index.ts` / `src/config.ts`
- `runner-supervisor.py`

## V1 public actions

Add to the **same** `development_cycle` tool:

```text
deploy_prepare
deploy_execute
deploy_verify
deploy_status
```

Optional only if trivial and bounded:

```text
deploy_stop
```

Do not add automatic rollback in v1.

## Independent track storage

Suggested path:

```text
<state-root>/tracks/deploy/<project>/<deployId>/
```

A deploy may have optional `sourceRunId` metadata linking it to an implementation run, but `runId` must not be required.

Suggested status values, local to this track:

```text
prepared
prepare_failed
execution_launched
execution_running
deployed
execution_failed
verification_running
verified
verification_failed
stopped
```

Do not add these phases to `src/core/state-machine.ts`'s implementation lifecycle.

## `deploy_prepare`

Inputs:

```text
project
projectRoot
deployId?             # create if absent
sourceRef?            # resolve and persist exact commit
sourceRunId?          # metadata only
deploymentAdapter?    # optional override
deploymentTarget?     # adapter-specific, e.g. production/beta
objective?
```

Responsibilities:

- validate/pin the trusted Git checkout;
- resolve requested ref to an exact commit;
- create the deploy track;
- invoke deploy adapter in `prepare` mode;
- emit a durable deployment manifest;
- identify expected mutations, required authorizations, protected paths, verification checks and rollback metadata;
- perform **no production mutation**.

## `deploy_execute`

Inputs:

```text
project
deployId
authorizationText?    # explicit evidence supplied by caller/operator
```

Responsibilities:

- require a prepared manifest;
- fail closed if the manifest declares required authorization and evidence is absent;
- never infer authorization from chat/history;
- execute through a supervised process group;
- persist attempt ID, heartbeat, stdout/stderr and exit code;
- distinguish process success from verified deployment.

Gallivanter protected-path approval remains an external human policy. The plugin may persist supplied evidence but must not claim it is human-approved unless the caller supplies it as such.

## `deploy_verify`

Run bounded adapter-defined post-deploy checks and persist structured evidence.

Terminal result:

```text
verified
verification_failed
```

A failed verification must surface rollback metadata and a clear operator next action. Do not automatically roll back.

## `deploy_status`

Read-only. Return track status, exact source commit, manifest, runtime/attempt state, verification summary, rollback metadata, files and `nextAction`.

When `deployId` is absent, returning the latest deploy for the project is desirable if it can be implemented safely.

## Durable artifacts

Suggested:

```text
tracks/deploy/<project>/<deployId>/
  deploy_status.json
  deploy_request.json
  deploy_manifest.json
  authorization_evidence.md      # only when provided
  rollback.json
  prepare/
  execute/attempts/<attemptId>/
  verify/attempts/<attemptId>/
```

Reuse the existing immutable-attempt principle. Retries must never reuse terminal markers from older attempts.

## Adapter contract

Deployment logic belongs in an adapter, not `src/index.ts`.

Suggested configuration:

```text
DEVELOPMENT_CYCLE_DEPLOY_ENABLED=false
DEVELOPMENT_CYCLE_DEPLOY_ADAPTER=command
DEVELOPMENT_CYCLE_DEPLOY_COMMAND=/absolute/path/to/deploy-adapter
DEVELOPMENT_CYCLE_DEPLOY_ARGS_JSON=[]
DEVELOPMENT_CYCLE_DEPLOY_TIMEOUT_SECONDS=<bounded default>
```

One command can handle `prepare | execute | verify` using a versioned request:

```json
{
  "schemaVersion": 1,
  "track": "deploy",
  "mode": "prepare",
  "project": "example",
  "deployId": "...",
  "projectRoot": "/repo",
  "sourceRefRequested": "main",
  "sourceCommit": "<exact sha>",
  "deploymentTarget": "production",
  "resultsRoot": "/state/tracks/deploy/...",
  "manifestPath": "/state/tracks/deploy/.../deploy_manifest.json",
  "authorizationPath": "",
  "timeoutSeconds": 900
}
```

Adapter `prepare` should emit `deploy_manifest.json` with at least:

```text
sourceCommit
expectedMutations[]
protectedPaths[]
requiredAuthorizations[]
verificationChecks[]
rollback.available / description / artifacts
```

## Safety requirements

- Feature disabled by default.
- No project/vendor-specific logic in core.
- No secrets in requests/manifests/logs.
- No shell interpolation of user-controlled values.
- `deploy_prepare` must not mutate production.
- Exact source commit persisted before execute.
- Missing required authorization fails closed.
- Work runs through supervisor, never a long foreground shell call.
- Verification is bounded.
- No automatic security gate or automatic rollback in v1.

## V1 non-goals

Do not implement:

- automatic chaining from the normal development lifecycle;
- security gating;
- CI/CD environment promotion graphs;
- canary/blue-green rollouts;
- secret management;
- Docker/Cloudflare/GitHub logic in core;
- authorization heuristics.

## First real adapter fixture: Shopping Assistant

Use only as an adapter example, never hard-code it.

`prepare` can model the proven supervised procedure:

- validate clean repo + exact commit;
- identify protected deployment paths;
- describe timestamped backup;
- materialize/build candidate artifacts outside production;
- record current image IDs as rollback metadata;
- define smoke checks.

`execute` can perform authorized backup/materialization/image promotion/service recreation.

`verify` can check health, release==commit, ownership/perms, app smoke and public edge.

## Tests required

At minimum prove:

1. deploy actions never change normal cycle `status.phase`;
2. a deploy can exist without a development `runId`;
3. deploy is disabled by default;
4. exact commit is persisted;
5. execute-before-prepare is rejected;
6. missing required authorization is rejected;
7. retries use immutable attempt directories;
8. verification failure does not auto-rollback;
9. status is read-only;
10. existing development-cycle tests remain green.

Run:

```bash
npm run check
```

## Documentation after implementation

Update `README.md`, `docs/architecture.md`, `docs/adapters.md`, `docs/configuration.md`, `CHANGELOG.md`, then the Gallivanter wiki only after the feature is live.

## Acceptance criteria

- Still one OpenClaw tool: `development_cycle`.
- Deploy is optional and disabled by default.
- Deploy is independently invocable.
- Deploy state is durable and separate from the main phase machine.
- Generic adapter handles prepare/execute/verify.
- Required authorization is never inferred/bypassed.
- Execution is supervised and observable.
- Verification is distinct from process success.
- No security/full-flow automation is introduced.
