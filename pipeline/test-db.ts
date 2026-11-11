// Test helper: a real Postgres (PGlite, in-process WebAssembly) with every migration applied and
// the three sample branches, so pipeline SQL is tested against the actual schema. No Docker needed.
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Db } from "@/db/types";

const MIGRATIONS = fileURLToPath(new URL("../db/migrations", import.meta.url));

export const TEST_BRANCHES = [
  { name: "Austin North", region: "Texas", timeZone: "America/Chicago", zipCodes: ["78727", "78728"], businessHours: {} },
  { name: "Denver Metro", region: "Colorado", timeZone: "America/Denver", zipCodes: ["80202", "80203"], businessHours: {} },
  { name: "Tampa Bay", region: "Florida", timeZone: "America/New_York", zipCodes: ["33602", "33606"], businessHours: {} },
];

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(schema.branches).values(TEST_BRANCHES);
  return { db: db as unknown as Db, close: () => client.close() };
}
