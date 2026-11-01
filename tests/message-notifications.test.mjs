import assert from "node:assert/strict";
import test from "node:test";
import { buildGatewayMessageInvokePayload } from "../dist/core/message-notifications.js";

test("gateway notification payload uses the native message tool", () => {
  assert.deepEqual(buildGatewayMessageInvokePayload({
    channel: "telegram",
    target: "123",
    message: "hello",
  }), {
    tool: "message",
    action: "send",
    args: { channel: "telegram", target: "123", message: "hello" },
  });
});

test("optional message delivery fields remain structured", () => {
  assert.deepEqual(buildGatewayMessageInvokePayload({
    channel: "telegram",
    target: "123",
    message: "hello",
    account: "ops",
    deliveryJson: '{"silent":true}',
    dryRun: true,
  }), {
    tool: "message",
    action: "send",
    args: {
      channel: "telegram",
      target: "123",
      message: "hello",
      account: "ops",
      delivery: { silent: true },
      dryRun: true,
    },
  });
});

test("invalid delivery JSON fails before gateway invocation", () => {
  assert.throws(() => buildGatewayMessageInvokePayload({
    channel: "telegram",
    target: "123",
    message: "hello",
    deliveryJson: "not-json",
  }), /notification_delivery_json_invalid/);
});
