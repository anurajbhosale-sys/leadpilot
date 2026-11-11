import { desc, eq } from "drizzle-orm";
import { connection } from "next/server";
import { db } from "@/db";
import { branches, calls } from "@/db/schema";

const RISK_STYLES: Record<string, string> = {
  high: "bg-red-100 text-red-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-emerald-100 text-emerald-800",
};

// Recent analyzed calls, newest first.
export default async function CallsPage() {
  await connection(); // always read fresh rows at request time, never a build-time snapshot

  const rows = await db
    .select({ call: calls, branchName: branches.name })
    .from(calls)
    .leftJoin(branches, eq(calls.branchId, branches.id))
    .orderBy(desc(calls.createdAt))
    .limit(50);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-semibold">Calls</h1>
      <p className="mt-2 text-slate-600">The 50 most recent calls, analyzed when the contact center sends call.ended.</p>

      {rows.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-slate-300 p-6 text-slate-500">
          No calls yet. Send one with <code>npm run webhook:send</code>.
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Branch</th>
                <th className="px-3 py-2 font-medium">Caller</th>
                <th className="px-3 py-2 font-medium">Intent</th>
                <th className="px-3 py-2 font-medium">Risk</th>
                <th className="px-3 py-2 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ call, branchName }) => (
                <tr key={call.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                    {(call.endedAt ?? call.createdAt).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{branchName ?? "-"}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div>{formatPhone(call.phone)}</div>
                    <div className="text-xs text-slate-500">
                      {call.matchedExistingCustomer ? call.crmCustomerId : "new phone lead"}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{call.intent.replace("_", " ")}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${RISK_STYLES[call.cancellationRisk] ?? ""}`}>
                      {call.cancellationRisk}
                    </span>
                    {call.retentionFlag && <div className="mt-1 text-xs font-medium text-red-700">Retention follow-up</div>}
                  </td>
                  <td className="min-w-64 px-3 py-2">{call.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function formatPhone(digits: string) {
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
}
