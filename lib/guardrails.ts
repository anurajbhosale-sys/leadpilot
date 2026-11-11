// Code checks for every customer-facing message (SPEC section 6).
// They run before anything can be queued or sent. Plain regex on purpose: fast, predictable, testable.

export const OPT_OUT_TEXT = "Reply STOP to opt out";
export const SMS_MAX_LENGTH = 320;

export type GuardrailContext = {
  approvedOffers: string[]; // exact wording allowed for this branch
};

export type GuardrailResult = { passed: boolean; errors: string[] };

// Prices, discounts, free stuff, guarantees
const PRICE_OR_OFFER =
  /\$\s?\d|\b\d+\s?(%|percent\b)|\b\d+\s?(dollars|bucks)\b|\b(discounts?|coupons?|promo(tion)?s?|deals?|special offers?|guarantee[ds]?|warrant(y|ies))\b|\bfree (estimates?|inspections?|quotes?|services?|visits?)\b|\bfor free\b/i;

// Health, safety, or legal claims
const SAFETY_OR_LEGAL =
  /\b(safe for (kids|children|pets|everyone|your family)|100% safe|completely safe|non-?toxic|harmless|chemical-free|eco-?friendly|health (risks?|benefits?)|medical|cures?|legal(ly)?|lawsuits?|liab(le|ility)|code-compliant|insurance will cover)\b/i;

// Contact details: an SMS must never carry another person's phone or email
const PHONE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function checkSms(text: string, ctx: GuardrailContext): GuardrailResult {
  const errors: string[] = [];

  // Approved offers are allowed verbatim: remove them, then look for any other price-like wording.
  let unapproved = text;
  for (const offer of ctx.approvedOffers) {
    unapproved = unapproved.replace(new RegExp(escapeRegex(offer), "gi"), "");
  }
  const offer = unapproved.match(PRICE_OR_OFFER);
  if (offer) errors.push(`Mentions a price, discount, or guarantee that is not an approved offer: "${offer[0]}"`);

  const claim = text.match(SAFETY_OR_LEGAL);
  if (claim) errors.push(`Makes a health, safety, or legal claim: "${claim[0]}"`);

  if (PHONE.test(text) || EMAIL.test(text)) errors.push("Contains a phone number or email address");

  if (!text.toLowerCase().includes(OPT_OUT_TEXT.toLowerCase())) errors.push(`Must include "${OPT_OUT_TEXT}"`);

  if (text.length > SMS_MAX_LENGTH) errors.push(`Too long: ${text.length} characters (max ${SMS_MAX_LENGTH})`);

  return { passed: errors.length === 0, errors };
}
