// Public demo deployment: DEMO_MODE=true shows a "synthetic data" banner and forces the mock
// LLM unless DEMO_LLM=true (see llmMode in lib/ai/client.ts), so visitors can't spend API credits.
export function isDemoMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE === "true";
}

export function demoUsesRealLlm(env: Record<string, string | undefined> = process.env): boolean {
  return isDemoMode(env) && env.DEMO_LLM === "true";
}
