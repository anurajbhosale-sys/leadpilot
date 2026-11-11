import { describe, expect, it } from "vitest";
import { MockContactCenter, signPayload } from "./calls";

const secret = "test-secret";
const body = JSON.stringify({ type: "call.ended", callId: "c1", phone: "5125550142", transcript: "hi" });
const provider = new MockContactCenter(secret);

describe("webhook signature", () => {
  it("accepts a correctly signed body", () => {
    expect(provider.verifyWebhook(body, signPayload(body, secret))).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(provider.verifyWebhook(body, signPayload(body, "wrong-secret"))).toBe(false);
  });

  it("rejects a body changed after signing", () => {
    const signature = signPayload(body, secret);
    expect(provider.verifyWebhook(body.replace("c1", "c2"), signature)).toBe(false);
  });

  it("rejects a missing, empty, or malformed signature", () => {
    expect(provider.verifyWebhook(body, null)).toBe(false);
    expect(provider.verifyWebhook(body, "")).toBe(false);
    expect(provider.verifyWebhook(body, "sha256=abc")).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    expect(new MockContactCenter("").verifyWebhook(body, signPayload(body, ""))).toBe(false);
  });
});
