// Wires everything together: models + search + prompts → one chat() function.
import type { Content } from "@google/genai";
import { missingKeys, type Config } from "./config.js";
import { answer, createGeminiModel, withFallback, type AgentEvent } from "./llm.js";
import { plannerPrompt, writerPrompt } from "./prompts.js";
import { webSearchFromConfig } from "./search.js";

// Earlier messages on the page, so follow-ups like "and Supabase?" work.
export interface ChatTurn { role: "user" | "assistant"; text: string }
export interface ChatInput { question: string; history?: ChatTurn[]; timezone?: string }
export type ChatFn = (input: ChatInput) => AsyncGenerator<AgentEvent>;

export function toContents(history: ChatTurn[] = []): Content[] {
  return history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] }));
}

export function createAgent(config: Config, log: (line: string) => void = console.log): ChatFn {
  return async function* chat({ question, history, timezone }) {
    // Checked per chat (not at start-up) so the page still opens without keys.
    const missing = missingKeys(config);
    if (missing.length) throw new Error(`Add ${missing.join(" and ")} to .env (copy .env.example to .env first).`);

    const fast = createGeminiModel(config.geminiApiKey!, config.geminiFastModel);
    const smart = createGeminiModel(config.geminiApiKey!, config.geminiModel);
    const writer = withFallback(smart, fast, ({ from, to, reason }) => {
      const why = /PerDay|per day/i.test(reason) ? "daily quota used up" : /429|RESOURCE_EXHAUSTED|quota/i.test(reason) ? "quota" : "busy";
      log(`writer fallback ${from} → ${to} (${why})`);
    });

    yield* answer({
      planner: fast,
      writer,
      search: webSearchFromConfig(config),
      plannerSystem: plannerPrompt(timezone),
      writerSystem: writerPrompt(timezone),
      question,
      history: toContents(history),
    });
  };
}
