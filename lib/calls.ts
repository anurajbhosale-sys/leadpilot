import { normalizePhone } from "@/lib/phone";
import type { EventLedger } from "@/lib/idempotency";
import type { CrmCustomer, CrmProvider } from "@/lib/providers/crm";
import type { CallEndedEvent } from "@/lib/providers/calls";
import type { CallAnalysis } from "@/lib/schemas";

/** Where call results are stored. The real version uses Postgres (lib/calls-store.ts). */
export interface CallStore {
  branchIdByName(name: string): Promise<number | null>;
  /** Unknown caller -> new lead with source "phone". Returns the lead ID. Safe to call twice. */
  createPhoneLead(input: PhoneLeadInput): Promise<string>;
  /** Safe to call twice for the same callId. */
  saveCall(row: CallRecord): Promise<void>;
}

export type PhoneLeadInput = {
  callId: string;
  phone: string;
  branchId: number | null;
  analysis: CallAnalysis;
  crmCustomerId: string;
};

export type CallRecord = {
  callId: string;
  phone: string;
  branchId: number | null;
  transcript: string;
  analysis: CallAnalysis;
  crmCustomerId: string;
  matchedExistingCustomer: boolean;
  leadId: string | null;
  retentionFlag: boolean;
  endedAt: Date | null;
};

export type CallDeps = {
  ledger: EventLedger;
  crm: CrmProvider;
  store: CallStore;
  analyze: (transcript: string) => Promise<CallAnalysis>;
};

export type CallOutcome =
  | { status: "duplicate"; callId: string }
  | { status: "processed"; callId: string; record: CallRecord };

/** Find the CRM customer with this phone number, ignoring formatting. */
export async function findCustomerByPhone(crm: CrmProvider, phone: string): Promise<CrmCustomer | null> {
  const target = normalizePhone(phone);
  if (!target) return null;
  const matches = await crm.searchCustomers({ phone: target });
  // Double-check: don't trust the CRM's matching rules blindly
  return matches.find((c) => normalizePhone(c.phone) === target) ?? null;
}

/**
 * call.ended flow (SPEC A1):
 * 1. Claim the callId in processed_events. Already claimed = a repeat delivery: do nothing.
 * 2. Analyze the transcript with the LLM.
 * 3. Match the caller to a CRM customer by phone. Unknown caller: create a customer and a phone lead.
 * 4. Save the call (with a retention flag for high cancellation risk) and write the note to the CRM.
 * If any step fails, the claim is released so the contact center's retry can process it again.
 */
export async function processCallEnded(event: CallEndedEvent, deps: CallDeps): Promise<CallOutcome> {
  const { ledger, crm, store, analyze } = deps;
  if (!(await ledger.claim("calls", event.callId))) return { status: "duplicate", callId: event.callId };

  try {
    const phone = normalizePhone(event.phone) ?? event.phone.replace(/\D/g, "");
    const branchId = event.branch ? await store.branchIdByName(event.branch) : null;
    const analysis = await analyze(event.transcript);

    let customer = await findCustomerByPhone(crm, phone);
    const matchedExistingCustomer = customer !== null;
    let leadId: string | null = null;
    if (!customer) {
      // Idempotency key per call, so a retry after a failure doesn't create a second customer
      customer = await crm.createCustomer({ name: "Unknown caller", phone, branchId }, `call_${event.callId}`);
      leadId = await store.createPhoneLead({ callId: event.callId, phone, branchId, analysis, crmCustomerId: customer.id });
    }

    const record: CallRecord = {
      callId: event.callId,
      phone,
      branchId,
      transcript: event.transcript,
      analysis,
      crmCustomerId: customer.id,
      matchedExistingCustomer,
      leadId,
      retentionFlag: analysis.cancellationRisk === "high",
      endedAt: event.endedAt ? new Date(event.endedAt) : null,
    };
    await store.saveCall(record);
    await crm.addNote(customer.id, formatCallNote(event.callId, analysis));
    return { status: "processed", callId: event.callId, record };
  } catch (err) {
    await ledger.release("calls", event.callId);
    throw err;
  }
}

export function formatCallNote(callId: string, a: CallAnalysis): string {
  return `Call ${callId} | intent: ${a.intent} | cancellation risk: ${a.cancellationRisk}\n${a.summary}`;
}
