// Wires everything together: models + search + prompts → one chat() function.
import type { Content } from "@google/genai";
import { missingKeys, type Config } from "./config.js";
import { chooseSearchPath, isSmallTalk, type ChatNote } from "./context.js";
import type { Db } from "./db.js";
import { answer, createGeminiModel, withFallback, type AgentEvent, type AnswerInput, type ChatModel, type FallbackInfo } from "./llm.js";
import { plannerPrompt, writerPrompt } from "./prompts.js";
import { understand, type Understanding } from "./listener.js";
import { lookupMemory } from "./memoryroute.js";
import { isMemoryQuestion, memoryBlock, memorySearches, recall, recallSummary } from "./recall.js";
import { decisionsBlock, decisionsFor } from "./decisions.js";
import { namedThings, oldFactsFor, stillTrueBlock } from "./stilltrue.js";
import { webSearchFromConfig, type WebSearch } from "./search.js";

// Earlier messages on the page, so follow-ups like "and Supabase?" work.
export interface ChatTurn { role: "user" | "assistant"; text: string }
// note: the "what we're talking about" note from the last answer.
// userId + messageId (the saved question): needed to look through this user's old chats.
export interface ChatInput { question: string; history?: ChatTurn[]; timezone?: string; note?: ChatNote; userId?: number; messageId?: number }
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
// The backup (fast) writer can legitimately take 7-11 s when Google is busy; past 20 s, give up with a clear error.
export const BACKUP_FIRST_CHUNK_MS = 20000;

