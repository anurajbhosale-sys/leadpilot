// Deterministic sample history for the mock ad platforms, mock CRM, and seeded leads/calls.
//
// Everything is a pure function of (calendar date, branch, now): the same day always produces the
// same spend, leads, bookings and calls, so reseeding on a later day only adds the new days, and
// the mock ad platform agrees with the seeded leads without sharing any state. Events after `now`
// (a booking two days from now, a future cancellation) are left out until they have "happened".

export type HistoryBranch = { id: number; name: string; zipCodes: string[] };

export const PAID_CHANNELS = ["google_ads", "local_services_ads", "meta"] as const;
export type PaidChannel = (typeof PAID_CHANNELS)[number];

const DAY_MS = 86_400_000;

// ---------- deterministic randomness ----------

/** FNV-1a hash of a string, used to seed a PRNG per (date, branch, purpose). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny, fast, seedable PRNG. Returns floats in [0, 1). */
export function rng(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)];
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- calendar helpers (UTC) ----------

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
const startOfDay = (date: string) => new Date(`${date}T00:00:00Z`);
const dayNumber = (date: string) => Math.floor(startOfDay(date).getTime() / DAY_MS);

/** Calendar dates (UTC) from `days - 1` days before `now` up to and including today. */
export function lastNDates(now: Date, days: number): string[] {
  return Array.from({ length: days }, (_, i) => isoDate(addDays(now, i - days + 1)));
}

// ---------- business assumptions ----------

const BRANCH_SCALE: Record<string, number> = { "Austin North": 1.0, "Denver Metro": 0.8, "Tampa Bay": 1.2 };
const AREA_CODES: Record<string, string> = { "Austin North": "512", "Denver Metro": "303", "Tampa Bay": "813" };
const scale = (b: HistoryBranch) => BRANCH_SCALE[b.name] ?? 1;
const slug = (b: HistoryBranch) => b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
// Weekends are quieter for both spend (bid adjustments) and demand.
const weekdayFactor = (date: string) => ([0, 6].includes(startOfDay(date).getUTCDay()) ? 0.75 : 1);

type Utm = { source: string; medium: string; campaign: string };

const PAID: Record<PaidChannel, { dailySpend: number; cpl: number; cpc: number; ctr: number; bookRate: number; utm: Utm }> = {
  google_ads: { dailySpend: 180, cpl: 55, cpc: 4.2, ctr: 0.05, bookRate: 0.33, utm: { source: "google", medium: "cpc", campaign: "search_services" } },
  local_services_ads: { dailySpend: 90, cpl: 38, cpc: 9, ctr: 0.08, bookRate: 0.45, utm: { source: "google", medium: "lsa", campaign: "local_services" } },
  meta: { dailySpend: 75, cpl: 80, cpc: 1.3, ctr: 0.012, bookRate: 0.22, utm: { source: "facebook", medium: "paid_social", campaign: "seasonal_promo" } },
};

const UNPAID: Record<"organic" | "referral" | "direct", { perDay: number; bookRate: number; utm: Utm | null }> = {
  organic: { perDay: 2.5, bookRate: 0.35, utm: { source: "google", medium: "organic", campaign: "" } },
  referral: { perDay: 1.2, bookRate: 0.5, utm: { source: "nextdoor", medium: "referral", campaign: "" } },
  direct: { perDay: 1.8, bookRate: 0.3, utm: null },
};

export const PLANS: Record<string, { plan: string; monthlyPrice: number }> = {
  pest_control: { plan: "Monthly pest control", monthlyPrice: 49 },
  lawn_care: { plan: "Biweekly lawn care", monthlyPrice: 119 },
  hvac: { plan: "Quarterly HVAC tune-up", monthlyPrice: 45 },
  cleaning: { plan: "Biweekly home cleaning", monthlyPrice: 160 },
  plumbing: { plan: "Home maintenance plan", monthlyPrice: 39 },
  electrical: { plan: "Home maintenance plan", monthlyPrice: 39 },
  other: { plan: "Home maintenance plan", monthlyPrice: 39 },
};

