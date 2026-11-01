import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "dc-plan-normalization-"));
process.env.DEVELOPMENT_CYCLE_STATE_ROOT = join(root, "state");
process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT = join(root, "docs");
process.env.DEVELOPMENT_CYCLE_PROJECT_DOCS_GIT_ROOT = join(root, "docs");
process.env.DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED = "false";
process.env.DEVELOPMENT_CYCLE_OBSERVER_ENABLED = "false";
mkdirSync(join(root, "docs", "shop"), { recursive: true });
mkdirSync(join(root, "code"), { recursive: true });
const { default: plugin } = await import(`../dist/index.js?plan-normalization=${Date.now()}`);
let tool;
plugin.register({ pluginConfig: {}, registerTool(value) { tool = value; } });
const record = (runId, planText, extra = {}) => tool.execute(`plan-${runId}`, {
  action: "record_plan", project: "shop", runId,
  projectRoot: join(root, "code"), projectWikiPath: join(root, "docs", "shop"),
  planText, ...extra,
}, undefined, undefined);

test("record_plan normalizes complete alternate headings", async () => {
  const source = `# Frontend build handoff

## Fases
1. Implementar src/App.tsx.

## Critérios de sucesso
- npm test

## Product rules
- stop before payment/order placement.
- forbidden: production credential storage.

## Required screens
- current shop screen in src/App.tsx
- responsive Web App / PWA
`;
  const result = await record("shop-20260822-normalize", source);
  assert.equal(result.details.ok, true, JSON.stringify(result.details));
  assert.equal(result.details.planValidation.normalized, true);
  assert.deepEqual(result.details.planValidation.unresolved, []);
  const recorded = await readFile(result.details.plan, "utf8");
  assert.match(recorded, /# Canonical implementation plan/);
  assert.match(recorded, /## Approved source plan \(verbatim\)/);
  assert.match(recorded, /# Frontend build handoff/);
});

test("record_plan rejects semantic gaps instead of inventing them", async () => {
  const result = await record("shop-20260822-incomplete", `# Plan\n\n## Fases\n1. Implementar src/App.tsx.\n`);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, "plan_incomplete");
  assert.ok(result.details.missing.includes("validation_checks"));
  assert.ok(result.details.missing.includes("stop_conditions"));
  assert.ok(result.details.missing.includes("expected_artifacts"));
});

test("force remains an auditable escape hatch", async () => {
  const result = await record("shop-20260822-force", `# Note\n\n1. Change src/App.tsx.\n`, { force: true });
  assert.equal(result.details.ok, true, JSON.stringify(result.details));
  assert.equal(result.details.planValidation.forced, true);
  assert.equal(result.details.planValidation.normalized, false);
  assert.ok(result.details.planValidation.unresolved.length > 0);
  const status = JSON.parse(await readFile(join(root, "state", "runs", "shop", "shop-20260822-force", "status.json"), "utf8"));
  assert.equal(status.planValidation.forced, true);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
