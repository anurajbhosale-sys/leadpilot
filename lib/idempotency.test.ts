import { describe, expect, it } from "vitest";
import { leadFollowupSourceKey, leadIdempotencyKey, leadIdFromSourceKey } from "./idempotency";
import { MockCrm } from "./providers/crm";

const lead = { phone: "(512) 555-0100", email: "Ann@Example.com", zip: "78727", message: "Leaking sink" };

describe("leadIdempotencyKey", () => {
  it("is the same for the same lead, ignoring formatting", () => {
    const reformatted = { phone: "512-555-0100", email: " ann@example.com", zip: "78727-0001", message: "  leaking   SINK " };
    expect(leadIdempotencyKey(reformatted)).toBe(leadIdempotencyKey(lead));
  });

  it("differs when the request differs", () => {
    expect(leadIdempotencyKey({ ...lead, message: "Clogged drain" })).not.toBe(leadIdempotencyKey(lead));
  });
});

describe("MockCrm.createCustomer", () => {
  const customer = { name: "Ann Lee", phone: "5125550100", zip: "78727", branchId: 1 };

  it("creates one customer when the same lead is submitted twice", async () => {
    const crm = new MockCrm();
    const key = leadIdempotencyKey(lead);
    const first = await crm.createCustomer(customer, key);
    const second = await crm.createCustomer(customer, key);
    expect(second.id).toBe(first.id);
    expect(crm.count()).toBe(1);
  });

  it("creates separate customers for different keys", async () => {
    const crm = new MockCrm();
    await crm.createCustomer(customer, "key-a");
    await crm.createCustomer(customer, "key-b");
    expect(crm.count()).toBe(2);
  });
});

describe("lead follow-up source keys", () => {
  it("round-trips the lead ID, so approving a draft can update its lead", () => {
    const leadId = "3f2b8c1e-9a4d-4e7f-8b21-0c6d5e4f3a2b";
    expect(leadIdFromSourceKey(leadFollowupSourceKey(leadId))).toBe(leadId);
  });

  it("returns null for other drafts and drafts without a key", () => {
    expect(leadIdFromSourceKey("winback_sub_00003")).toBeNull();
    expect(leadIdFromSourceKey(null)).toBeNull();
  });
});
