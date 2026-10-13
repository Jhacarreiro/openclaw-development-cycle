import assert from "node:assert/strict";
import test from "node:test";
import { inferDeliveryClassification } from "../dist/core/delivery-classification.js";

test("requested classification can only downgrade an accepted delivery", () => {
  for (const phase of ["implementation_failed", "corrections_failed", "council_review_failed", "external_validation_stopped", "external_validation_needs_revision", "stopped"]) {
    assert.equal(inferDeliveryClassification(phase, "success"), "partial", phase);
  }
  assert.equal(inferDeliveryClassification("implementation_running", "success"), "invalid");
  assert.equal(inferDeliveryClassification("unknown", "partial"), "invalid");
  assert.equal(inferDeliveryClassification("final_validated", "partial"), "partial");
  assert.equal(inferDeliveryClassification("council_validated", "invalid"), "invalid");
});

test("council terminal phases map to explicit repository delivery outcomes", () => {
  assert.equal(inferDeliveryClassification("council_validated"), "success");
  assert.equal(inferDeliveryClassification("council_review_waiting_human"), "partial");
  assert.equal(inferDeliveryClassification("council_review_failed"), "partial");
  assert.equal(inferDeliveryClassification("council_review_needs_corrections"), "partial");
  assert.equal(inferDeliveryClassification("final_revised"), "partial");
  assert.equal(inferDeliveryClassification("implementation_running"), "invalid");
});
