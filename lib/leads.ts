import { eq } from "drizzle-orm";
import { db } from "@/db";
import { approvalQueue, branches, leads, smsMessages } from "@/db/schema";
import { draftLeadSms } from "@/lib/ai/draft";
import { extractLead } from "@/lib/ai/extract";
import { findBranchByZip, normalizeZip } from "@/lib/branches";
import { leadFollowupSourceKey, leadIdempotencyKey } from "@/lib/idempotency";
import { getCrm } from "@/lib/providers/crm";
import { DEFAULT_BUSINESS_HOURS, DEFAULT_TIME_ZONE, nextSendTime } from "@/lib/quiet-hours";
import { scheduleSms } from "@/lib/sms";
import { leadExtractionSchema, type LeadFormInput } from "@/lib/schemas";

export type LeadResult = {
  leadId: string;
  duplicate: boolean;
  branch: { id: number; name: string } | null;
  serviceCategory: string | null;
  urgency: string | null;
  contactPreference: string | null;
  summary: string | null;
  crmCustomerId: string | null;
  followUp: {
    status: string | null; // "ready" | "needs_review" | "sent" | "rejected" | "no_phone"
    sms: string | null;
    sendAt: Date | null; // when a "ready" SMS goes out (held outside business hours)
    sentAt: Date | null;
  };
};

/**
 * The smart lead form flow:
 * 1. Idempotency check: a resubmitted lead returns the original, with no new AI calls or CRM writes.
 *    Exception: if its follow-up SMS was never drafted (e.g. the LLM call failed), the draft is retried.
 * 2. ZIP -> branch (unknown ZIP: branch is null, the lead is still saved).
 * 3. LLM extraction into validated JSON.
 * 4. Create the CRM customer with the idempotency key.
 * 5. Save the lead.
 * 6. Draft the follow-up SMS with guardrails; drafts that fail twice go to the approval queue.
 * 7. Send a "ready" SMS now during the branch's business hours, otherwise hold it until it opens (A3).
 */
export async function submitLead(input: LeadFormInput): Promise<LeadResult> {
  const idempotencyKey = leadIdempotencyKey(input);

  const existing = await findLeadByKey(idempotencyKey);
  if (existing) {
    if (!existing.followUp.status) {
      await draftFollowUp(existing.leadId);
      return { ...(await findLeadByKey(idempotencyKey))!, duplicate: true };
    }
    return { ...existing, duplicate: true };
  }

  const zip = normalizeZip(input.zip);
  const branch = await findBranchByZip(zip);
  const extraction = await extractLead(input.message);

  // Safe to retry: the CRM returns the same customer for the same key.
  const customer = await getCrm().createCustomer(
    { name: input.name, phone: input.phone || undefined, email: input.email || undefined, zip, branchId: branch?.id ?? null },
    idempotencyKey,
  );

  const [lead] = await db
    .insert(leads)
    .values({
      branchId: branch?.id ?? null,
      name: input.name,
      phone: input.phone || null,
      email: input.email || null,
      zipCode: zip,
      message: input.message,
      serviceCategory: extraction.serviceCategory,
      urgency: extraction.urgency,
      preferredContact: extraction.contactPreference,
      summary: extraction.summary,
      utmSource: input.utmSource,
      utmMedium: input.utmMedium,
      utmCampaign: input.utmCampaign,
      gclid: input.gclid,
      crmCustomerId: customer.id,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: leads.idempotencyKey })
    .returning({ id: leads.id });

  // Lost a race with an identical concurrent submit: return the lead that won.
  if (!lead) return { ...(await findLeadByKey(idempotencyKey))!, duplicate: true };

  await draftFollowUp(lead.id);

  return { ...(await findLeadByKey(idempotencyKey))!, duplicate: false };
}

/**
 * Draft the follow-up SMS for a saved web lead and record the outcome on the lead.
 * Drafts that fail guardrails twice go to the approval queue; drafts that pass are scheduled.
 */
async function draftFollowUp(leadId: string): Promise<void> {
  const [row] = await db
    .select({ lead: leads, branch: branches })
    .from(leads)
    .leftJoin(branches, eq(leads.branchId, branches.id))
    .where(eq(leads.id, leadId));
  const { lead, branch } = row;

  // Email-only lead: nothing to text, so don't spend an LLM call drafting one.
  if (!lead.phone) {
    await db.update(leads).set({ followupStatus: "no_phone" }).where(eq(leads.id, lead.id));
    return;
  }

  const extraction = leadExtractionSchema.parse({
    serviceCategory: lead.serviceCategory,
    urgency: lead.urgency,
    contactPreference: lead.preferredContact,
    summary: lead.summary,
  });

  const draft = await draftLeadSms({
    firstName: (lead.name ?? "there").split(/\s+/)[0],
    message: lead.message,
    extraction,
    branchName: branch?.name ?? "LeadPilot",
    approvedOffers: branch?.approvedOffers ?? [],
  });

  if (draft.status === "needs_review") {
    await db
      .insert(approvalQueue)
      .values({
        kind: "lead_followup_sms",
        sourceKey: leadFollowupSourceKey(lead.id),
        branchId: lead.branchId,
        customerId: lead.crmCustomerId ?? lead.id,
        toPhone: lead.phone,
        draft: draft.sms,
        guardrailErrors: draft.errors,
      })
      .onConflictDoNothing({ target: approvalQueue.sourceKey });
  } else {
    const sendAt = nextSendTime(
      new Date(),
      branch?.businessHours ?? DEFAULT_BUSINESS_HOURS,
      branch?.timeZone ?? DEFAULT_TIME_ZONE,
    );
    await scheduleSms(
      {
        sourceKey: `lead_followup_${lead.id}`,
        kind: "lead_followup_sms",
        toPhone: lead.phone,
        body: draft.sms,
        branchId: lead.branchId,
        leadId: lead.id,
      },
      sendAt,
    );
  }
  await db.update(leads).set({ followupSms: draft.sms, followupStatus: draft.status }).where(eq(leads.id, lead.id));
}

async function findLeadByKey(key: string): Promise<Omit<LeadResult, "duplicate"> | null> {
  const [row] = await db
    .select({ lead: leads, branchName: branches.name, sms: smsMessages })
    .from(leads)
    .leftJoin(branches, eq(leads.branchId, branches.id))
    .leftJoin(smsMessages, eq(smsMessages.leadId, leads.id))
    .where(eq(leads.idempotencyKey, key));
  if (!row) return null;

  const { lead } = row;
  return {
    leadId: lead.id,
    branch: lead.branchId && row.branchName ? { id: lead.branchId, name: row.branchName } : null,
    serviceCategory: lead.serviceCategory,
    urgency: lead.urgency,
    contactPreference: lead.preferredContact,
    summary: lead.summary,
    crmCustomerId: lead.crmCustomerId,
    followUp: {
      status: lead.followupStatus,
      sms: lead.followupSms,
      sendAt: row.sms?.sendAt ?? null,
      sentAt: row.sms?.sentAt ?? null,
    },
  };
}
