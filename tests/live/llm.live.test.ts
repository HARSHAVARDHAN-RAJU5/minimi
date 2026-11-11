// Live test: real Gemini + real web search. Needs keys in .env. Run with `npm run test:live`.
// Planner = fast model, writer = smart model (falls back to the fast model if out of quota).
import { describe, it, expect } from "vitest";
import { loadConfig, loadEnvFile } from "../../src/config.js";
import { webSearchFromConfig } from "../../src/search.js";
import { answer, createGeminiModel, withFallback, type AgentEvent } from "../../src/llm.js";

loadEnvFile();
const config = loadConfig();
const hasKeys = Boolean(config.geminiApiKey && (config.exaApiKey || config.tavilyApiKey));

describe.skipIf(!hasKeys)("live answer", () => {
  it("plans with the fast model, searches, and the writer answers with sources", async () => {
    const fast = createGeminiModel(config.geminiApiKey!, config.geminiFastModel);
    const smart = createGeminiModel(config.geminiApiKey!, config.geminiModel);
    let usedWriter = config.geminiModel;
    const writer = withFallback(smart, fast, ({ to, reason }) => {
      usedWriter = to;
      console.log(`writer fallback → ${to}: ${reason.slice(0, 120)}`);
    });

    const events: AgentEvent[] = [];
    const start = performance.now();
    let firstWordMs = 0;
    for await (const e of answer({
      planner: fast,
      writer,
      search: webSearchFromConfig(config),
      plannerSystem: "Today is 11 November 2026. Decide which web searches are needed and call web_search for each.",
      writerSystem: "Today is 11 November 2026. Answer using the search results. Cite sources as [1], [2].",
      question: "What is Neon's current Postgres pricing?",
    })) {
      if (e.type === "text" && !firstWordMs) firstWordMs = performance.now() - start;
      events.push(e);
    }

    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    const sources = events.find((e) => e.type === "sources") as { sources: unknown[] } | undefined;
    const searches = events.filter((e) => e.type === "search").map((e) => (e as { query: string }).query);
    console.log(`writer=${usedWriter} first word=${Math.round(firstWordMs)} ms total=${Math.round(performance.now() - start)} ms\nsearches: ${searches.join(" | ")}\n\n${text}`);

    expect(searches.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(sources?.sources.length).toBeGreaterThan(0);
  });
});
