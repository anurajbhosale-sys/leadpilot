import { eq } from "drizzle-orm";
import { watermarks } from "@/db/schema";
import type { Db } from "@/db/types";

/** High-water marks per source: "we've handled everything up to this time". */
export interface WatermarkStore {
  get(source: string): Promise<Date | null>;
  set(source: string, value: Date): Promise<void>;
}

/** Watermarks kept in the `watermarks` table of the given database. */
export function watermarkStore(db: Db): WatermarkStore {
  return {
    async get(source) {
      const [row] = await db.select().from(watermarks).where(eq(watermarks.source, source));
      return row?.value ?? null;
    },
    async set(source, value) {
      await db
        .insert(watermarks)
        .values({ source, value })
        .onConflictDoUpdate({ target: watermarks.source, set: { value, updatedAt: new Date() } });
    },
  };
}
