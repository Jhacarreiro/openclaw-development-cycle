import assert from "node:assert/strict";
import test from "node:test";
import { inferDeliveryClassification } from "../dist/core/delivery-classification.js";

test("council terminal phases map to explicit repository delivery outcomes", () => {
  assert.equal(inferDeliveryClassification("council_validated"), "success");
  assert.equal(inferDeliveryClassification("council_review_waiting_human"), "partial");
  assert.equal(inferDeliveryClassification("council_review_failed"), "partial");
  assert.equal(inferDeliveryClassification("council_review_needs_corrections"), "partial");
  assert.equal(inferDeliveryClassification("implementation_running"), "invalid");
});
