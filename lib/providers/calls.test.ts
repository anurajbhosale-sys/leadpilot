import { describe, expect, it } from "vitest";
import { MockContactCenter, signPayload } from "./calls";

const secret = "test-secret";
const body = JSON.stringify({ type: "call.ended", callId: "c1", phone: "5125550142", transcript: "hi" });
const provider = new MockContactCenter(secret);
const now = new Date("2026-11-11T16:00:00Z");
const ts = String(now.getTime() / 1000);

const verify = (overrides: Partial<{ rawBody: string; signature: string | null; timestamp: string | null }>, at = now) =>
  provider.verifyWebhook({ rawBody: body, signature: signPayload(body, ts, secret), timestamp: ts, ...overrides }, at);

describe("webhook signature", () => {
  it("accepts a correctly signed, fresh event", () => {
    expect(verify({})).toEqual({ ok: true });
  });

  it("rejects a signature made with a different secret", () => {
    expect(verify({ signature: signPayload(body, ts, "wrong-secret") }).ok).toBe(false);
  });

  it("rejects a body changed after signing", () => {
    expect(verify({ rawBody: body.replace("c1", "c2") }).ok).toBe(false);
  });

  it("rejects a missing, empty, or malformed signature", () => {
    expect(verify({ signature: null }).ok).toBe(false);
    expect(verify({ signature: "" }).ok).toBe(false);
    expect(verify({ signature: "sha256=abc" }).ok).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    const sig = signPayload(body, ts, "");
    expect(new MockContactCenter("").verifyWebhook({ rawBody: body, signature: sig, timestamp: ts }, now).ok).toBe(false);
  });
});

describe("replay protection", () => {
  const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

  it("accepts an event up to 5 minutes old", () => {
    expect(verify({}, minutes(4.9)).ok).toBe(true);
  });

  it("rejects a correctly signed event replayed more than 5 minutes later", () => {
    expect(verify({}, minutes(6))).toEqual({ ok: false, error: "Timestamp outside the allowed window" });
  });

  it("rejects a timestamp too far in the future", () => {
    expect(verify({}, minutes(-6)).ok).toBe(false);
  });

  it("rejects a fresh timestamp swapped onto an old signature", () => {
    // An attacker can't refresh the timestamp: it's part of what was signed.
    const freshTs = String(minutes(10).getTime() / 1000);
    expect(verify({ timestamp: freshTs }, minutes(10))).toEqual({ ok: false, error: "Invalid signature" });
  });

  it("rejects a missing or non-numeric timestamp", () => {
    expect(verify({ timestamp: null }).ok).toBe(false);
    const sig = signPayload(body, "abc", secret);
    expect(verify({ timestamp: "abc", signature: sig }).ok).toBe(false);
  });
});
