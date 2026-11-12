import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");

// One shared connection pool. Cached on globalThis so Next.js hot reloads don't open new pools.
// prepare: false lets the same code run through a transaction-mode pooler (Neon's "-pooler" URL,
// PgBouncer), where a prepared statement can land on a different server connection.
// On Vercel, a small pool per instance with a short idle timeout keeps the connection count down.
const globalForDb = globalThis as unknown as { leadpilotSql?: postgres.Sql };
export const sql =
  globalForDb.leadpilotSql ??
  postgres(url, { prepare: false, max: process.env.VERCEL ? 5 : 10, idle_timeout: process.env.VERCEL ? 20 : 0 });
if (process.env.NODE_ENV !== "production") globalForDb.leadpilotSql = sql;

export const db = drizzle(sql, { schema });
