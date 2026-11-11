import { generateStructured } from "./client";
import { ANALYZE_CALL_SYSTEM, ANALYZE_CALL_VERSION } from "./prompts";
import { callAnalysisSchema, type CallAnalysis } from "@/lib/schemas";

export async function analyzeCall(transcript: string): Promise<CallAnalysis> {
  const { object } = await generateStructured({
    task: "analyze_call",
    promptVersion: ANALYZE_CALL_VERSION,
    schema: callAnalysisSchema,
    system: ANALYZE_CALL_SYSTEM,
    prompt: `Transcript:\n${transcript}`,
    mock: () => mockAnalyzeCall(transcript),
  });
  return object;
}

// Keyword rules standing in for the LLM in mock mode. Deterministic: same transcript, same answer.
export function mockAnalyzeCall(transcript: string): CallAnalysis {
  // Only the customer's words decide intent; the agent's script shouldn't.
  const customerLines = transcript
    .split("\n")
    .filter((l) => /^\s*customer\s*:/i.test(l))
    .map((l) => l.replace(/^\s*customer\s*:\s*/i, "").trim());
  const said = (customerLines.length ? customerLines : [transcript]).join(" ");

  const cancel = /\b(cancel\w*|stop (the )?service|switch(ing)? to (another|a different)|end my (plan|subscription))\b/i.test(said);
  const complain = /\b(unhappy|complain\w*|disappointed|terrible|frustrat\w*|still (not|isn't|hasn't)|came back|no-?show)\b/i.test(said);
  const reschedule = /\b(reschedul\w*|move my appointment|different (day|time)|push (it|the appointment))\b/i.test(said);
  const quote = /\b(quote|estimate|how much|pricing|new service|interested in|sign up)\b/i.test(said);

  const intent: CallAnalysis["intent"] = cancel
    ? "cancellation"
    : complain
      ? "complaint"
      : reschedule
        ? "reschedule"
        : quote
          ? "new_quote"
          : "other";
  const cancellationRisk = cancel ? "high" : complain ? "medium" : "low";
  const summary = `Caller (${intent.replace("_", " ")}): ${customerLines[0] ?? said}`.slice(0, 300);
  return { summary, intent, cancellationRisk };
}
