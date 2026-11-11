import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured, llmMode } from "./client";

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
});

describe("generateStructured in mock mode", () => {
  afterEach(() => vi.unstubAllEnvs());

  const schema = z.object({ urgency: z.enum(["low", "high"]) });
  const request = {
    task: "test",
    schema,
    system: "Classify urgency.",
    mock: (prompt: string) => ({ urgency: prompt.includes("leak") ? ("high" as const) : ("low" as const) }),
  };

  it("returns the deterministic mock answer", async () => {
    vi.stubEnv("LLM_MOCK", "true");
    const a = await generateStructured({ ...request, prompt: "water leak under sink" });
    const b = await generateStructured({ ...request, prompt: "water leak under sink" });
    expect(a.object).toEqual({ urgency: "high" });
    expect(b.object).toEqual(a.object);
    expect(a.mocked).toBe(true);
    expect(a.model).toBe("mock");
  });

  it("validates mock output against the schema", async () => {
    vi.stubEnv("LLM_MOCK", "true");
    const bad = { ...request, prompt: "x", mock: () => ({ urgency: "someday" }) as never };
    await expect(generateStructured(bad)).rejects.toThrow();
  });
});
