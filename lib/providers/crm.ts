// CRM integration sits behind this interface, so a real CRM (FieldRoutes, HubSpot, ...)
// can replace the mock without touching business logic.

import { normalizePhone } from "@/lib/phone";

export type NewCustomer = {
  name: string;
  phone?: string;
  email?: string;
  zip?: string;
  branchId: number | null;
  smsConsent?: boolean; // marketing texts (e.g. win-back) need explicit consent; defaults to false
};

export type CrmCustomer = NewCustomer & { id: string; smsConsent: boolean; createdAt: Date };

export type CustomerQuery = { phone?: string; email?: string };

export type Subscription = {
  id: string;
  customerId: string;
  plan: string;
  status: "active" | "cancelled";
  startedAt: Date;
  cancelledAt?: Date;
  cancelReason?: string;
};

export type Cancellation = {
  subscriptionId: string;
  customerId: string;
  plan: string;
  cancelledAt: Date;
  reason?: string;
};

export type Page<T> = { items: T[]; nextCursor?: string };

export interface CrmProvider {
  /** Creating twice with the same idempotency key returns the first customer, not a duplicate. */
  createCustomer(input: NewCustomer, idempotencyKey: string): Promise<CrmCustomer>;
  getCustomer(id: string): Promise<CrmCustomer | null>;
  searchCustomers(query: CustomerQuery): Promise<CrmCustomer[]>;
  /** Writing twice with the same idempotency key adds the note once. */
  addNote(customerId: string, note: string, idempotencyKey: string): Promise<void>;
  /** Cancellations strictly after `since`, oldest first, one page at a time. */
  listCancellations(since: Date, cursor?: string): Promise<Page<Cancellation>>;
}

// Existing customers the mock CRM starts with, so sample calls and win-back have data to work on.
// branchId values match the seeded branches (1 Austin North, 2 Denver Metro, 3 Tampa Bay).
export const SEED_CUSTOMERS: NewCustomer[] = [
  { name: "Maria Gonzalez", phone: "(512) 555-0142", zip: "78727", branchId: 1, smsConsent: true },
  { name: "James Carter", phone: "303-555-0188", zip: "80202", branchId: 2, smsConsent: true },
  { name: "Priya Patel", phone: "813.555.0123", zip: "33609", branchId: 3, smsConsent: true },
  { name: "Tom Nguyen", phone: "512-555-0160", zip: "78728", branchId: 1, smsConsent: true },
  { name: "Lisa Brown", phone: "303-555-0175", zip: "80203", branchId: 2, smsConsent: false },
  { name: "Omar Haddad", phone: "813-555-0190", zip: "33606", branchId: 3, smsConsent: true },
  { name: "Grace Kim", phone: "303-555-0133", zip: "80206", branchId: 2, smsConsent: true },
  { name: "Ben Ortiz", phone: "512-555-0115", zip: "78729", branchId: 1, smsConsent: false },
];

// Subscriptions for the seeded customers (by index). Fixed dates keep every process's mock identical.
type SeedSubscription = { customer: number; plan: string; startedAt: string; cancelledAt?: string; reason?: string };
export const SEED_SUBSCRIPTIONS: SeedSubscription[] = [
  { customer: 0, plan: "Monthly pest control", startedAt: "2025-03-01T15:00:00Z", cancelledAt: "2026-11-02T16:00:00Z", reason: "moving" },
  { customer: 1, plan: "Biweekly lawn care", startedAt: "2025-05-10T15:00:00Z" },
  { customer: 2, plan: "Quarterly HVAC tune-up", startedAt: "2024-09-01T15:00:00Z" },
  { customer: 3, plan: "Biweekly lawn care", startedAt: "2025-04-01T15:00:00Z", cancelledAt: "2026-11-03T14:30:00Z", reason: "doing it myself" },
  { customer: 4, plan: "Monthly pest control", startedAt: "2025-01-15T15:00:00Z", cancelledAt: "2026-11-04T18:00:00Z", reason: "too expensive" },
  { customer: 5, plan: "Quarterly HVAC tune-up", startedAt: "2024-11-20T15:00:00Z", cancelledAt: "2026-11-05T13:15:00Z", reason: "not satisfied" },
  { customer: 6, plan: "Monthly pest control", startedAt: "2025-06-01T15:00:00Z", cancelledAt: "2026-11-06T20:45:00Z", reason: "too expensive" },
  { customer: 7, plan: "Biweekly lawn care", startedAt: "2025-02-01T15:00:00Z", cancelledAt: "2026-11-08T17:00:00Z", reason: "moving" },
];

const PAGE_SIZE = 3; // small on purpose, so the win-back job has to paginate

