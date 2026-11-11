import { AsyncLocalStorage } from "node:async_hooks";
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

export type LoggedAiCall = AiCallLog & { context: string; costUsd: number | null };

type AiLogScope = {
  context: string; // stored in ai_logs.context: "app" for real traffic, "eval" for eval runs
  onCall?: (call: LoggedAiCall) => void; // sees every call made inside the scope
};

const scope = new AsyncLocalStorage<AiLogScope>();

/**
 * Run `fn` with every AI call inside it tagged with `context` (and reported to `onCall`), so eval
 * traffic can be measured on its own and kept out of the app's cost and latency figures.
 */
export function withAiLogScope<T>(s: AiLogScope, fn: () => Promise<T>): Promise<T> {
  return scope.run(s, fn);
}

/** Writes one row to ai_logs. Logging must never break the request, so failures are only printed. */
export async function logAiCall(entry: AiCallLog): Promise<void> {
  const current = scope.getStore();
  const cost = estimateCostUsd(entry.model, entry.inputTokens, entry.outputTokens);
  const call: LoggedAiCall = { ...entry, context: current?.context ?? "app", costUsd: cost };
  current?.onCall?.(call);
  try {
    const { db } = await import("@/db"); // lazy: keeps this module importable without a database
    const { aiLogs } = await import("@/db/schema");
    await db.insert(aiLogs).values({ ...call, costUsd: cost === null ? null : cost.toFixed(6) });
  } catch (err) {
    console.error("Failed to write ai_logs row:", err);
  }
}
