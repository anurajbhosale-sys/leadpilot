import { analyzeCall } from "@/lib/ai/analyze-call";
import { processCallEnded } from "@/lib/calls";
import { dbCallStore } from "@/lib/calls-store";
import { dbEventLedger } from "@/lib/idempotency";
import { callEndedEventSchema, getCallProvider, SIGNATURE_HEADER } from "@/lib/providers/calls";
import { getCrm } from "@/lib/providers/crm";

// POST /api/webhooks/calls: the contact center calls this when a call ends.
export async function POST(request: Request) {
  if (!process.env.WEBHOOK_SECRET) {
    console.error("WEBHOOK_SECRET is not set; rejecting webhook.");
    return Response.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Verify the signature against the raw body before trusting anything in it.
  const rawBody = await request.text();
  if (!getCallProvider().verifyWebhook(rawBody, request.headers.get(SIGNATURE_HEADER))) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Body is not JSON" }, { status: 400 });
  }

  // Acknowledge event types we don't handle, so the sender doesn't keep retrying them.
  if ((json as { type?: unknown })?.type !== "call.ended") return Response.json({ status: "ignored" });

  const parsed = callEndedEventSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Invalid call.ended payload", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const outcome = await processCallEnded(parsed.data, {
      ledger: dbEventLedger,
      crm: getCrm(),
      store: dbCallStore,
      analyze: analyzeCall,
    });
    // 200 for both: a repeated event is a success that did nothing.
    return Response.json(
      outcome.status === "duplicate"
        ? { status: "duplicate", callId: outcome.callId }
        : {
            status: "processed",
            callId: outcome.callId,
            intent: outcome.record.analysis.intent,
            cancellationRisk: outcome.record.analysis.cancellationRisk,
            crmCustomerId: outcome.record.crmCustomerId,
            matchedExistingCustomer: outcome.record.matchedExistingCustomer,
            leadId: outcome.record.leadId,
            retentionFlag: outcome.record.retentionFlag,
          },
    );
  } catch (err) {
    // 5xx tells the contact center to retry later; the claim was released so the retry will run.
    console.error("Call processing failed:", err);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
}