/** In-memory CRM for local development and tests. Data resets when the process restarts. */
export class MockCrm implements CrmProvider {
  private customers = new Map<string, CrmCustomer>();
  private byIdempotencyKey = new Map<string, string>(); // key -> customer id
  private notes = new Map<string, string[]>();
  private noteKeys = new Set<string>();
  private subscriptions: Subscription[] = [];
  private nextId = 1;

  constructor(seedCustomers: NewCustomer[] = [], seedSubscriptions: SeedSubscription[] = []) {
    const ids = seedCustomers.map((c) => this.insert(c).id);
    for (const s of seedSubscriptions) {
      this.subscriptions.push({
        id: `sub_${String(this.subscriptions.length + 1).padStart(5, "0")}`,
        customerId: ids[s.customer],
        plan: s.plan,
        status: s.cancelledAt ? "cancelled" : "active",
        startedAt: new Date(s.startedAt),
        cancelledAt: s.cancelledAt ? new Date(s.cancelledAt) : undefined,
        cancelReason: s.reason,
      });
    }
  }

  private insert(input: NewCustomer): CrmCustomer {
    const customer: CrmCustomer = {
      ...input,
      smsConsent: input.smsConsent ?? false,
      id: `cus_${String(this.nextId++).padStart(5, "0")}`,
      createdAt: new Date(),
    };
    this.customers.set(customer.id, customer);
    return customer;
  }

  async createCustomer(input: NewCustomer, idempotencyKey: string): Promise<CrmCustomer> {
    // Seen this key before? Return the customer we already created.
    const existingId = this.byIdempotencyKey.get(idempotencyKey);
    if (existingId) return this.customers.get(existingId)!;

    const customer = this.insert(input);
    this.byIdempotencyKey.set(idempotencyKey, customer.id);
    return customer;
  }

  async getCustomer(id: string): Promise<CrmCustomer | null> {
    return this.customers.get(id) ?? null;
  }

  async searchCustomers(query: CustomerQuery): Promise<CrmCustomer[]> {
    // Like most CRMs, phone search ignores formatting
    const phone = normalizePhone(query.phone);
    const email = query.email?.trim().toLowerCase();
    return [...this.customers.values()].filter(
      (c) => (phone && normalizePhone(c.phone) === phone) || (email && c.email?.toLowerCase() === email),
    );
  }

  async addNote(customerId: string, note: string, idempotencyKey: string): Promise<void> {
    if (!this.customers.has(customerId)) throw new Error(`Unknown customer ${customerId}`);
    if (this.noteKeys.has(idempotencyKey)) return; // already written: a retry, not a new note
    this.noteKeys.add(idempotencyKey);
    this.notes.set(customerId, [...(this.notes.get(customerId) ?? []), note]);
  }

  async listCancellations(since: Date, cursor?: string): Promise<Page<Cancellation>> {
    const all = this.subscriptions
      .filter((s) => s.status === "cancelled" && s.cancelledAt! > since)
      .sort((a, b) => a.cancelledAt!.getTime() - b.cancelledAt!.getTime() || a.id.localeCompare(b.id));
    const offset = cursor ? Number(cursor) : 0;
    const items = all.slice(offset, offset + PAGE_SIZE).map((s) => ({
      subscriptionId: s.id,
      customerId: s.customerId,
      plan: s.plan,
      cancelledAt: s.cancelledAt!,
      reason: s.cancelReason,
    }));
    const next = offset + PAGE_SIZE;
    return { items, nextCursor: next < all.length ? String(next) : undefined };
  }

  /** Test/demo helpers */
  count(): number {
    return this.customers.size;
  }

  notesFor(customerId: string): string[] {
    return this.notes.get(customerId) ?? [];
  }

  /** Simulate a customer cancelling right now. */
  addCancellation(customer: NewCustomer, plan: string, reason?: string, at = new Date()): Subscription {
    const c = this.insert(customer);
    const sub: Subscription = {
      id: `sub_${String(this.subscriptions.length + 1).padStart(5, "0")}`,
      customerId: c.id,
      plan,
      status: "cancelled",
      startedAt: new Date(at.getTime() - 180 * 86_400_000),
      cancelledAt: at,
      cancelReason: reason,
    };
    this.subscriptions.push(sub);
    return sub;
  }
}

// One mock instance per server process, kept on globalThis so Next.js hot reloads don't wipe it.
const globalForCrm = globalThis as unknown as { leadpilotCrm?: CrmProvider };

export function getCrm(): CrmProvider {
  globalForCrm.leadpilotCrm ??= new MockCrm(SEED_CUSTOMERS, SEED_SUBSCRIPTIONS);
  return globalForCrm.leadpilotCrm;
}
