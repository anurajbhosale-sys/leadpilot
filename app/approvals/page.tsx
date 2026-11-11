import { asc, desc, eq, ne } from "drizzle-orm";
import { connection } from "next/server";
import { db } from "@/db";
import { approvalQueue, branches } from "@/db/schema";
import { ReviewCard } from "./review-card";

const KIND_LABELS: Record<string, string> = {
  lead_followup_sms: "Lead follow-up",
  winback_sms: "Win-back",
};

const fmt = (d: Date | null) => (d ? d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "-");

// Every customer-facing draft that needs a human: approve (as-is or edited) or reject.
export default async function ApprovalsPage() {
  await connection(); // always fresh

  const select = { item: approvalQueue, branchName: branches.name };
  const pending = await db
    .select(select)
    .from(approvalQueue)
    .leftJoin(branches, eq(approvalQueue.branchId, branches.id))
    .where(eq(approvalQueue.status, "pending"))
    .orderBy(asc(approvalQueue.createdAt));
  const decided = await db
    .select(select)
    .from(approvalQueue)
    .leftJoin(branches, eq(approvalQueue.branchId, branches.id))
    .where(ne(approvalQueue.status, "pending"))
    .orderBy(desc(approvalQueue.reviewedAt))
    .limit(25);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-semibold">Approval queue</h1>
      <p className="mt-2 text-slate-600">
        Approved messages are logged as sent (no real SMS). Edited text must still pass guardrails.
      </p>

      <h2 className="mt-8 text-lg font-semibold">Pending ({pending.length})</h2>
      {pending.length === 0 && <p className="mt-2 text-slate-500">Nothing waiting. Run <code>npm run winback:run</code>.</p>}
      <ul className="mt-3 space-y-4">
        {pending.map(({ item, branchName }) => (
          <li key={item.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <Meta kind={item.kind} branch={branchName} customer={item.customerId} phone={item.toPhone} created={item.createdAt} />
            {item.guardrailErrors.length > 0 && (
              <div className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900">
                Failed guardrails, fix before approving:
                <ul className="list-disc pl-5">
                  {item.guardrailErrors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            <ReviewCard id={item.id} draft={item.draft} />
          </li>
        ))}
      </ul>

      <h2 className="mt-10 text-lg font-semibold">Recent decisions</h2>
      {decided.length === 0 && <p className="mt-2 text-slate-500">No decisions yet.</p>}
      <ul className="mt-3 space-y-3">
        {decided.map(({ item, branchName }) => (
          <li key={item.id} className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <Meta kind={item.kind} branch={branchName} customer={item.customerId} phone={item.toPhone} created={item.createdAt} />
            <p className="mt-2 font-medium">
              {item.status === "rejected" ? (
                <span className="text-red-700">Rejected</span>
              ) : (
                <span className="text-emerald-700">Approved &amp; sent{item.finalText ? " (edited)" : ""}</span>
              )}{" "}
              by {item.reviewedBy ?? "unknown"} on {fmt(item.reviewedAt)}
            </p>
            <p className="mt-1 rounded bg-slate-100 p-2">{item.finalText ?? item.draft}</p>
            {item.finalText && <p className="mt-1 text-slate-500 line-through">{item.draft}</p>}
          </li>
        ))}
      </ul>
    </main>
  );
}

function Meta(p: { kind: string; branch: string | null; customer: string; phone: string | null; created: Date }) {
  return (
    <div className="flex flex-wrap gap-x-4 text-xs text-slate-500">
      <span className="font-medium text-slate-700">{KIND_LABELS[p.kind] ?? p.kind}</span>
      <span>{p.branch ?? "No branch"}</span>
      <span>{p.customer}</span>
      {p.phone && <span>{p.phone}</span>}
      <span>Queued {fmt(p.created)}</span>
    </div>
  );
}
