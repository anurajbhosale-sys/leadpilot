import { createHash } from "node:crypto";

/**
 * Same person + same request => same key, even if formatting differs
 * ("(512) 555-0100" vs "512-555-0100", "Ann@X.com" vs "ann@x.com").
 * The key is sent to the CRM and stored on the lead, so a resubmit never creates a duplicate.
 */
export function leadIdempotencyKey(input: { phone?: string; email?: string; zip: string; message: string }): string {
  const parts = [
    (input.phone ?? "").replace(/\D/g, "").slice(-10),
    (input.email ?? "").trim().toLowerCase(),
    input.zip.trim().slice(0, 5),
    input.message.trim().toLowerCase().replace(/\s+/g, " "),
  ];
  return "lead_" + createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/**
 * Records which external events we've handled (processed_events).
 * claim() is atomic: only the first caller for a given event gets true.
 * If processing then fails, release() lets the sender's retry run it again.
 */
export interface EventLedger {
  claim(source: string, eventId: string): Promise<boolean>;
  release(source: string, eventId: string): Promise<void>;
}

export const dbEventLedger: EventLedger = {
  async claim(source, eventId) {
    const { db } = await import("@/db"); // lazy: keeps the key helper above usable without a database
    const { processedEvents } = await import("@/db/schema");
    const rows = await db
      .insert(processedEvents)
      .values({ source, eventId })
      .onConflictDoNothing()
      .returning({ id: processedEvents.id });
    return rows.length > 0;
  },
  async release(source, eventId) {
    const { db } = await import("@/db");
    const { processedEvents } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    await db.delete(processedEvents).where(and(eq(processedEvents.source, source), eq(processedEvents.eventId, eventId)));
  },
};
