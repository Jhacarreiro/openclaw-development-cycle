import assert from "node:assert/strict";
import test from "node:test";
import { loadDevelopmentCycleConfig } from "../dist/config.js";

test("configuration uses portable, command-first defaults", () => {
  const config = loadDevelopmentCycleConfig({ HOME: "/tmp/example-home" });
  assert.equal(config.stateRoot, "/tmp/example-home/.openclaw/development-cycle");
  assert.equal(config.projectDocsRoot, "/tmp/example-home/.openclaw/development-cycle/projects");
  assert.equal(config.projectDocsGitRoot, "");
  assert.equal(config.implementation.adapter, "command");
  assert.equal(config.implementation.command, "");
  assert.deepEqual(config.implementation.args, []);
  assert.equal(config.implementation.octopusRoot, "");
  assert.equal(config.implementation.octopusSandbox, "workspace-write");
  assert.equal(config.implementation.loopUntilApproved, true);
  assert.equal(config.runner.defaultTimeoutSeconds, 0);
  assert.equal(config.notifications.enabled, false);
  assert.equal(config.notifications.channel, "");
  assert.equal(config.notifications.target, "");
  assert.equal(config.observer.enabled, false);
  assert.equal(config.openclawBin, "openclaw");
});

test("configuration accepts command and Octopus adapter overrides", () => {
  const config = loadDevelopmentCycleConfig({
    HOME: "/tmp/example-home",
    DEVELOPMENT_CYCLE_STATE_ROOT: "/tmp/dc-state",
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: "/tmp/project-docs",
    DEVELOPMENT_CYCLE_PROJECT_DOCS_GIT_ROOT: "/tmp/docs-repo",
    DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER: "octopus",
    DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND: "/opt/runner/bin/implement",
    DEVELOPMENT_CYCLE_IMPLEMENTATION_ARGS_JSON: '["--format","json"]',
    DEVELOPMENT_CYCLE_OCTOPUS_ROOT: "/opt/octopus",
    DEVELOPMENT_CYCLE_OCTOPUS_SANDBOX: "read-only",
    DEVELOPMENT_CYCLE_LOOP_UNTIL_APPROVED: "false",
    DEVELOPMENT_CYCLE_HEARTBEAT_INTERVAL_SECONDS: "15",
    DEVELOPMENT_CYCLE_DEFAULT_TIMEOUT_SECONDS: "900",
    DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "true",
    DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "on",
    DEVELOPMENT_CYCLE_NOTIFICATION_CHANNEL: "slack",
    DEVELOPMENT_CYCLE_NOTIFICATION_TARGET: "channel:C0123456789",
    DEVELOPMENT_CYCLE_NOTIFICATION_ACCOUNT: "work",
    DEVELOPMENT_CYCLE_OPENCLAW_BIN: "/usr/local/bin/openclaw",
  });
  assert.equal(config.stateRoot, "/tmp/dc-state");
  assert.equal(config.projectDocsRoot, "/tmp/project-docs");
  assert.equal(config.projectDocsGitRoot, "/tmp/docs-repo");
  assert.equal(config.implementation.adapter, "octopus");
  assert.equal(config.implementation.command, "/opt/runner/bin/implement");
  assert.deepEqual(config.implementation.args, ["--format", "json"]);
  assert.equal(config.implementation.octopusRoot, "/opt/octopus");
  assert.equal(config.implementation.octopusSandbox, "read-only");
  assert.equal(config.implementation.loopUntilApproved, false);
  assert.equal(config.runner.heartbeatIntervalSeconds, 15);
  assert.equal(config.runner.defaultTimeoutSeconds, 900);
  assert.equal(config.observer.enabled, true);
  assert.equal(config.notifications.enabled, true);
  assert.equal(config.notifications.channel, "slack");
  assert.equal(config.notifications.target, "channel:C0123456789");
  assert.equal(config.notifications.account, "work");
  assert.equal(config.openclawBin, "/usr/local/bin/openclaw");
});


