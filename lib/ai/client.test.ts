import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_MODELS, generateStructured, llmMode } from "./client";
import { logAiCall } from "@/lib/logging";

vi.mock("@/lib/logging", () => ({ logAiCall: vi.fn() }));

describe("llmMode", () => {
  it("uses mock mode when no API key is set", () => {
    expect(llmMode({})).toBe("mock");
  });

  it("prefers Anthropic, then OpenAI", () => {
    expect(llmMode({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })).toBe("anthropic");
    expect(llmMode({ OPENAI_API_KEY: "o" })).toBe("openai");
  });

  it("LLM_MOCK=true forces mock mode even with a key", () => {
    expect(llmMode({ LLM_MOCK: "true", ANTHROPIC_API_KEY: "a" })).toBe("mock");
  });

  it("DEMO_MODE=true forces mock mode even with a key, unless DEMO_LLM=true", () => {
    expect(llmMode({ DEMO_MODE: "true", ANTHROPIC_API_KEY: "a" })).toBe("mock");
    expect(llmMode({ DEMO_MODE: "true", DEMO_LLM: "false", OPENAI_API_KEY: "o" })).toBe("mock");
    expect(llmMode({ DEMO_MODE: "true", DEMO_LLM: "true", ANTHROPIC_API_KEY: "a" })).toBe("anthropic");
    expect(llmMode({ DEMO_LLM: "true" })).toBe("mock"); // still needs a key
  });
});

describe("default models", () => {
  it("defaults to Claude Haiku 5.5 (override with ANTHROPIC_MODEL)", () => {
    expect(DEFAULT_MODELS.anthropic).toBe("claude-haiku-5-5");
  });
});

describe("generateStructured in mock mode", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_MOCK", "true");
    vi.mocked(logAiCall).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  const schema = z.object({ urgency: z.enum(["low", "high"]) });
  const request = {
    task: "test",
    promptVersion: "test@1",
    schema,
    system: "Classify urgency.",
    prompt: "water leak under sink",
    mock: () => ({ urgency: "high" as const }),
  };

  it("returns the mock answer and logs a passed call", async () => {
    const result = await generateStructured(request);
    expect(result).toMatchObject({ object: { urgency: "high" }, mocked: true, model: "mock", errors: [] });
    expect(logAiCall).toHaveBeenCalledWith(expect.objectContaining({ task: "test", model: "mock", passed: true }));
  });

  it("logs a failed call when validate returns errors", async () => {
    const result = await generateStructured({ ...request, validate: () => ["too urgent"] });
    expect(result.errors).toEqual(["too urgent"]);
    expect(logAiCall).toHaveBeenCalledWith(expect.objectContaining({ passed: false, error: "too urgent" }));
  });

  it("rejects mock output that doesn't match the schema, and logs it", async () => {
    const bad = { ...request, mock: () => ({ urgency: "someday" }) as never };
    await expect(generateStructured(bad)).rejects.toThrow();
    expect(logAiCall).toHaveBeenCalledWith(expect.objectContaining({ passed: false }));
  });
});
