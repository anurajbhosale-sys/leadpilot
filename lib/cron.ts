import { timingSafeEqual } from "node:crypto";

/**
 * Cron routes are public URLs, so they require "Authorization: Bearer <CRON_SECRET>"
 * (the header Vercel Cron sends). Without CRON_SECRET configured, every request is refused.
 */
export function cronAuthError(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 500 });

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
  return ok ? null : Response.json({ error: "Unauthorized" }, { status: 401 });
}
