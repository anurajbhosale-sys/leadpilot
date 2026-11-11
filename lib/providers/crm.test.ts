import { describe, expect, it } from "vitest";
import { MockCrm, SEED_CUSTOMERS, SEED_SUBSCRIPTIONS } from "./crm";

describe("MockCrm.listCancellations", () => {
  const crm = new MockCrm(SEED_CUSTOMERS, SEED_SUBSCRIPTIONS);

  it("pages through cancellations oldest first", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await crm.listCancellations(new Date(0), cursor);
      seen.push(...page.items.map((c) => c.cancelledAt.toISOString()));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(pages).toBe(2);
    expect([...seen].sort()).toEqual(seen);
  });

  it("only returns cancellations strictly after `since`", async () => {
    const page = await crm.listCancellations(new Date("2026-11-05T13:15:00Z"));
    expect(page.items.map((c) => c.plan)).toEqual(["Monthly pest control", "Biweekly lawn care"]);
  });
});

describe("MockCrm.addNote", () => {
  it("writes a note once per idempotency key", async () => {
    const crm = new MockCrm(SEED_CUSTOMERS);
    await crm.addNote("cus_00001", "first", "key-1");
    await crm.addNote("cus_00001", "first again", "key-1");
    await crm.addNote("cus_00001", "second", "key-2");
    expect(crm.notesFor("cus_00001")).toEqual(["first", "second"]);
  });
});
