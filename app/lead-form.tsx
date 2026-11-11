"use client";

import { useState } from "react";

export type Attribution = {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  gclid?: string;
};

type LeadResponse = {
  leadId: string;
  duplicate: boolean;
  branch: { id: number; name: string } | null;
  serviceCategory: string | null;
  urgency: string | null;
  contactPreference: string | null;
  summary: string | null;
  crmCustomerId: string | null;
  followUp: { status: string | null; sms: string | null; sendAt: string | null; sentAt: string | null };
};

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 focus:border-slate-500 focus:outline-none";

export function LeadForm({ attribution }: { attribution: Attribution }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<LeadResponse | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, ...attribution }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        setFieldErrors(data.fieldErrors ?? {});
      } else {
        setResult(data);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <Field label="Name" name="name" error={fieldErrors.name} autoComplete="name" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Phone" name="phone" type="tel" error={fieldErrors.phone} autoComplete="tel" />
          <Field label="Email" name="email" type="email" error={fieldErrors.email} autoComplete="email" />
        </div>
        <Field label="ZIP code" name="zip" error={fieldErrors.zip} autoComplete="postal-code" inputMode="numeric" />
        <label className="block">
          <span className="text-sm font-medium">How can we help?</span>
          <textarea
            name="message"
            rows={4}
            className={inputClass}
            placeholder="e.g. Water leaking under the kitchen sink, need someone this week."
          />
          {fieldErrors.message && <span className="text-sm text-red-600">{fieldErrors.message}</span>}
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {submitting ? "Sending..." : "Request service"}
        </button>
      </form>

      {result && <ResultCard result={result} attribution={attribution} />}
    </>
  );
}

function followUpLabel(f: LeadResponse["followUp"]): string {
  const at = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  if (f.status === "needs_review") return "failed guardrails: sent to the approval queue";
  if (f.status === "no_phone") return "not sent (no phone number)";
  if (f.sentAt) return `sent ${at(f.sentAt)}`;
  if (f.sendAt) return `outside business hours: scheduled for ${at(f.sendAt)}`;
  return f.status ?? "-";
}

function Field({
  label,
  name,
  error,
  ...props
}: { label: string; name: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input name={name} className={inputClass} {...props} />
      {error && <span className="text-sm text-red-600">{error}</span>}
    </label>
  );
}

// Shows what the system did with the lead. Useful while building; a real customer would just see "thanks".
function ResultCard({ result, attribution }: { result: LeadResponse; attribution: Attribution }) {
  const rows: [string, string][] = [
    ["Lead ID", result.leadId],
    ["Duplicate submit", result.duplicate ? "yes (returned the original lead)" : "no"],
    ["Branch", result.branch?.name ?? "none (ZIP not served)"],
    ["Service", result.serviceCategory ?? "-"],
    ["Urgency", result.urgency ?? "-"],
    ["Contact preference", result.contactPreference ?? "-"],
    ["Summary", result.summary ?? "-"],
    ["CRM customer", result.crmCustomerId ?? "-"],
    ["Attribution", Object.entries(attribution).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ") || "none"],
    ["Follow-up SMS", followUpLabel(result.followUp)],
  ];
  return (
    <section className="mt-8 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <h2 className="mb-3 font-semibold">Thanks! Here&apos;s what happened</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {result.followUp.sms && <p className="mt-3 rounded bg-slate-100 p-3">{result.followUp.sms}</p>}
    </section>
  );
}
