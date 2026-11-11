import { LeadForm, type Attribution } from "./lead-form";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// Attribution comes from the landing URL, e.g. /?utm_source=google&utm_medium=cpc&gclid=abc
export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const attribution: Attribution = {
    utmSource: first(params.utm_source),
    utmMedium: first(params.utm_medium),
    utmCampaign: first(params.utm_campaign),
    gclid: first(params.gclid),
  };

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-3xl font-semibold">How can we help?</h1>
      <p className="mt-2 text-slate-600">Tell us what you need and the nearest branch will get back to you.</p>
      <LeadForm attribution={attribution} />
    </main>
  );
}
