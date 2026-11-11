import { estimateCostUsd } from "@/lib/ai/pricing";

export type AiCallLog = {
  task: string;
  model: string;
  mocked: boolean;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  passed: boolean;
  error?: string;
};

/** Writes one row to ai_logs. Logging must never break the request, so failures are only printed. */
export async function logAiCall(entry: AiCallLog): Promise<void> {
  try {
    const { db } = await import("@/db"); // lazy: keeps this module importable without a database
    const { aiLogs } = await import("@/db/schema");
    const cost = estimateCostUsd(entry.model, entry.inputTokens, entry.outputTokens);
    await db.insert(aiLogs).values({ ...entry, costUsd: cost === null ? null : cost.toFixed(6) });
  } catch (err) {
    console.error("Failed to write ai_logs row:", err);
  }
}
