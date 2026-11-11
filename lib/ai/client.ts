import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import type { z } from "zod";

export type LlmMode = "anthropic" | "openai" | "mock";

/**
 * Which backend to use. Real providers only run when their API key is set;
 * with no key (or LLM_MOCK=true) we fall back to deterministic mock responses,
 * so anyone can clone and run the project without paying for API calls.
 */
export function llmMode(env: Record<string, string | undefined> = process.env): LlmMode {
  if (env.LLM_MOCK === "true") return "mock";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  return "mock";
}

const DEFAULT_MODELS = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-5-mini",
} as const;

function modelFor(mode: Exclude<LlmMode, "mock">) {
  if (mode === "anthropic") return anthropic(process.env.ANTHROPIC_MODEL ?? DEFAULT_MODELS.anthropic);
  return openai(process.env.OPENAI_MODEL ?? DEFAULT_MODELS.openai);
}

export type StructuredRequest<T> = {
  task: string; // short name for logs, e.g. "extract_lead"
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  // Deterministic fake answer used in mock mode. Same prompt in, same object out.
  mock: (prompt: string) => T;
};

export type StructuredResult<T> = {
  object: T;
  task: string;
  model: string;
  mocked: boolean;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  latencyMs: number;
};

/**
 * Ask the LLM for JSON that matches `schema`. The result is always validated by Zod,
 * in mock mode too, so callers can trust the shape either way.
 */
export async function generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const mode = llmMode();
  const started = Date.now();

  if (mode === "mock") {
    return {
      object: req.schema.parse(req.mock(req.prompt)),
      task: req.task,
      model: "mock",
      mocked: true,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
    };
  }

  const model = modelFor(mode);
  const result = await generateText({
    model,
    system: req.system,
    prompt: req.prompt,
    output: Output.object({ schema: req.schema }),
  });

  return {
    object: req.schema.parse(result.output),
    task: req.task,
    model: model.modelId,
    mocked: false,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    latencyMs: Date.now() - started,
  };
}
