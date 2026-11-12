import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { queryRows, type Db } from "@/db/types";
import { createTestDb } from "@/pipeline/test-db";
import { clientIp, hitRateLimit, rateLimitResponse } from "./rate-limit";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const rule = { name: "test", limit: 3, windowSeconds: 60 };
const at = (iso: string) => new Date(iso);

describe("hitRateLimit", () => {
  it("allows up to the limit per client and window, then blocks", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hitRateLimit(db, rule, "1.2.3.4", at("2026-11-11T10:00:10Z")));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ hits: 4, retryAfterSeconds: 50 }); // window ends at 10:01:00
  });

  it("counts each client separately", async () => {
    expect((await hitRateLimit(db, rule, "5.6.7.8", at("2026-11-11T10:00:20Z"))).allowed).toBe(true);
  });

  it("starts a fresh count in the next window", async () => {
    expect(await hitRateLimit(db, rule, "1.2.3.4", at("2026-11-11T10:01:00Z"))).toMatchObject({ allowed: true, hits: 1 });
  });

  it("stores a hash of the client, not the IP", async () => {
    const keys = await queryRows<{ key: string }>(db, sql`select key from rate_limits`);
    expect(keys.every((k) => /^test:[0-9a-f]{32}$/.test(k.key))).toBe(true);
  });

  it("deletes windows that ended over a day ago", async () => {
    await hitRateLimit(db, rule, "1.2.3.4", at("2026-11-13T00:00:00Z"));
    const rows = await queryRows<{ n: number }>(db, sql`select count(*)::int as n from rate_limits`);
    expect(rows[0].n).toBe(1);
  });
});

describe("rateLimitResponse", () => {
  const request = (ip: string) => new Request("http://x/api/leads", { method: "POST", headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });

  it("returns null under the limit and a 429 with Retry-After over it", async () => {
    const tight = { name: "tight", limit: 1, windowSeconds: 600 };
    expect(await rateLimitResponse(db, request("9.9.9.9"), tight)).toBeNull();
    const blocked = await rateLimitResponse(db, request("9.9.9.9"), tight);
    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("lets the request through if the limiter fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { execute: () => Promise.reject(new Error("db down")) } as unknown as Db;
    expect(await rateLimitResponse(broken, request("1.1.1.1"), rule)).toBeNull();
  });
});

describe("clientIp", () => {
  it("uses the first x-forwarded-for address, then x-real-ip", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } }))).toBe("1.1.1.1");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "3.3.3.3" } }))).toBe("3.3.3.3");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});
