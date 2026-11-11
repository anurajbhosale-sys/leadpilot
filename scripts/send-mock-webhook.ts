// Sends a signed call.ended webhook to the local app, the way the contact center would.
//
//   npm run webhook:send                         # sample 1 (cancellation)
//   npm run webhook:send -- --sample 3           # pick a sample (1-5)
//   npm run webhook:send -- --all                # send all five
//   npm run webhook:send -- --call-id test-1     # fixed callId: run twice to see "duplicate"
//   npm run webhook:send -- --bad-signature      # wrong signature: expect 401
import "dotenv/config";
import { parseArgs } from "node:util";
import { signPayload, SIGNATURE_HEADER } from "@/lib/providers/calls";

// Phones for samples 1, 2 and 4 match the mock CRM's seeded customers (in different formats on purpose).
const SAMPLES = [
  {
    name: "cancellation",
    phone: "+1 512 555 0142", // Maria Gonzalez
    branch: "Austin North",
    transcript: `Agent: Thanks for calling, this is Dana. How can I help?
Customer: Hi, I want to cancel my monthly pest control plan.
Agent: I'm sorry to hear that. May I ask why?
Customer: I'm moving to a place that doesn't need it, and money is tight. Please end my plan this month.
Agent: Understood. I'll pass this to our retention team and they'll confirm the cancellation.`,
  },
  {
    name: "reschedule",
    phone: "3035550188", // James Carter
    branch: "Denver Metro",
    transcript: `Agent: Denver Metro, this is Sam.
Customer: Hey, I need to reschedule my lawn service on Thursday. Can we do a different day?
Agent: Sure, does Monday morning work?
Customer: Monday works, thanks.`,
  },
  {
    name: "new_quote",
    phone: "(720) 555-0111", // unknown caller -> new phone lead
    branch: "Denver Metro",
    transcript: `Agent: Thanks for calling, how can I help?
Customer: I'd like a quote for a new AC unit. Ours is 20 years old.
Agent: Happy to help. We can send a technician out for an estimate.
Customer: Great, any afternoon next week is fine.`,
  },
  {
    name: "complaint",
    phone: "813-555-0123", // Priya Patel
    branch: "Tampa Bay",
    transcript: `Agent: Tampa Bay, this is Alex.
Customer: I'm really disappointed. The technician fixed the leak last week but it came back.
Agent: I'm sorry about that. Let me get someone out to look at it again this week.
Customer: Okay, but I'm frustrated. Please make sure it's done right this time.`,
  },
  {
    name: "other",
    phone: "512-555-0199", // unknown caller -> new phone lead
    branch: null,
    transcript: `Agent: Thanks for calling.
Customer: Hi, I just wanted to check what hours your office is open on Saturdays.
Agent: We're open 9 to 2 on Saturdays.
Customer: Perfect, thank you.`,
  },
];

const { values } = parseArgs({
  options: {
    sample: { type: "string", default: "1" },
    all: { type: "boolean", default: false },
    "call-id": { type: "string" },
    "bad-signature": { type: "boolean", default: false },
    url: { type: "string", default: process.env.APP_URL ?? "http://localhost:3000" },
  },
});

const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
  console.error("WEBHOOK_SECRET is not set. Add it to .env (any random string) and restart `npm run dev`.");
  process.exit(1);
}

const index = Number(values.sample) - 1;
if (!values.all && !SAMPLES[index]) {
  console.error(`--sample must be 1-${SAMPLES.length}`);
  process.exit(1);
}
const toSend = values.all ? SAMPLES : [SAMPLES[index]];

for (const sample of toSend) {
  const event = {
    type: "call.ended",
    callId: values["call-id"] ?? `call_${sample.name}_${Date.now()}`,
    phone: sample.phone,
    branch: sample.branch,
    transcript: sample.transcript,
    endedAt: new Date().toISOString(),
  };
  const body = JSON.stringify(event);
  const signature = values["bad-signature"] ? signPayload(body, "wrong-secret") : signPayload(body, secret);

  const res = await fetch(`${values.url}/api/webhooks/calls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: signature },
    body,
  }).catch(() => {
    console.error(`Could not reach ${values.url}. Is \`npm run dev\` running? (Use --url to point elsewhere.)`);
    process.exit(1);
  });
  console.log(`[${sample.name}] ${event.callId} -> ${res.status}`, await res.text());
}
