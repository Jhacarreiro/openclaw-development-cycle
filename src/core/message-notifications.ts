export type GatewayMessageRequestInput = {
  channel: string;
  target: string;
  message: string;
  account?: string;
  deliveryJson?: string;
  dryRun?: boolean;
};

export function buildGatewayMessageInvokePayload(input: GatewayMessageRequestInput) {
  const args: Record<string, unknown> = {
    channel: input.channel,
    target: input.target,
    message: input.message,
  };
  if (input.account) args.account = input.account;
  if (input.deliveryJson) {
    try {
      args.delivery = JSON.parse(input.deliveryJson);
    } catch {
      throw new Error("notification_delivery_json_invalid");
    }
  }
  if (input.dryRun === true) args.dryRun = true;
  return { tool: "message", action: "send", args };
}
