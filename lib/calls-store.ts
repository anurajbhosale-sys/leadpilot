import { eq } from "drizzle-orm";
import { db } from "@/db";
import { branches, calls, leads } from "@/db/schema";
import type { CallStore } from "@/lib/calls";

/** Postgres implementation of CallStore. */
export const dbCallStore: CallStore = {
  async branchIdByName(name) {
    const [row] = await db.select({ id: branches.id }).from(branches).where(eq(branches.name, name));
    return row?.id ?? null;
  },

  async createPhoneLead({ callId, phone, branchId, analysis, crmCustomerId }) {
    const idempotencyKey = `call_${callId}`;
    await db
      .insert(leads)
      .values({
        source: "phone",
        branchId,
        phone,
        message: `Phone call ${callId}: ${analysis.summary}`,
        summary: analysis.summary,
        crmCustomerId,
        idempotencyKey,
      })
      .onConflictDoNothing({ target: leads.idempotencyKey });
    const [lead] = await db.select({ id: leads.id }).from(leads).where(eq(leads.idempotencyKey, idempotencyKey));
    return lead.id;
  },

  async saveCall(r) {
    await db
      .insert(calls)
      .values({
        callId: r.callId,
        phone: r.phone,
        branchId: r.branchId,
        transcript: r.transcript,
        summary: r.analysis.summary,
        intent: r.analysis.intent,
        cancellationRisk: r.analysis.cancellationRisk,
        crmCustomerId: r.crmCustomerId,
        matchedExistingCustomer: r.matchedExistingCustomer,
        leadId: r.leadId,
        retentionFlag: r.retentionFlag,
        endedAt: r.endedAt,
      })
      .onConflictDoNothing({ target: calls.callId });
  },
};
