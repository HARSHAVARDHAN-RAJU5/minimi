// Live test: real Gemini + real web search. Needs keys in .env. Run with `npm run test:live`.
// Uses 2+ Gemini requests; the free tier has small daily limits on some models.
import { describe, it, expect } from "vitest";
import { loadConfig, loadEnvFile } from "../../src/config.js";
import { webSearchFromConfig } from "../../src/search.js";
import { answer, createGeminiModel, type AgentEvent } from "../../src/llm.js";

loadEnvFile();
const config = loadConfig();
const hasKeys = Boolean(config.geminiApiKey && (config.exaApiKey || config.tavilyApiKey));

describe.skipIf(!hasKeys)("live answer", () => {
  it("searches the web and answers with sources", async () => {
    const events: AgentEvent[] = [];
    for await (const e of answer({
      model: createGeminiModel(config.geminiApiKey!, config.geminiModel),
      search: webSearchFromConfig(config),
      system: "Today is 11 November 2026. Search the web for current facts and cite sources as [n].",
      question: "What is Neon's current Postgres pricing?",
    })) events.push(e);

    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    const sources = events.find((e) => e.type === "sources") as { sources: unknown[] } | undefined;
    console.log(`model=${config.geminiModel}\n${text}`);

    expect(events.some((e) => e.type === "search")).toBe(true);
    expect(text.length).toBeGreaterThan(0);
    expect(sources?.sources.length).toBeGreaterThan(0);
  });
});
