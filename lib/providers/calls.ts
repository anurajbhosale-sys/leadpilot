import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// The contact center sits behind this interface, so a real one (Talkdesk, ...) can replace the mock.
export interface CallProvider {
  verifyWebhook(req: WebhookRequest, now?: Date): WebhookVerification;
}

export type WebhookRequest = {
  rawBody: string;
  signature: string | null; // "sha256=<hex>"
  timestamp: string | null; // unix seconds, as sent by the contact center
};

export type WebhookVerification = { ok: true } | { ok: false; error: string };

export const SIGNATURE_HEADER = "x-leadpilot-signature";
export const TIMESTAMP_HEADER = "x-leadpilot-timestamp";

// Events signed longer ago than this are rejected, so a captured request can't be replayed later.
export const MAX_EVENT_AGE_SECONDS = 5 * 60;

/** HMAC-SHA256 over "<timestamp>.<raw body>": changing either one breaks the signature. */
export function signPayload(rawBody: string, timestamp: number | string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/**
 * Mock contact center. We verify against the exact raw body before parsing JSON,
 * because re-serializing could change the bytes and break the signature.
 */
export class MockContactCenter implements CallProvider {
  constructor(private secret: string) {}

  verifyWebhook({ rawBody, signature, timestamp }: WebhookRequest, now = new Date()): WebhookVerification {
    if (!this.secret || !signature || !timestamp) return { ok: false, error: "Missing signature or timestamp" };

    const expected = Buffer.from(signPayload(rawBody, timestamp, this.secret));
    const actual = Buffer.from(signature);
    // Constant-time compare so the response time doesn't leak how much of the signature matched
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { ok: false, error: "Invalid signature" };
    }

    // Checked after the signature, so an attacker can't learn anything from the timestamp check.
    const sentAt = Number(timestamp);
    const ageSeconds = now.getTime() / 1000 - sentAt;
    if (!Number.isFinite(sentAt) || Math.abs(ageSeconds) > MAX_EVENT_AGE_SECONDS) {
      return { ok: false, error: "Timestamp outside the allowed window" };
    }
    return { ok: true };
  }
}

export function getCallProvider(): CallProvider {
  return new MockContactCenter(process.env.WEBHOOK_SECRET ?? "");
}

export const callEndedEventSchema = z.object({
  type: z.literal("call.ended"),
  callId: z.string().min(1).max(200),
  phone: z.string().min(1).max(30),
  branch: z.string().max(100).nullish(), // branch name, as configured in the contact center
  transcript: z.string().min(1).max(50_000),
  endedAt: z.iso.datetime().optional(),
});

export type CallEndedEvent = z.infer<typeof callEndedEventSchema>;
