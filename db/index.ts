import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");

// One shared connection pool. Cached on globalThis so Next.js hot reloads don't open new pools.
const globalForDb = globalThis as unknown as { leadpilotSql?: postgres.Sql };
export const sql = globalForDb.leadpilotSql ?? postgres(url);
if (process.env.NODE_ENV !== "production") globalForDb.leadpilotSql = sql;

export const db = drizzle(sql, { schema });
