// Wires everything together: models + search + prompts → one chat() function.
import type { Content } from "@google/genai";
import { missingKeys, type Config } from "./config.js";
import { chooseSearchPath, type ChatNote } from "./context.js";
import { answer, createGeminiModel, withFallback, type AgentEvent, type ChatModel, type FallbackInfo } from "./llm.js";
import { plannerPrompt, writerPrompt } from "./prompts.js";
import { webSearchFromConfig, type WebSearch } from "./search.js";

// Earlier messages on the page, so follow-ups like "and Supabase?" work.
export interface ChatTurn { role: "user" | "assistant"; text: string }
// note: the "what we're talking about" note from the last answer (kept by the page for now).
export interface ChatInput { question: string; history?: ChatTurn[]; timezone?: string; note?: ChatNote }
export type ChatFn = (input: ChatInput) => AsyncGenerator<AgentEvent>;

export function toContents(history: ChatTurn[] = []): Content[] {
  return history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] }));
}

export function fallbackLine({ from, to, reason, daily, skipped, until }: FallbackInfo): string {
  const time = until ? until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (skipped) return `writer: skipping ${from} (${daily ? "daily quota used up" : "resting after busy"} until ${time}) → ${to}`;
  const why = daily ? "daily quota used up" : /^no reply/.test(reason) ? reason : "quota or busy";
  return `writer fallback ${from} → ${to} (${why}; skipping it until ${time})`;
}

// Small key/value memory kept across restarts (the database's app_state table).
export interface AppState { getState(key: string): string | undefined; setState(key: string, value: string): void }

export const PLANNER_TIMEOUT_MS = 5000;
// The smart writer normally starts in ~3 s; when it's overloaded it can hang ~27 s before failing.
export const WRITER_FIRST_CHUNK_MS = 8000;

export function createAgent(config: Config, log: (line: string) => void = console.log, state?: AppState): ChatFn {
  // Built once on first use and kept, so the writer remembers a used-up daily quota between chats.
  let parts: { planner: ChatModel; writer: ChatModel; search: WebSearch } | undefined;

  return async function* chat({ question, history, timezone, note }) {
    // Checked per chat (not at start-up) so the page still opens without keys.
    const missing = missingKeys(config);
    if (missing.length) throw new Error(`Add ${missing.join(" and ")} to .env (copy .env.example to .env first).`);

    if (!parts) {
      const fast = createGeminiModel(config.geminiApiKey!, config.geminiFastModel);
      const smart = createGeminiModel(config.geminiApiKey!, config.geminiModel);
      parts = {
        planner: fast,
        writer: withFallback(smart, fast, (info) => log(fallbackLine(info)), {
          firstChunkMs: WRITER_FIRST_CHUNK_MS,
          // Remember "smart model's daily quota is used up until …" across restarts.
          memory: state && {
            load: () => Number(state.getState(`skip_until:${config.geminiModel}`)) || undefined,
            save: (until) => state.setState(`skip_until:${config.geminiModel}`, String(until)),
          },
        }),
        search: webSearchFromConfig(config),
      };
    }

    // Who builds the searches: code (instant) or the AI planner (backup).
    const route = chooseSearchPath(question, note, config.searchMode);
    log(`path: ${route.path} (${route.reason})${route.queries ? ` → ${route.queries.join(" | ")}` : ""}`);

    yield* answer({
      ...parts,
      plannerSystem: plannerPrompt(timezone),
      writerSystem: writerPrompt(timezone),
      question,
      history: toContents(history),
      options: { presetQueries: route.queries, noSearch: route.path === "none", plannerTimeoutMs: PLANNER_TIMEOUT_MS, withNote: true },
      onPlannerError: (err) => log(`planner failed (${err instanceof Error ? err.message.slice(0, 80) : err}) → searching the question as-is`),
      onTimings: (t) => log(
        `timing: plan ${t.planMs.map(ms).join("+") || "-"}, search ${t.searchMs.map(ms).join("+") || "-"}, first word ${t.firstTextMs === undefined ? "-" : ms(t.firstTextMs)}, total ${ms(t.totalMs)}`,
      ),
    });
  };
}

const ms = (n: number) => `${(n / 1000).toFixed(1)}s`;
