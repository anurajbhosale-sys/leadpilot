import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import type { z } from "zod";
import { demoUsesRealLlm, isDemoMode } from "@/lib/demo";
import { logAiCall } from "@/lib/logging";

export type LlmMode = "anthropic" | "openai" | "mock";

/**
 * Which backend to use. Real providers only run when their API key is set;
 * with no key (or LLM_MOCK=true) we fall back to deterministic mock responses,
 * so anyone can clone and run the project without paying for API calls.
 * A public demo (DEMO_MODE=true) is always mock unless DEMO_LLM=true, so visitors
 * can't spend the owner's API credits even if a key is configured.
 */
export function llmMode(env: Record<string, string | undefined> = process.env): LlmMode {
  if (env.LLM_MOCK === "true") return "mock";
  if (isDemoMode(env) && !demoUsesRealLlm(env)) return "mock";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  return "mock";
}

// Override with ANTHROPIC_MODEL / OPENAI_MODEL. Haiku 5.5 scored 58-59/60 on the golden sets
// at under $0.01 per 60 calls (see README), so a larger default isn't worth its cost here.
export const DEFAULT_MODELS = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-5-mini",
} as const;

function modelFor(mode: Exclude<LlmMode, "mock">) {
  if (mode === "anthropic") return anthropic(process.env.ANTHROPIC_MODEL || DEFAULT_MODELS.anthropic);
  return openai(process.env.OPENAI_MODEL || DEFAULT_MODELS.openai);
}

export type StructuredRequest<T> = {
  task: string; // short name for logs, e.g. "extract_lead"
  promptVersion: string;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  // Deterministic fake answer used in mock mode. Same input in, same object out.
  mock: () => T;
  // Extra checks on the parsed object (e.g. guardrails). Errors mark the logged call as failed.
  validate?: (object: T) => string[];
};

export type StructuredResult<T> = {
  object: T;
  model: string;
  mocked: boolean;
  errors: string[]; // from `validate`; empty means passed
};

/**
 * Ask the LLM for JSON that matches `schema`. The result is always validated by Zod,
 * in mock mode too, so callers can trust the shape either way. Every call is logged to ai_logs.
 */
export async function generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const mode = llmMode();
  const model = mode === "mock" ? null : modelFor(mode);
  const modelName = model?.modelId ?? "mock";
  const started = Date.now();
  const log = { task: req.task, model: modelName, mocked: !model, promptVersion: req.promptVersion };

  try {
    let raw: unknown;
    let usage: { inputTokens?: number; outputTokens?: number } = { inputTokens: 0, outputTokens: 0 };

    if (!model) {
      raw = req.mock();
    } else {
      const result = await generateText({
        model,
        system: req.system,
        prompt: req.prompt,
        output: Output.object({ schema: req.schema }),
      });
      raw = result.output;
      usage = result.usage;
    }

    const object = req.schema.parse(raw);
    const errors = req.validate?.(object) ?? [];
    await logAiCall({
      ...log,
      ...usage,
      latencyMs: Date.now() - started,
      passed: errors.length === 0,
      error: errors.length ? errors.join("; ") : undefined,
    });
    return { object, model: modelName, mocked: !model, errors };
  } catch (err) {
    await logAiCall({ ...log, latencyMs: Date.now() - started, passed: false, error: String(err) });
    throw err;
  }
}
