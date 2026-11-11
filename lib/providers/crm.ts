// CRM integration sits behind this interface, so a real CRM (FieldRoutes, HubSpot, ...)
// can replace the mock without touching business logic.

export type NewCustomer = {
  name: string;
  phone?: string;
  email?: string;
  zip: string;
  branchId: number | null;
};

export type CrmCustomer = NewCustomer & { id: string; createdAt: Date };

export type CustomerQuery = { phone?: string; email?: string };

export type Cancellation = { customerId: string; cancelledAt: Date; reason?: string };

export type Page<T> = { items: T[]; nextCursor?: string };

export interface CrmProvider {
  /** Creating twice with the same idempotency key returns the first customer, not a duplicate. */
  createCustomer(input: NewCustomer, idempotencyKey: string): Promise<CrmCustomer>;
  searchCustomers(query: CustomerQuery): Promise<CrmCustomer[]>;
  addNote(customerId: string, note: string): Promise<void>;
  listCancellations(since: Date, cursor?: string): Promise<Page<Cancellation>>;
}

/** In-memory CRM for local development and tests. Data resets when the server restarts. */
export class MockCrm implements CrmProvider {
  private customers = new Map<string, CrmCustomer>();
  private byIdempotencyKey = new Map<string, string>(); // key -> customer id
  private notes = new Map<string, string[]>();
  private nextId = 1;

  async createCustomer(input: NewCustomer, idempotencyKey: string): Promise<CrmCustomer> {
    // Seen this key before? Return the customer we already created.
    const existingId = this.byIdempotencyKey.get(idempotencyKey);
    if (existingId) return this.customers.get(existingId)!;

    const customer: CrmCustomer = { ...input, id: `cus_${String(this.nextId++).padStart(5, "0")}`, createdAt: new Date() };
    this.customers.set(customer.id, customer);
    this.byIdempotencyKey.set(idempotencyKey, customer.id);
    return customer;
  }

  async searchCustomers(query: CustomerQuery): Promise<CrmCustomer[]> {
    return [...this.customers.values()].filter(
      (c) => (query.phone && c.phone === query.phone) || (query.email && c.email === query.email),
    );
  }

  async addNote(customerId: string, note: string): Promise<void> {
    if (!this.customers.has(customerId)) throw new Error(`Unknown customer ${customerId}`);
    this.notes.set(customerId, [...(this.notes.get(customerId) ?? []), note]);
  }

  async listCancellations(): Promise<Page<Cancellation>> {
    return { items: [] }; // subscriptions arrive in a later phase
  }

  /** Test/debug helper: how many customers exist. */
  count(): number {
    return this.customers.size;
  }
}

// One mock instance per server process, kept on globalThis so Next.js hot reloads don't wipe it.
const globalForCrm = globalThis as unknown as { leadpilotCrm?: CrmProvider };

export function getCrm(): CrmProvider {
  globalForCrm.leadpilotCrm ??= new MockCrm();
  return globalForCrm.leadpilotCrm;
}
