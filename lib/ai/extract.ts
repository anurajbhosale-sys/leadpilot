import { generateStructured } from "./client";
import { EXTRACT_LEAD_SYSTEM, EXTRACT_LEAD_VERSION } from "./prompts";
import { leadExtractionSchema, type LeadExtraction } from "@/lib/schemas";

export async function extractLead(message: string): Promise<LeadExtraction> {
  const { object } = await generateStructured({
    task: "extract_lead",
    promptVersion: EXTRACT_LEAD_VERSION,
    schema: leadExtractionSchema,
    system: EXTRACT_LEAD_SYSTEM,
    prompt: `Customer request:\n${message}`,
    mock: () => mockExtractLead(message),
  });
  return object;
}

// Keyword rules standing in for the LLM in mock mode. Deterministic: same text, same answer.
const CATEGORY_KEYWORDS: [LeadExtraction["serviceCategory"], RegExp][] = [
  ["plumbing", /\b(leak\w*|sink|pipes?|drain|toilet|faucet|water heater|clog\w*)\b/i],
  ["hvac", /\b(a\/?c|air condition\w*|furnace|heat(er|ing)?|hvac|thermostat)\b/i],
  ["electrical", /\b(outlets?|wiring|breaker|electric\w*|lights?)\b/i],
  ["pest_control", /\b(ants?|termites?|roach\w*|mice|rats?|pests?|bugs?|wasps?)\b/i],
  ["lawn_care", /\b(lawn|grass|mow\w*|yard|weeds?|landscap\w*)\b/i],
  ["cleaning", /\b(clean\w*|maid|carpet|housekeep\w*)\b/i],
];

export function mockExtractLead(message: string): LeadExtraction {
  const serviceCategory = CATEGORY_KEYWORDS.find(([, re]) => re.test(message))?.[0] ?? "other";
  const urgency = /\b(emergency|urgent|asap|today|tonight|tomorrow|flood\w*|right away|immediately)\b/i.test(message)
    ? "high"
    : /\b(this week|soon|few days)\b/i.test(message)
      ? "medium"
      : "low";
  const contactPreference = /\b(text|sms)\b/i.test(message)
    ? "sms"
    : /\bemail\b/i.test(message)
      ? "email"
      : /\b(call|phone)\b/i.test(message)
        ? "phone"
        : "no_preference";
  const firstSentence = message.trim().split(/(?<=[.!?])\s/)[0];
  const summary = `${serviceCategory.replace("_", " ")} request: ${firstSentence}`.slice(0, 200);
  return { serviceCategory, urgency, contactPreference, summary };
}
