import type { SmsDraftResult, WinbackDraftInput } from "@/lib/ai/draft";
import type { Cancellation, CrmProvider } from "@/lib/providers/crm";
import type { WatermarkStore } from "@/lib/watermarks";

export const WINBACK_SOURCE = "crm_cancellations";

export type WinbackQueueItem = {
  sourceKey: string;
  branchId: number | null;
  customerId: string;
  toPhone: string;
  draft: string;
  guardrailErrors: string[];
};

export type WinbackDeps = {
  crm: CrmProvider;
  watermarks: WatermarkStore;
  branches: { get(id: number): Promise<{ name: string; approvedOffers: string[] } | null> };
  queue: {
    has(sourceKey: string): Promise<boolean>;
    add(item: WinbackQueueItem): Promise<void>; // must ignore a sourceKey that's already queued
  };
  draft: (input: WinbackDraftInput) => Promise<SmsDraftResult>;
};

export type WinbackSummary = {
  since: string | null;
  cancellations: number;
  queued: number;
  flagged: number; // queued with guardrail errors for the reviewer to fix
  skippedNoConsent: number;
  skippedNoPhone: number;
  alreadyQueued: number;
  watermark: string | null;
};

/**
 * Win-back job (SPEC A2), run hourly:
 * 1. Read every cancellation since the last watermark (all pages).
 * 2. Skip customers without SMS consent or a phone number.
 * 3. Draft a personalized SMS (approved offers only, same guardrails as everything else).
 * 4. Every draft goes to the approval queue; a person decides. Failed guardrails are shown to them.
 * 5. Advance the watermark only after the whole batch succeeded. If anything throws, it stays put
 *    and the next run retries the batch; drafts already queued are recognized and skipped.
 */
export async function runWinback(deps: WinbackDeps): Promise<WinbackSummary> {
  const since = await deps.watermarks.get(WINBACK_SOURCE);

  const cancellations: Cancellation[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.crm.listCancellations(since ?? new Date(0), cursor);
    cancellations.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  const summary: WinbackSummary = {
    since: since?.toISOString() ?? null,
    cancellations: cancellations.length,
    queued: 0,
    flagged: 0,
    skippedNoConsent: 0,
    skippedNoPhone: 0,
    alreadyQueued: 0,
    watermark: since?.toISOString() ?? null,
  };

  for (const c of cancellations) {
    const sourceKey = `winback_${c.subscriptionId}`;
    if (await deps.queue.has(sourceKey)) {
      summary.alreadyQueued++; // drafted by an earlier run that failed before advancing the watermark
      continue;
    }

    const customer = await deps.crm.getCustomer(c.customerId);
    if (!customer?.smsConsent) {
      summary.skippedNoConsent++;
      continue;
    }
    if (!customer.phone) {
      summary.skippedNoPhone++;
      continue;
    }

    const branch = customer.branchId ? await deps.branches.get(customer.branchId) : null;
    const result = await deps.draft({
      firstName: customer.name.split(/\s+/)[0],
      plan: c.plan,
      reason: c.reason,
      branchName: branch?.name ?? "LeadPilot",
      approvedOffers: branch?.approvedOffers ?? [],
    });

    const guardrailErrors = result.status === "needs_review" ? result.errors : [];
    await deps.queue.add({
      sourceKey,
      branchId: branch ? customer.branchId : null, // the CRM may know branches we don't
      customerId: customer.id,
      toPhone: customer.phone,
      draft: result.sms,
      guardrailErrors,
    });
    summary.queued++;
    if (guardrailErrors.length) summary.flagged++;
  }

  // Everything succeeded: move the watermark to the newest cancellation we saw.
  if (cancellations.length) {
    const newest = new Date(Math.max(...cancellations.map((c) => c.cancelledAt.getTime())));
    await deps.watermarks.set(WINBACK_SOURCE, newest);
    summary.watermark = newest.toISOString();
  }
  return summary;
}