const CATEGORY_MESSAGES: Record<string, string> = {
  pest_control: "Seeing ants in the kitchen again, would like regular pest treatments.",
  lawn_care: "Need someone to mow and edge the yard every couple of weeks.",
  hvac: "AC is blowing warm air, also interested in a maintenance plan.",
  cleaning: "Looking for a recurring house cleaning, 3 bed 2 bath.",
  plumbing: "Water leaking under the kitchen sink, need someone this week.",
  electrical: "Two outlets in the garage stopped working.",
  other: "Need help with a few things around the house, please call me.",
};
const CATEGORIES = Object.keys(CATEGORY_MESSAGES);
const FIRST = ["Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Drew", "Avery", "Chris", "Dana", "Elena", "Marcus", "Nora", "Victor"];
const LAST = ["Lopez", "Smith", "Nguyen", "Johnson", "Patel", "Garcia", "Brown", "Lee", "Martin", "Davis", "Clark", "Wright", "Reyes", "Hall"];
const CANCEL_REASONS = ["too expensive", "moving", "doing it myself", "not satisfied", "switching providers"];
const MEAN_DAYS_TO_CANCEL = 650; // roughly 4-5% of subscriptions cancel per month

// ---------- ad spend ----------

export type SpendDay = { spend: number; clicks: number; impressions: number };

/** What a paid channel spent for one branch on one day. */
export function spendFor(date: string, branch: HistoryBranch, channel: PaidChannel): SpendDay {
  const c = PAID[channel];
  const r = rng(`spend|${date}|${branch.name}|${channel}`);
  const spend = round2(c.dailySpend * scale(branch) * weekdayFactor(date) * (0.85 + 0.3 * r()));
  const clicks = Math.round(spend / c.cpc);
  return { spend, clicks, impressions: Math.round(clicks / c.ctr) };
}

// ---------- one day of business ----------

export type HistoryLead = {
  key: string; // stable idempotency key
  source: "web" | "phone";
  createdAt: Date;
  name: string;
  phone: string | null;
  email: string | null;
  zip: string;
  message: string;
  serviceCategory: string;
  utm: Utm | null;
  gclid: string | null;
  crmCustomerId: string;
};

export type HistoryCustomer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  zip: string;
  branchId: number;
  smsConsent: boolean;
  createdAt: Date;
  bookedAt: Date | null;
  firstServiceDate: string | null;
  updatedAt: Date;
};

export type HistorySubscription = {
  id: string;
  customerId: string;
  plan: string;
  monthlyPrice: number;
  status: "active" | "cancelled";
  startedAt: Date;
  cancelledAt: Date | null;
  cancelReason: string | null;
  updatedAt: Date;
};

export type HistoryCall = {
  callId: string;
  phone: string;
  crmCustomerId: string;
  endedAt: Date;
  intent: "new_quote" | "reschedule" | "complaint" | "cancellation" | "other";
  cancellationRisk: "low" | "medium" | "high";
  summary: string;
  transcript: string;
};

export type HistoryDay = {
  leads: HistoryLead[];
  customers: HistoryCustomer[];
  subscriptions: HistorySubscription[];
  calls: HistoryCall[];
};

/** Stochastic rounding: 2.3 becomes 3 with probability 0.3, so averages stay right. */
const count = (r: () => number, expected: number) => Math.floor(expected + r());

