import { and, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { smsMessages } from "@/db/schema";

// Nothing really leaves the building: "sending" writes the message to the log and marks it sent.
// A real SMS provider (e.g. Twilio) would be called from sendNow().

export type OutgoingSms = {
  sourceKey: string; // one message per source, so retries never double-send
  kind: string;
  toPhone: string;
  body: string;
  branchId: number | null;
  leadId?: string;
  approvalId?: number;
};

/** Queue an SMS for `sendAt`, and send it right away if that time has come. */
export async function scheduleSms(sms: OutgoingSms, sendAt: Date, now = new Date()) {
  const [row] = await db
    .insert(smsMessages)
    .values({ ...sms, sendAt })
    .onConflictDoNothing({ target: smsMessages.sourceKey })
    .returning();
  if (row && sendAt <= now) await sendNow(row.id);
}

/** Send every scheduled message whose time has come (run by cron). Returns how many were sent. */
export async function sendDueSms(now = new Date()): Promise<number> {
  const due = await db
    .select({ id: smsMessages.id })
    .from(smsMessages)
    .where(and(eq(smsMessages.status, "scheduled"), lte(smsMessages.sendAt, now)));
  for (const { id } of due) await sendNow(id);
  return due.length;
}

async function sendNow(id: number) {
  // Only flips scheduled -> sent once, even if two workers race on the same row.
  const [sent] = await db
    .update(smsMessages)
    .set({ status: "sent", sentAt: new Date() })
    .where(and(eq(smsMessages.id, id), eq(smsMessages.status, "scheduled")))
    .returning();
  if (sent) console.log(`[sms] sent ${sent.kind} to ${sent.toPhone}: ${sent.body}`);
}
