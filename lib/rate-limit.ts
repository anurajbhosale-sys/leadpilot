import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { queryRows, type Db } from "@/db/types";

// Per-client, fixed-window rate limits for the public routes. Counters live in Postgres
// (rate_limits), so the limit holds across serverless instances without another service.

export type RateLimitRule = { name: string; limit: number; windowSeconds: number };

export const RATE_LIMITS = {
  // A person fills the form a few times at most; this stops scripted spam.
  leadForm: { name: "leads", limit: 10, windowSeconds: 600 },
  // Webhooks are signed, so this only caps floods (including bad signatures) per sender.
  callWebhook: { name: "webhook_calls", limit: 120, windowSeconds: 60 },
} satisfies Record<string, RateLimitRule>;

export type RateLimitResult = { allowed: boolean; hits: number; retryAfterSeconds: number };

/** Counts one request from `client` against `rule` and says whether it is within the limit. */
export async function hitRateLimit(db: Db, rule: RateLimitRule, client: string, now = new Date()): Promise<RateLimitResult> {
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const key = `${rule.name}:${createHash("sha256").update(client).digest("hex").slice(0, 32)}`;

  const [row] = await queryRows<{ hits: number }>(
    db,
    sql`insert into rate_limits (key, window_start, hits) values (${key}, ${windowStart.toISOString()}::timestamptz, 1)
        on conflict (key, window_start) do update set hits = rate_limits.hits + 1
        returning hits`,
  );
  // The first hit of a new window tidies up windows that ended over a day ago.
  if (row.hits === 1) {
    await db.execute(sql`delete from rate_limits where window_start < ${windowStart.toISOString()}::timestamptz - interval '1 day'`);
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));
  return { allowed: row.hits <= rule.limit, hits: row.hits, retryAfterSeconds };
}

/** The client's IP. On Vercel, x-forwarded-for is set by the platform, not the caller. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

/**
 * For route handlers: a 429 response when the caller is over the limit, otherwise null.
 * If the limiter itself fails (e.g. a database blip), the request is let through and logged.
 */
export async function rateLimitResponse(db: Db, request: Request, rule: RateLimitRule): Promise<Response | null> {
  try {
    const result = await hitRateLimit(db, rule, clientIp(request));
    if (result.allowed) return null;
    return Response.json(
      { error: "Too many requests. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
    );
  } catch (err) {
    console.error(`Rate limiter failed for ${rule.name}; allowing the request:`, err);
    return null;
  }
}
