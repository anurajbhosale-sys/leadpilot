"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { approvalQueue, branches, leads } from "@/db/schema";
import { checkSms } from "@/lib/guardrails";
import { leadIdFromSourceKey } from "@/lib/idempotency";
import { scheduleSms } from "@/lib/sms";

export type DecisionState = { error?: string; errors?: string[] };

/**
 * Approve (optionally edited) or reject one pending draft.
 * Approved text must still pass guardrails, then it is "sent" (logged) right away.
 */
export async function decide(_prev: DecisionState, form: FormData): Promise<DecisionState> {
  const id = Number(form.get("id"));
  const decision = form.get("decision");
  const reviewer = String(form.get("reviewer") ?? "").trim();
  const text = String(form.get("text") ?? "").trim();
  if (!reviewer) return { error: "Enter your name so we know who made the decision." };

  const [row] = await db
    .select({ item: approvalQueue, approvedOffers: branches.approvedOffers })
    .from(approvalQueue)
    .leftJoin(branches, eq(approvalQueue.branchId, branches.id))
    .where(eq(approvalQueue.id, id));
  if (!row) return { error: "Draft not found." };
  if (row.item.status !== "pending") return { error: "Someone already decided on this draft." };

  const now = new Date();
  // Only update while still pending, so two reviewers can't both decide.
  const stillPending = and(eq(approvalQueue.id, id), eq(approvalQueue.status, "pending"));

  // A lead follow-up draft belongs to a lead, whose follow-up status must follow the decision.
  const lead = row.item.kind === "lead_followup_sms" ? await leadForDraft(row.item) : null;

  if (decision === "reject") {
    const [rejected] = await db
      .update(approvalQueue)
      .set({ status: "rejected", reviewedBy: reviewer, reviewedAt: now })
      .where(stillPending)
      .returning({ id: approvalQueue.id });
    if (!rejected) return { error: "Someone already decided on this draft." };
    if (lead) await db.update(leads).set({ followupStatus: "rejected" }).where(eq(leads.id, lead.id));
    revalidatePath("/approvals");
    return {};
  }

  // A human edit is still customer-facing text: it must pass the same guardrails.
  const check = checkSms(text, { approvedOffers: row.approvedOffers ?? [] });
  if (!check.passed) return { error: "The message still fails guardrails:", errors: check.errors };

  const toPhone = row.item.toPhone ?? lead?.phone;
  if (!toPhone) return { error: "No phone number on file for this customer." };

  const [approved] = await db
    .update(approvalQueue)
    .set({
      status: "sent",
      finalText: text !== row.item.draft ? text : null,
      reviewedBy: reviewer,
      reviewedAt: now,
      sentAt: now,
    })
    .where(stillPending)
    .returning();
  if (!approved) return { error: "Someone already decided on this draft." };

  await scheduleSms(
    {
      sourceKey: `approval_${id}`,
      kind: approved.kind,
      toPhone,
      body: text,
      branchId: approved.branchId,
      approvalId: id,
      leadId: lead?.id,
    },
    now,
  );
  if (lead) await db.update(leads).set({ followupStatus: "sent", followupSms: text }).where(eq(leads.id, lead.id));
  revalidatePath("/approvals");
  return {};
}

/**
 * The lead a follow-up draft was written for. Drafts carry it in their source key
 * ("lead_sms_<leadId>"); drafts queued before Phase 4 have no key, so match on the CRM customer.
 */
async function leadForDraft(item: { sourceKey: string | null; customerId: string }) {
  const leadId = leadIdFromSourceKey(item.sourceKey);
  const where = leadId ? eq(leads.id, leadId) : eq(leads.crmCustomerId, item.customerId);
  const [lead] = await db.select({ id: leads.id, phone: leads.phone }).from(leads).where(where);
  return lead ?? null;
}