test("repository delivery is opt-in and configurable", () => {
  const defaults = loadDevelopmentCycleConfig({ HOME: "/tmp/example-home" });
  assert.equal(defaults.repositoryDelivery.enabled, false);
  assert.equal(defaults.repositoryDelivery.command, "");
  assert.deepEqual(defaults.repositoryDelivery.args, []);
  assert.equal(defaults.repositoryDelivery.autoMergeSuccessful, true);
  assert.equal(defaults.repositoryDelivery.baseBranch, "main");

  const configured = loadDevelopmentCycleConfig({
    HOME: "/tmp/example-home",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED: "true",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_COMMAND: "node",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ARGS_JSON: '["/opt/delivery-runner.mjs"]',
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_AUTO_MERGE_SUCCESSFUL: "false",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_BASE_BRANCH: "trunk",
  });
  assert.equal(configured.repositoryDelivery.enabled, true);
  assert.equal(configured.repositoryDelivery.command, "node");
  assert.deepEqual(configured.repositoryDelivery.args, ["/opt/delivery-runner.mjs"]);
  assert.equal(configured.repositoryDelivery.autoMergeSuccessful, false);
  assert.equal(configured.repositoryDelivery.baseBranch, "trunk");
});

test("positive integer env values accept trimmed decimal digits only", () => {
  const accepted = loadDevelopmentCycleConfig({
    HOME: "/tmp/example-home",
    DEVELOPMENT_CYCLE_RETENTION_DAYS: "14",
    DEVELOPMENT_CYCLE_HEARTBEAT_INTERVAL_SECONDS: " 45 ",
    DEVELOPMENT_CYCLE_DEFAULT_TIMEOUT_SECONDS: "3600",
  });
  assert.equal(accepted.retentionDays, 14);
  assert.equal(accepted.runner.heartbeatIntervalSeconds, 45);
  assert.equal(accepted.runner.defaultTimeoutSeconds, 3600);

  const maxSafe = String(Number.MAX_SAFE_INTEGER);
  const atLimit = loadDevelopmentCycleConfig({
    HOME: "/tmp/example-home",
    DEVELOPMENT_CYCLE_RETENTION_DAYS: maxSafe,
    DEVELOPMENT_CYCLE_HEARTBEAT_INTERVAL_SECONDS: maxSafe,
    DEVELOPMENT_CYCLE_DEFAULT_TIMEOUT_SECONDS: maxSafe,
  });
  assert.equal(atLimit.retentionDays, Number.MAX_SAFE_INTEGER);
  assert.equal(atLimit.runner.heartbeatIntervalSeconds, Number.MAX_SAFE_INTEGER);
  assert.equal(atLimit.runner.defaultTimeoutSeconds, Number.MAX_SAFE_INTEGER);
});

test("positive integer env values reject Number() syntax and unsafe integers", () => {
  const cases = [
    { DEVELOPMENT_CYCLE_RETENTION_DAYS: "1e3" },
    { DEVELOPMENT_CYCLE_HEARTBEAT_INTERVAL_SECONDS: "1e3" },
    { DEVELOPMENT_CYCLE_DEFAULT_TIMEOUT_SECONDS: "1e3" },
    { DEVELOPMENT_CYCLE_RETENTION_DAYS: "0x10" },
    { DEVELOPMENT_CYCLE_HEARTBEAT_INTERVAL_SECONDS: "0x10" },
    { DEVELOPMENT_CYCLE_DEFAULT_TIMEOUT_SECONDS: "0x10" },
    { DEVELOPMENT_CYCLE_RETENTION_DAYS: "0b101" },
    { DEVELOPMENT_CYCLE_HEARTBEAT_INTERVAL_SECONDS: "0b101" },
    { DEVELOPMENT_CYCLE_DEFAULT_TIMEOUT_SECONDS: "0b101" },
    { DEVELOPMENT_CYCLE_RETENTION_DAYS: "9007199254740993" },
    { DEVELOPMENT_CYCLE_HEARTBEAT_INTERVAL_SECONDS: "0" },
    { DEVELOPMENT_CYCLE_DEFAULT_TIMEOUT_SECONDS: "-30" },
    { DEVELOPMENT_CYCLE_RETENTION_DAYS: "30.0" },
    { DEVELOPMENT_CYCLE_HEARTBEAT_INTERVAL_SECONDS: "+15" },
    { DEVELOPMENT_CYCLE_DEFAULT_TIMEOUT_SECONDS: "" },
  ];

  for (const env of cases) {
    const config = loadDevelopmentCycleConfig({ HOME: "/tmp/example-home", ...env });
    assert.equal(config.retentionDays, 30, `retentionDays for ${JSON.stringify(env)}`);
    assert.equal(config.runner.heartbeatIntervalSeconds, 30, `heartbeat for ${JSON.stringify(env)}`);
    assert.equal(config.runner.defaultTimeoutSeconds, 0, `timeout for ${JSON.stringify(env)}`);
  }
});
