import type { SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Any Drizzle Postgres database or transaction with our schema: postgres-js in the app,
 * PGlite (in-process Postgres) in tests. Code that takes a `Db` never imports the app's
 * connection, so it can be tested without a running database.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

/** Run raw SQL and return its rows. (postgres-js returns an array, PGlite returns { rows }.) */
export async function queryRows<T>(db: Db, query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
