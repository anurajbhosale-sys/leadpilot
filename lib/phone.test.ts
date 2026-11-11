import { describe, expect, it } from "vitest";
import { findCustomerByPhone } from "./calls";
import { normalizePhone } from "./phone";
import { MockCrm, SEED_CUSTOMERS } from "./providers/crm";

describe("normalizePhone", () => {
  it.each(["(512) 555-0142", "512.555.0142", "512-555-0142", "+1 512 555 0142", "15125550142"])("%s", (raw) => {
    expect(normalizePhone(raw)).toBe("5125550142");
  });

  it("returns null for numbers that aren't 10 digits", () => {
    expect(normalizePhone("555-0142")).toBeNull();
    expect(normalizePhone("25125550142")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });
});

describe("findCustomerByPhone", () => {
  const crm = new MockCrm(SEED_CUSTOMERS); // Maria is stored as "(512) 555-0142"

  it("matches a customer whatever format the caller ID uses", async () => {
    expect((await findCustomerByPhone(crm, "+15125550142"))?.name).toBe("Maria Gonzalez");
    expect((await findCustomerByPhone(crm, "512 555 0142"))?.name).toBe("Maria Gonzalez");
  });

  it("returns null for an unknown or invalid number", async () => {
    expect(await findCustomerByPhone(crm, "7205550111")).toBeNull();
    expect(await findCustomerByPhone(crm, "anonymous")).toBeNull();
  });
});
