import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// The contact center sits behind this interface, so a real one (Talkdesk, ...) can replace the mock.
export interface CallProvider {
  verifyWebhook(rawBody: string, signature: string | null): boolean;
}

// Header carrying the signature: "sha256=<hex HMAC of the raw request body>"
export const SIGNATURE_HEADER = "x-leadpilot-signature";

export function signPayload(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Mock contact center. Signs webhooks with HMAC-SHA256 over the exact raw body, so we must
 * verify against the raw text before parsing JSON (re-serializing could change the bytes).
 */
export class MockContactCenter implements CallProvider {
  constructor(private secret: string) {}

  verifyWebhook(rawBody: string, signature: string | null): boolean {
    if (!this.secret || !signature) return false;
    const expected = Buffer.from(signPayload(rawBody, this.secret));
    const actual = Buffer.from(signature);
    // Constant-time compare so the response time doesn't leak how much of the signature matched
    return expected.length === actual.length && timingSafeEqual(expected, actual);
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
