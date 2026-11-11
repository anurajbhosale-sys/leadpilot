// USD per 1M tokens. Used to estimate the cost of each logged AI call.
// Unknown models log a null cost rather than a wrong one.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-5-mini": { input: 0.25, output: 2 },
};

export function estimateCostUsd(model: string, inputTokens?: number, outputTokens?: number): number | null {
  if (model === "mock") return 0;
  const price = PRICES[model];
  if (!price || inputTokens === undefined || outputTokens === undefined) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
