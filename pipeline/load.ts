// Load into the raw layer: records land unchanged, upserted on their source ID,
// so loading the same batch twice leaves exactly the same rows.
import { sql } from "drizzle-orm";
import type { RawTable } from "@/db/schema";
import type { Db } from "@/db/types";
import type { RawRecord } from "./extract";

const CHUNK = 500;

/** Upsert records into a raw_* table. Returns how many distinct records were written. */
export async function loadRaw(db: Db, table: RawTable, system: string, records: RawRecord[], runId: number | null, now = new Date()): Promise<number> {
  // A source can return the same record twice (e.g. it changed while we paged); keep the newest.
  const byId = new Map<string, RawRecord>();
  for (const r of records) {
    const seen = byId.get(r.sourceId);
    if (!seen || r.cursorAt >= seen.cursorAt) byId.set(r.sourceId, r);
  }
  const rows = [...byId.values()].map((r) => ({
    sourceId: r.sourceId,
    source: system,
    payload: r.payload,
    sourceUpdatedAt: r.cursorAt,
    ingestedAt: now,
    runId,
  }));

  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx
        .insert(table)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: table.sourceId,
          set: {
            source: sql`excluded.source`,
            payload: sql`excluded.payload`,
            sourceUpdatedAt: sql`excluded.source_updated_at`,
            ingestedAt: sql`excluded.ingested_at`,
            runId: sql`excluded.run_id`,
          },
        });
    }
  });
  return rows.length;
}
