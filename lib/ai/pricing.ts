// USD per 1M tokens, from https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-11).
// Used to estimate the cost of each logged AI call. Unknown models log a null cost rather than a wrong one.
type Price = {
  input: number;
  output: number;
  // Some models charge more for a long prompt. A request whose prompt is over `aboveTokens` input
  // tokens pays these prices for ALL of its tokens, input and output.
  longContext?: { aboveTokens: number; input: number; output: number };
};

const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5 } },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-5-mini": { input: 0.25, output: 2 },
};

export function estimateCostUsd(model: string, inputTokens?: number, outputTokens?: number): number | null {
  if (model === "mock") return 0;
  const price = PRICES[model];
  if (!price || inputTokens === undefined || outputTokens === undefined) return null;
  const rate = price.longContext && inputTokens > price.longContext.aboveTokens ? price.longContext : price;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