/** A subscription with its lifecycle cut off at `now`: a cancellation only shows once it has happened. */
function subscription(
  id: string,
  customerId: string,
  category: string,
  bookedAt: Date,
  startedAt: Date,
  r: () => number,
  now: Date,
): HistorySubscription {
  const { plan, monthlyPrice } = PLANS[category] ?? PLANS.other;
  const cancelAt = new Date(startedAt.getTime() + -Math.log(1 - r()) * MEAN_DAYS_TO_CANCEL * DAY_MS);
  const cancelled = cancelAt <= now;
  const reason = pick(r, CANCEL_REASONS);
  return {
    id,
    customerId,
    plan,
    monthlyPrice,
    status: cancelled ? "cancelled" : "active",
    startedAt,
    cancelledAt: cancelled ? cancelAt : null,
    cancelReason: cancelled ? reason : null,
    updatedAt: cancelled ? cancelAt : bookedAt,
  };
}

/** Leads, bookings, subscriptions and calls for one branch on one day, as of `now`. */
export function generateDay(date: string, branch: HistoryBranch, now: Date): HistoryDay {
  const day: HistoryDay = { leads: [], customers: [], subscriptions: [], calls: [] };
  const r = rng(`day|${date}|${branch.name}`);
  const area = AREA_CODES[branch.name] ?? "555";
  const dayStart = startOfDay(date).getTime();
  const tag = `${date.replaceAll("-", "")}_${slug(branch)}`;
  const factor = scale(branch) * weekdayFactor(date);
  // Phone numbers in the 555 exchange, unique per (day, lead) for ~250 days
  const phoneFor = (n: number) => `${area}555${String((dayNumber(date) * 40 + n) % 10000).padStart(4, "0")}`;

  // Which channel each of today's leads came from
  const channels: { channel: string; bookRate: number; utm: Utm | null; paid: boolean }[] = [];
  for (const ch of PAID_CHANNELS) {
    const expected = (spendFor(date, branch, ch).spend / PAID[ch].cpl) * (0.9 + 0.2 * r());
    for (let i = 0; i < count(r, expected); i++) channels.push({ channel: ch, ...PAID[ch], paid: true });
  }
  for (const [ch, c] of Object.entries(UNPAID)) {
    for (let i = 0; i < count(r, c.perDay * factor); i++) channels.push({ channel: ch, ...c, paid: false });
  }

  channels.forEach((c, n) => {
    const createdAt = new Date(dayStart + (7 + r() * 14) * 3_600_000); // 07:00-21:00 UTC
    const category = pick(r, CATEGORIES);
    const name = `${pick(r, FIRST)} ${pick(r, LAST)}`;
    const isPhone = c.channel === "direct" && r() < 0.4; // unknown callers become phone leads
    const hasEmail = !isPhone && r() < 0.7;
    const hasPhone = isPhone || !hasEmail || r() < 0.85;
    const phone = hasPhone ? phoneFor(n) : null;
    const email = hasEmail ? `${name.toLowerCase().replace(" ", ".")}.${tag}${n}@example.com` : null;
    const customerId = `hcus_${tag}_${n}`;
    const booked = r() < c.bookRate;
    const bookedAt = new Date(createdAt.getTime() + (2 + r() * 94) * 3_600_000); // 2h to ~4 days later
    const firstService = new Date(bookedAt.getTime() + (1 + Math.floor(r() * 7)) * DAY_MS);
    const subRandom = rng(`sub|${tag}|${n}`); // own stream, so cancellations don't shift other draws
    const resubmits = r() < 0.04; // the same person fills in the form again later that day
    const resubmittedAt = new Date(createdAt.getTime() + 3_600_000 * (1 + r() * 3));
    const smsConsent = r() < 0.7;
    // Every draw happens before this cutoff, so a later `now` never shifts the random stream.
    if (createdAt > now) return;
    const lead: HistoryLead = {
      key: `hist_lead_${tag}_${n}`,
      source: isPhone ? "phone" : "web",
      createdAt,
      name,
      phone,
      email,
      zip: pick(r, branch.zipCodes),
      message: CATEGORY_MESSAGES[category],
      serviceCategory: category,
      utm: c.utm,
      gclid: c.channel === "google_ads" ? `gclid_${tag}_${n}` : null,
      crmCustomerId: customerId,
    };
    day.leads.push(lead);
    if (resubmits && resubmittedAt <= now) {
      day.leads.push({ ...lead, key: `${lead.key}_resubmit`, createdAt: resubmittedAt });
    }

    const isBooked = booked && bookedAt <= now;
    day.customers.push({
      id: customerId,
      name,
      phone,
      email,
      zip: lead.zip,
      branchId: branch.id,
      smsConsent: phone !== null && smsConsent,
      createdAt,
      bookedAt: isBooked ? bookedAt : null,
      firstServiceDate: isBooked ? isoDate(firstService) : null,
      updatedAt: isBooked ? bookedAt : createdAt,
    });
    if (isBooked) {
      day.subscriptions.push(subscription(`hsub_${tag}_${n}`, customerId, category, bookedAt, firstService, subRandom, now));
    }
  });

  // Calls from existing (legacy) customers: questions, reschedules, complaints, cancellations
  const legacy = legacyCustomerCount(branch);
  for (let n = 0; n < count(r, 4 * factor); n++) {
    const endedAt = new Date(dayStart + (8 + r() * 10) * 3_600_000);
    const k = Math.floor(r() * legacy);
    const roll = r();
    const intent = roll < 0.4 ? "new_quote" : roll < 0.65 ? "reschedule" : roll < 0.75 ? "complaint" : roll < 0.85 ? "cancellation" : "other";
    const risk = intent === "cancellation" ? (r() < 0.8 ? "high" : "medium") : intent === "complaint" ? "medium" : "low";
    if (endedAt > now) continue;
    day.calls.push({
      callId: `hist_call_${tag}_${n}`,
      phone: legacyPhone(branch, k),
      crmCustomerId: `hcus_legacy_${slug(branch)}_${k}`,
      endedAt,
      intent,
      cancellationRisk: risk,
      summary: `Customer called about: ${intent.replace("_", " ")}.`,
      transcript: `Agent: Thanks for calling ${branch.name}. Customer: I'm calling about ${intent.replace("_", " ")}.`,
    });
  }
  return day;
}

