// Writes deterministic sample history (lib/history.ts) into a database. Used by
// `npm run db:seed:history` and by the pipeline tests.
//
// Every row has a stable key, so this is safe to rerun: a later run adds the new days and moves the
// mock CRM forward (new bookings, cancellations); existing leads and calls are left alone.
import { sql as dsql } from "drizzle-orm";
import { branches, calls, leads, mockCrmCustomers, mockCrmSubscriptions } from "./schema";
import type { Db } from "./types";
import {
  generateDay,
  lastNDates,
  legacyCustomers,
  PLANS,
  type HistoryCustomer,
  type HistoryDay,
  type HistorySubscription,
} from "@/lib/history";
import { SEED_CUSTOMERS, SEED_SUBSCRIPTIONS } from "@/lib/providers/crm";

export type HistorySummary = {
  days: number;
  branches: number;
  leads: number;
  calls: number;
  customers: number;
  booked: number;
  subscriptions: number;
  cancelled: number;
};

export async function seedHistory(db: Db, { days = 90, now = new Date() } = {}): Promise<HistorySummary> {
  const branchRows = await db.select().from(branches).orderBy(branches.id);
  if (branchRows.length === 0) throw new Error("No branches yet: run `npm run db:seed` first.");

  const all: HistoryDay = { leads: [], customers: [], subscriptions: [], calls: [] };
  const leadBranch = new Map<string, number>();
  const callBranch = new Map<string, number>();
  for (const branch of branchRows) {
    for (const date of lastNDates(now, days)) {
      const day = generateDay(date, branch, now);
      for (const l of day.leads) leadBranch.set(l.key, branch.id);
      for (const c of day.calls) callBranch.set(c.callId, branch.id);
      all.leads.push(...day.leads);
      all.customers.push(...day.customers);
      all.subscriptions.push(...day.subscriptions);
      all.calls.push(...day.calls);
    }
    const legacy = legacyCustomers(branch, now);
    all.customers.push(...legacy.customers);
    all.subscriptions.push(...legacy.subscriptions);
  }

  // The live mock CRM's sample customers (lib/providers/crm.ts), so the export matches it too.
  const priceOf = (plan: string) => Object.values(PLANS).find((p) => p.plan === plan)?.monthlyPrice ?? 39;
  SEED_CUSTOMERS.forEach((c, i) => {
    const id = `cus_${String(i + 1).padStart(5, "0")}`;
    const sub = SEED_SUBSCRIPTIONS.find((s) => s.customer === i)!;
    const startedAt = new Date(sub.startedAt);
    const created = new Date(startedAt.getTime() - 3 * 86_400_000);
    const cancelledAt = sub.cancelledAt && new Date(sub.cancelledAt) <= now ? new Date(sub.cancelledAt) : null;
    all.customers.push({
      id,
      name: c.name,
      phone: c.phone ?? null,
      email: c.email ?? null,
      zip: c.zip ?? "",
      branchId: c.branchId ?? branchRows[0].id,
      smsConsent: c.smsConsent ?? false,
      createdAt: created,
      bookedAt: created,
      firstServiceDate: sub.startedAt.slice(0, 10),
      updatedAt: created,
    });
    all.subscriptions.push({
      id: `sub_${String(i + 1).padStart(5, "0")}`,
      customerId: id,
      plan: sub.plan,
      monthlyPrice: priceOf(sub.plan),
      status: cancelledAt ? "cancelled" : "active",
      startedAt,
      cancelledAt,
      cancelReason: cancelledAt ? (sub.reason ?? null) : null,
      updatedAt: cancelledAt ?? created,
    });
  });

  const formatPhone = (digits: string | null) => digits && `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  const chunks = <T>(rows: T[], size = 500) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

  for (const chunk of chunks(all.leads)) {
    await db
      .insert(leads)
      .values(
        chunk.map((l) => ({
          source: l.source,
          branchId: leadBranch.get(l.key)!,
          name: l.name,
          phone: formatPhone(l.phone),
          email: l.email,
          zipCode: l.zip,
          message: l.message,
          serviceCategory: l.serviceCategory,
          urgency: "medium",
          preferredContact: l.phone ? "phone" : "email",
          summary: l.message,
          utmSource: l.utm?.source || null,
          utmMedium: l.utm?.medium || null,
          utmCampaign: l.utm?.campaign || null,
          gclid: l.gclid,
          crmCustomerId: l.crmCustomerId,
          idempotencyKey: l.key,
          createdAt: l.createdAt,
        })),
      )
      .onConflictDoNothing({ target: leads.idempotencyKey });
  }

  for (const chunk of chunks(all.calls)) {
    await db
      .insert(calls)
      .values(
        chunk.map((c) => ({
          callId: c.callId,
          phone: c.phone,
          branchId: callBranch.get(c.callId)!,
          transcript: c.transcript,
          summary: c.summary,
          intent: c.intent,
          cancellationRisk: c.cancellationRisk,
          crmCustomerId: c.crmCustomerId,
          matchedExistingCustomer: true,
          retentionFlag: c.cancellationRisk === "high",
          endedAt: c.endedAt,
          createdAt: c.endedAt,
        })),
      )
      .onConflictDoNothing({ target: calls.callId });
  }

  // The CRM moves on as time passes (bookings, cancellations): upsert its current state.
  const excluded = (column: string) => dsql.raw(`excluded.${column}`);
  for (const chunk of chunks<HistoryCustomer>(all.customers)) {
    await db
      .insert(mockCrmCustomers)
      .values(chunk)
      .onConflictDoUpdate({
        target: mockCrmCustomers.id,
        set: {
          bookedAt: excluded("booked_at"),
          firstServiceDate: excluded("first_service_date"),
          smsConsent: excluded("sms_consent"),
          updatedAt: excluded("updated_at"),
        },
      });
  }
  for (const chunk of chunks<HistorySubscription>(all.subscriptions)) {
    await db
      .insert(mockCrmSubscriptions)
      .values(chunk.map((s) => ({ ...s, monthlyPrice: s.monthlyPrice.toFixed(2) })))
      .onConflictDoUpdate({
        target: mockCrmSubscriptions.id,
        set: {
          status: excluded("status"),
          cancelledAt: excluded("cancelled_at"),
          cancelReason: excluded("cancel_reason"),
          updatedAt: excluded("updated_at"),
        },
      });
  }

  return {
    days,
    branches: branchRows.length,
    leads: all.leads.length,
    calls: all.calls.length,
    customers: all.customers.length,
    booked: all.customers.filter((c) => c.bookedAt).length,
    subscriptions: all.subscriptions.length,
    cancelled: all.subscriptions.filter((s) => s.status === "cancelled").length,
  };
}
