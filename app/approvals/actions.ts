"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { approvalQueue, branches, leads } from "@/db/schema";
import { checkSms } from "@/lib/guardrails";
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

  if (decision === "reject") {
    await db.update(approvalQueue).set({ status: "rejected", reviewedBy: reviewer, reviewedAt: now }).where(stillPending);
    revalidatePath("/approvals");
    return {};
  }

  // A human edit is still customer-facing text: it must pass the same guardrails.
  const check = checkSms(text, { approvedOffers: row.approvedOffers ?? [] });
  if (!check.passed) return { error: "The message still fails guardrails:", errors: check.errors };

  const toPhone = row.item.toPhone ?? (await phoneForOlderLeadDraft(row.item.customerId));
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
    { sourceKey: `approval_${id}`, kind: approved.kind, toPhone, body: text, branchId: approved.branchId, approvalId: id },
    now,
  );
  revalidatePath("/approvals");
  return {};
}

// Drafts queued before Phase 4 didn't store the phone; find it on the lead instead.
async function phoneForOlderLeadDraft(crmCustomerId: string): Promise<string | null> {
  const [lead] = await db.select({ phone: leads.phone }).from(leads).where(eq(leads.crmCustomerId, crmCustomerId));
  return lead?.phone ?? null;
}