// ---------- customers who signed up before the history window ----------

const LEGACY_START = Date.UTC(2025, 0, 1);
const legacyCustomerCount = (b: HistoryBranch) => Math.round(60 * scale(b));
const legacyPhone = (b: HistoryBranch, k: number) => `${AREA_CODES[b.name] ?? "555"}555${String(9000 + k).padStart(4, "0")}`;

/**
 * Subscribers acquired before the history window (no lead in the window, so their channel is
 * "unattributed"). They give retention a realistic base. Start dates are fixed (2025), so they
 * never move between seeds.
 */
export function legacyCustomers(branch: HistoryBranch, now: Date): Pick<HistoryDay, "customers" | "subscriptions"> {
  const out: Pick<HistoryDay, "customers" | "subscriptions"> = { customers: [], subscriptions: [] };
  for (let k = 0; k < legacyCustomerCount(branch); k++) {
    const r = rng(`legacy|${branch.name}|${k}`);
    const startedAt = new Date(LEGACY_START + Math.floor(r() * 420) * DAY_MS + 15 * 3_600_000);
    if (startedAt > now) continue;
    const bookedAt = new Date(startedAt.getTime() - 3 * DAY_MS);
    const id = `hcus_legacy_${slug(branch)}_${k}`;
    out.customers.push({
      id,
      name: `${pick(r, FIRST)} ${pick(r, LAST)}`,
      phone: legacyPhone(branch, k),
      email: null,
      zip: pick(r, branch.zipCodes),
      branchId: branch.id,
      smsConsent: r() < 0.7,
      createdAt: bookedAt,
      bookedAt,
      firstServiceDate: isoDate(startedAt),
      updatedAt: bookedAt,
    });
    out.subscriptions.push(subscription(`hsub_legacy_${slug(branch)}_${k}`, id, pick(r, CATEGORIES), bookedAt, startedAt, r, now));
  }
  return out;
}