// db: keeps the used-up quota across restarts, and lets memory questions look through old chats.
// fakes: tests can plug in a fake planner, writer and search instead of the real ones.
export function createAgent(
  config: Config,
  log: (line: string) => void = console.log,
  db?: AppState & Partial<Db>,
  fakes?: { planner: ChatModel; writer: ChatModel; search: WebSearch; listener?: ChatModel },
): ChatFn {
  const state = db;
  // Built once on first use and kept, so the writer remembers a used-up daily quota between chats.
  let parts: { planner: ChatModel; writer: ChatModel; search: WebSearch; listener?: ChatModel } | undefined = fakes;

  return async function* chat({ question, history, timezone, note, userId, messageId }) {
    // Checked per chat (not at start-up) so the page still opens without keys.
    const missing = missingKeys(config);
    if (missing.length) throw new Error(`Add ${missing.join(" and ")} to .env (copy .env.example to .env first).`);

    if (!parts) {
      const fast = createGeminiModel(config.geminiApiKey!, config.geminiFastModel);
      const smart = createGeminiModel(config.geminiApiKey!, config.geminiModel);
      parts = {
        planner: fast,
        listener: fast, // understands the question; code checks and acts
        writer: withFallback(smart, fast, (info) => log(fallbackLine(info)), {
          firstChunkMs: WRITER_FIRST_CHUNK_MS,
          backupFirstChunkMs: BACKUP_FIRST_CHUNK_MS,
          // Remember "smart model's daily quota is used up until …" across restarts.
          memory: state && {
            load: () => Number(state.getState(`skip_until:${config.geminiModel}`)) || undefined,
            save: (until) => state.setState(`skip_until:${config.geminiModel}`, String(until)),
          },
        }),
        search: webSearchFromConfig(config),
      };
    }

    const { listener, ...models } = parts;
    const common: Omit<AnswerInput, "options" | "memory"> = {
      ...models,
      plannerSystem: plannerPrompt(timezone),
      writerSystem: writerPrompt(timezone),
      question,
      history: toContents(history),
      onPlannerError: (err) => log(`planner failed (${err instanceof Error ? err.message.slice(0, 80) : err}) → searching the question as-is`),
      onTimings: (t) => log(
        `timing: plan ${t.planMs.map(ms).join("+") || "-"}, search ${t.searchMs.map(ms).join("+") || "-"}, first word ${t.firstTextMs === undefined ? "-" : ms(t.firstTextMs)}, total ${ms(t.totalMs)}`,
      ),
    };

    const hasDb = Boolean(db?.listThings && userId);

    // 1) Listen: the fast AI fills a short form about the question (skipped when it's obvious).
    //    Code checks the form and does the work. No form → the old code rules below.
    // (A product we talked about before is never obvious: "is Vercel still $20?" may be about memory.)
    const obvious = isSmallTalk(question)
      || (!history?.length && !isMemoryQuestion(question, undefined, timezone) && chooseSearchPath(question, undefined, "code-first").path === "code"
        && !(hasDb && namedThings(db as Db, userId!, question).length));
    let u: Understanding | undefined;
    if (listener && config.searchMode === "code-first" && !obvious) {
      const heard = await understand(listener, { question, history, timezone });
      u = heard.understanding;
      log(u ? `listener (${ms(heard.ms)}): ${describe(u)}` : `listener failed (${heard.problem}) → old way`);
    } else if (listener && obvious) {
      log("listener: skipped (obvious)");
    }

    if (u && !(u.type === "memory" && !hasDb)) {
      if (u.type === "memory") {
        const lm = lookupMemory(db as Db, userId!, question, u, { timezone, beforeMessageId: messageId });
        log(`memory (${u.lookingFor || "chat"}): ${lm.reason}`);
        log(`path: memory → ${lm.searches.join(" | ") || "no search"}`);
        if (lm.decisions.length) log(`decisions: ${lm.decisions.map((d) => d.choice).join(", ")}`);
        if (lm.recall) {
          yield { type: "recall", ...recallSummary(lm.recall) };
        } else {
          yield {
            type: "recall", found: lm.decisions.length > 0, chats: [],
            note: lm.decisions.length ? `Your decisions: ${lm.decisions.map((d) => d.choice).join(", ")}` : "No decision saved yet",
          };
        }
        const blocks = [
          lm.recall ? memoryBlock(lm.recall, timezone) : lm.decisions.length ? undefined : "--- Memory: earlier chats (THEN) ---\nNOT FOUND: no decision saved yet.",
          decisionsBlock(lm.decisions, timezone),
        ];
        yield* answer({
          ...common,
          memory: blocks.filter(Boolean).join("\n\n"),
          options: { presetQueries: lm.searches, noSearch: lm.searches.length === 0, plannerTimeoutMs: PLANNER_TIMEOUT_MS, withNote: true },
        });
        return;
      }

      // New question or follow-up: the listener's searches (it worked out "it", "and X?", …).
      const about = `${question} ${u.products.join(" ")}`;
      const oldFacts = hasDb && u.type !== "small_talk" ? oldFactsFor(db as Db, userId!, about) : [];
      const decided = hasDb && u.type !== "small_talk" ? decisionsFor(db as Db, userId!, about) : [];
      if (oldFacts.length) log(`still true?: ${oldFacts.length} old facts (${[...new Set(oldFacts.map((f) => f.thing))].join(", ")})`);
      if (decided.length) log(`decisions: ${decided.map((d) => d.choice).join(", ")}`);
      log(`path: listener → ${u.searches.join(" | ") || "no search"}`);
      yield* answer({
        ...common,
        memory: [stillTrueBlock(oldFacts, timezone), decisionsBlock(decided, timezone)].filter(Boolean).join("\n\n") || undefined,
        options: { presetQueries: u.searches, noSearch: u.type === "small_talk", plannerTimeoutMs: PLANNER_TIMEOUT_MS, withNote: true },
      });
      return;
    }

    // 2) The old way (obvious questions, or no form from the listener).
    // Memory question ("what did I ask on 3 Nov?", "since Monday…"): find the old chat, check each
    // remembered thing now, and give the writer THEN (old chat + facts) and NOW (fresh results).
    const rec = db?.listThings && userId ? recall(db as Db, userId, question, { timezone, beforeMessageId: messageId }) : undefined;
    if (rec) {
      log(`memory question: ${rec.reason}`);
      yield { type: "recall", ...recallSummary(rec) };
      const queries = memorySearches(rec, question);
      const nothingToCheck = rec.status === "none" || (rec.hasTopic && !rec.topicMatched);
      log(`path: memory → ${queries.length ? queries.join(" | ") : nothingToCheck ? "no search" : "planner"}`);
      const decided = decisionsFor(db as Db, userId!, question);
      if (decided.length) log(`decisions: ${decided.map((d) => d.choice).join(", ")}`);
      yield* answer({
        ...common,
        memory: [memoryBlock(rec, timezone), decisionsBlock(decided, timezone)].filter(Boolean).join("\n\n"),
        options: { presetQueries: queries, noSearch: nothingToCheck, plannerTimeoutMs: PLANNER_TIMEOUT_MS, withNote: true },
      });
      return;
    }

    // Who builds the searches: code (instant) or the AI planner (backup).
    const route = chooseSearchPath(question, note, config.searchMode);
    log(`path: ${route.path} (${route.reason})${route.queries ? ` → ${route.queries.join(" | ")}` : ""}`);

    // "Still true?": the question names something we told this user about before → give the writer
    // those old values, so it can mention a change (and stay quiet if nothing changed).
    const oldFacts = db?.listThings && userId && route.path !== "none" ? oldFactsFor(db as Db, userId, question) : [];
    if (oldFacts.length) log(`still true?: ${oldFacts.length} old facts (${[...new Set(oldFacts.map((f) => f.thing))].join(", ")})`);
    // Decision log: the user already picked between these options → build on it, don't re-suggest the rest.
    const decided = db?.listDecisions && userId && route.path !== "none" ? decisionsFor(db as Db, userId, question) : [];
    if (decided.length) log(`decisions: ${decided.map((d) => d.choice).join(", ")}`);

    yield* answer({
      ...common,
      memory: [stillTrueBlock(oldFacts, timezone), decisionsBlock(decided, timezone)].filter(Boolean).join("\n\n") || undefined,
      options: { presetQueries: route.queries, noSearch: route.path === "none", plannerTimeoutMs: PLANNER_TIMEOUT_MS, withNote: true },
    });
  };
}

const ms = (n: number) => `${(n / 1000).toFixed(1)}s`;

// One line for the log: what the listener understood.
function describe(u: Understanding): string {
  const bits = [u.type, u.lookingFor && `looking for ${u.lookingFor}`, u.when && `when "${u.when}"`, u.topic && `topic "${u.topic}"`, u.products.length && `products ${u.products.join(", ")}`];
  return bits.filter(Boolean).join(" · ");
}
