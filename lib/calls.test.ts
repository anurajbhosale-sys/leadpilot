import { beforeEach, describe, expect, it, vi } from "vitest";
import { processCallEnded, type CallDeps, type CallRecord } from "./calls";
import { mockAnalyzeCall } from "./ai/analyze-call";
import type { EventLedger } from "./idempotency";
import { MockCrm, SEED_CUSTOMERS } from "./providers/crm";
import type { CallEndedEvent } from "./providers/calls";

// In-memory stand-ins for Postgres, so the flow can be tested without a database.
function memoryLedger(): EventLedger {
  const seen = new Set<string>();
  return {
    async claim(source, id) {
      const key = `${source}:${id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    async release(source, id) {
      seen.delete(`${source}:${id}`);
    },
  };
}

let crm: MockCrm;
let saved: CallRecord[];
let leads: string[];
let deps: CallDeps;

beforeEach(() => {
  crm = new MockCrm(SEED_CUSTOMERS);
  saved = [];
  leads = [];
  deps = {
    ledger: memoryLedger(),
    crm,
    analyze: vi.fn(async (t: string) => mockAnalyzeCall(t)),
    store: {
      branchIdByName: async (name) => ({ "Austin North": 1, "Denver Metro": 2 })[name] ?? null,
      createPhoneLead: async ({ callId }) => {
        leads.push(callId);
        return `lead-${callId}`;
      },
      saveCall: async (r) => {
        saved.push(r);
      },
    },
  };
});

const event = (overrides: Partial<CallEndedEvent> = {}): CallEndedEvent => ({
  type: "call.ended",
  callId: "call-1",
  phone: "+1 512 555 0142", // Maria (seeded)
  branch: "Austin North",
  transcript: "Agent: Hi.\nCustomer: I want to cancel my plan.",
  ...overrides,
});

describe("processCallEnded", () => {
  it("processes a repeated event only once", async () => {
    const first = await processCallEnded(event(), deps);
    const second = await processCallEnded(event(), deps);
    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
    expect(deps.analyze).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
  });

  it("releases the claim on failure so a retry can process the event", async () => {
    vi.mocked(deps.analyze).mockRejectedValueOnce(new Error("LLM timeout"));
    await expect(processCallEnded(event(), deps)).rejects.toThrow("LLM timeout");
    expect((await processCallEnded(event(), deps)).status).toBe("processed");
  });

  it("writes the analysis as a note on the matched customer", async () => {
    const outcome = await processCallEnded(event(), deps);
    if (outcome.status !== "processed") throw new Error("expected processed");
    expect(outcome.record).toMatchObject({ crmCustomerId: "cus_00001", matchedExistingCustomer: true, leadId: null, branchId: 1 });
    expect(crm.notesFor("cus_00001")[0]).toMatch(/intent: cancellation \| cancellation risk: high/);
  });

  it("flags high cancellation risk for retention", async () => {
    const outcome = await processCallEnded(event(), deps);
    expect(outcome.status === "processed" && outcome.record.retentionFlag).toBe(true);
  });

  it("does not flag low-risk calls", async () => {
    const outcome = await processCallEnded(event({ transcript: "Customer: Can I reschedule to a different day?" }), deps);
    expect(outcome.status === "processed" && outcome.record.retentionFlag).toBe(false);
  });

  it("turns an unknown caller into a CRM customer and a phone lead", async () => {
    const outcome = await processCallEnded(event({ callId: "call-2", phone: "720-555-0111" }), deps);
    if (outcome.status !== "processed") throw new Error("expected processed");
    expect(outcome.record.matchedExistingCustomer).toBe(false);
    expect(outcome.record.leadId).toBe("lead-call-2");
    expect(leads).toEqual(["call-2"]);
    expect(crm.notesFor(outcome.record.crmCustomerId)).toHaveLength(1);
  });
});
