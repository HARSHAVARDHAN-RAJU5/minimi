// Talking to Gemini: plan searches → search → write the answer.
// - Planner (fast model) decides what to search. Gemini can't search by itself;
//   it asks for web_search and our code runs it (Exa, Tavily backup).
// - Writer (smart model) gets the question + numbered results and writes the answer.
//   If the writer is out of quota, a backup writer (fast model) takes over.
import { GoogleGenAI, FunctionCallingConfigMode, ThinkingLevel, type Content, type Part, type Tool } from "@google/genai";
import type { SearchResult, WebSearch } from "./search.js";
import { noteFromSearches, parseNote, type ChatNote } from "./context.js";

export const MAX_SEARCH_ROUNDS = 3;

export const WEB_SEARCH_TOOL: Tool = {
  functionDeclarations: [{
    name: "web_search",
    description: "Search the web for current facts. Use it for prices, releases, news and anything that changes over time.",
    parametersJsonSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query, e.g. \"Neon Postgres pricing 2026\"" } },
      required: ["query"],
    },
  }],
};

// What answer() sends out, in order: search… → text… → note → sources → done.
export interface Source { n: number; title: string; url: string; publishedDate?: string }
export type AgentEvent =
  | { type: "search"; query: string }
  | { type: "search_failed"; query: string; error: string }
  | { type: "text"; text: string }
  | { type: "note"; note: ChatNote } // hidden "what we're talking about" note, for the next question
  | { type: "sources"; sources: Source[] }
  | { type: "done" };

// The "plug" shape both the real and the fake Gemini follow:
// one model turn, streamed as batches of raw parts.
export interface TurnInput { system: string; contents: Content[]; tools: boolean }
export interface ChatModel { name: string; stream(input: TurnInput): AsyncIterable<Part[]> }

// thinkingLevel: how much Gemini "thinks" before answering ("minimal" | "low" | "medium" | "high").
// Left unset = the model's default.
export function createGeminiModel(apiKey: string, model: string, opts: { thinkingLevel?: ThinkingLevel } = {}): ChatModel {
  const ai = new GoogleGenAI({ apiKey });
  return {
    name: opts.thinkingLevel ? `${model} (thinking ${opts.thinkingLevel})` : model,
    async *stream({ system, contents, tools }) {
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: system,
          ...(opts.thinkingLevel ? { thinkingConfig: { thinkingLevel: opts.thinkingLevel } } : {}),
          ...(tools ? { tools: [WEB_SEARCH_TOOL], toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } } } : {}),
        },
      });
      for await (const chunk of stream) {
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts?.length) yield parts;
      }
    },
  };
}

// Errors where switching to the backup model helps: quota used up, rate limit, overloaded.
export function isQuotaOrBusy(err: unknown): boolean {
  return /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|quota/i.test(errorText(err));
}

// The free daily limit (not a short per-minute limit): waiting a few seconds won't help.
export function isDailyQuota(err: unknown): boolean {
  return /PerDay|per day/i.test(errorText(err));
}

// How long Google says to wait, e.g. "retry in 20h10m27.1s" or "retryDelay":"77455s". Default 1 hour.
export function retryAfterMs(err: unknown): number {
  const msg = errorText(err);
  const delay = /retryDelay\\?"\s*:\s*\\?"(\d+)s/.exec(msg);
  if (delay) return Number(delay[1]) * 1000;
  const m = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(msg);
  if (m && (m[1] || m[2] || m[3])) return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
  return 60 * 60 * 1000;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface FallbackInfo { from: string; to: string; reason: string; daily: boolean; skipped: boolean; until?: Date }

// Uses `primary`; if it fails with quota/busy before sending anything, uses `backup`.
// After a daily-quota error it skips `primary` until Google's reset time, so no answer
// waits for a refusal it already knows is coming.
// `memory` keeps "skip until" across server restarts (e.g. saved in the database).
export interface FallbackOptions {
  now?: () => number;
  memory?: { load(): number | undefined; save(until: number): void };
  firstChunkMs?: number; // main model sends nothing for this long → switch to the backup
  restMs?: number; // after "busy" or no reply: skip the main model this long (default 5 min)
}

export const DEFAULT_REST_MS = 5 * 60 * 1000;

export function withFallback(
  primary: ChatModel,
  backup: ChatModel,
  onFallback: (info: FallbackInfo) => void = () => {},
  options: FallbackOptions = {},
): ChatModel {
  const now = options.now ?? Date.now;
  const restMs = options.restMs ?? DEFAULT_REST_MS;
  let skipUntil = options.memory?.load() ?? 0;
  let skipDaily = skipUntil > 0; // a saved skip time is always a used-up daily quota
  return {
    name: primary.name,
    async *stream(input) {
      if (now() < skipUntil) {
        onFallback({
          from: primary.name, to: backup.name, reason: skipDaily ? "daily quota used up" : "resting after busy",
          daily: skipDaily, skipped: true, until: new Date(skipUntil),
        });
        yield* backup.stream(input);
        return;
      }
      let sentAnything = false;
      const it = primary.stream(input)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = sentAnything || !options.firstChunkMs
            ? await it.next()
            : await firstChunk(it.next(), options.firstChunkMs);
          if (next.done) return;
          sentAnything = true;
          yield next.value;
        }
      } catch (err) {
        if (sentAnything || !(isQuotaOrBusy(err) || err instanceof NoReplyError)) throw err;
        void it.return?.(); // stop waiting on the main model
        const daily = isDailyQuota(err);
        skipDaily = daily;
        skipUntil = now() + (daily ? retryAfterMs(err) : restMs);
        if (daily) options.memory?.save(skipUntil);
        onFallback({
          from: primary.name, to: backup.name, reason: errorText(err).slice(0, 200), daily, skipped: false, until: new Date(skipUntil),
        });
      }
      yield* backup.stream(input);
    },
  };
}

// The main model said nothing in time.
export class NoReplyError extends Error {
  constructor(ms: number) { super(`no reply in ${Math.round(ms / 1000)} s`); }
}

async function firstChunk<T>(next: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([next, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NoReplyError(ms)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

// Speed options (defaults = current behaviour). Used by the speed eval; the real agent
// only changes once a version is proven faster without losing correctness.
export interface AnswerOptions {
  earlySearch?: boolean; // search the question as-is while the planner thinks
  skipPlanner?: boolean; // no planner: search the question as-is, then write
  maxResults?: number; // results kept per search (search returns up to 5)
  maxChars?: number; // page text kept per result (search returns up to 1,500)
  presetQueries?: string[]; // searches built by code: run these, skip the planner
  noSearch?: boolean; // small talk ("thanks!"): no planner, no search, just write
  plannerTimeoutMs?: number; // planner taking longer than this → give up and search the question as-is
  withNote?: boolean; // the writer adds a hidden <note>; cut it out and send it as a "note" event
}

// How long each part took, in milliseconds from the start of answer().
export interface Timings {
  planMs: number[]; // each planner round
  searchMs: number[]; // each search round (incl. the early search)
  firstTextMs?: number; // first word of the answer
  totalMs: number;
}

export interface AnswerInput {
  planner: ChatModel; // fast: decides searches
  writer: ChatModel; // smart: writes the answer
  search: WebSearch;
  plannerSystem: string;
  writerSystem: string;
  question: string;
  history?: Content[]; // earlier turns of this chat (plain text)
  options?: AnswerOptions;
  onTimings?: (t: Timings) => void;
  onPlannerError?: (err: unknown) => void; // planner broke; we searched the question as-is instead
  clock?: () => number;
}

type Found = { query: string; results?: ReturnType<typeof numbered>[]; error?: string };

export async function* answer(input: AnswerInput): AsyncGenerator<AgentEvent> {
  const { planner, writer, search, plannerSystem, writerSystem, question, history = [], options = {}, onTimings } = input;
  const clock = input.clock ?? (() => performance.now());
  const start = clock();
  const timings: Timings = { planMs: [], searchMs: [], totalMs: 0 };
  const sources = new Map<string, Source>(); // url → numbered source, so each link gets one number
  const found: Found[] = [];
  const keep = (results: SearchResult[]) =>
    results.slice(0, options.maxResults).map((r) => (options.maxChars ? { ...r, content: r.content.slice(0, options.maxChars) } : r));

  // Runs one round of searches at the same time; records results; returns each outcome.
  async function* searchRound(queries: string[]): AsyncGenerator<AgentEvent, Array<Record<string, unknown>>> {
    for (const query of queries) yield { type: "search", query };
    const searchStart = clock();
    const outcomes = await Promise.allSettled(queries.map((q) => search(q)));
    timings.searchMs.push(clock() - searchStart);
    const responses: Array<Record<string, unknown>> = [];
    for (let i = 0; i < queries.length; i++) {
      const outcome = outcomes[i];
      if (outcome.status === "fulfilled") {
        const results = keep(outcome.value.results).map((r) => numbered(sources, r));
        found.push({ query: queries[i], results });
        responses.push({ results });
      } else {
        const error = errorText(outcome.reason);
        found.push({ query: queries[i], error });
        yield { type: "search_failed", query: queries[i], error };
        responses.push({ error: `search failed: ${error}` });
      }
    }
    return responses;
  }

  const preset = options.presetQueries?.filter((q) => q.trim());
  if (options.noSearch) {
    // 1) Small talk: nothing to look up.
  } else if (preset?.length) {
    // 1a) Code already built the searches: no planner.
    yield* searchRound(preset);
  } else {
    // Search the question as-is, either alongside planning (earlySearch) or instead of it (skipPlanner).
    const direct = options.earlySearch || options.skipPlanner;
    const directStart = clock();
    const directSearch = direct ? search(question).finally(() => timings.searchMs.push(clock() - directStart)) : undefined;
    directSearch?.catch(() => {}); // handled below; avoids an "unhandled rejection" while planning runs
    if (direct) yield { type: "search", query: question };

    // 1b) Planning: the planner asks for searches, up to MAX_SEARCH_ROUNDS rounds.
    const planContents: Content[] = [...history, { role: "user", parts: [{ text: question }] }];
    for (let round = 0; round < (options.skipPlanner ? 0 : MAX_SEARCH_ROUNDS); round++) {
      const planStart = clock();
      const modelParts: Part[] = [];
      try {
        const stream = planner.stream({ system: plannerSystem, contents: planContents, tools: true });
        for await (const parts of withTimeout(stream, options.plannerTimeoutMs, "planner took too long")) {
          modelParts.push(...parts); // planner text is a draft, never shown
        }
      } catch (err) {
        timings.planMs.push(clock() - planStart);
        input.onPlannerError?.(err);
        // Planner broke: on the first round, search the question as-is; later, write with what we have.
        if (round === 0 && !direct) yield* searchRound([question]);
        break;
      }
      timings.planMs.push(clock() - planStart);
      // Keep the planner's own message exactly as given (it carries hidden thought signatures).
      planContents.push({ role: "model", parts: modelParts });

      const calls = modelParts.filter((p) => p.functionCall?.name === "web_search").map((p) => p.functionCall!);
      if (calls.length === 0) break;

      const responses = yield* searchRound(calls.map((c) => String(c.args?.query ?? "").trim()));
      // Found something? Stop planning (a second look cost seconds and rarely helped).
      // Only ask the planner again when every search failed or came back empty.
      if (responses.some((r) => Array.isArray(r.results) && r.results.length > 0)) break;
      planContents.push({
        role: "user",
        parts: calls.map((c, i) => ({ functionResponse: { id: c.id, name: "web_search", response: responses[i] } })),
      });
    }

    // The direct search's results go first.
    if (directSearch) {
      try {
        const results = keep((await directSearch).results).map((r) => numbered(sources, r));
        found.unshift({ query: question, results });
      } catch (err) {
        const error = errorText(err);
        found.unshift({ query: question, error });
        yield { type: "search_failed", query: question, error };
      }
    }
  }

  // 2) Writing: the writer gets the question plus results as plain numbered text
  //    (another model's tool messages and thought signatures can't be passed across models).
  const writeContents: Content[] = [...history, { role: "user", parts: [{ text: withResults(question, found) }] }];
  const stripper = options.withNote ? new NoteStripper() : undefined;
  let fullText = "";
  const emit = (text: string): AgentEvent | undefined => {
    if (!text) return undefined;
    if (timings.firstTextMs === undefined) timings.firstTextMs = clock() - start;
    fullText += text;
    return { type: "text", text };
  };
  for await (const parts of writer.stream({ system: writerSystem, contents: writeContents, tools: false })) {
    for (const part of parts) {
      if (part.text && !part.thought) {
        const event = emit(stripper ? stripper.push(part.text) : part.text);
        if (event) yield event;
      }
    }
  }
  if (stripper) {
    const event = emit(stripper.end());
    if (event) yield event;
    const note = parseNote(stripper.noteText) ?? noteFromSearches(question, found.map((f) => f.query));
    if (note) yield { type: "note", note };
  }

  yield { type: "sources", sources: citedSources(fullText, [...sources.values()]) };
  timings.totalMs = clock() - start;
  onTimings?.(timings);
  yield { type: "done" };
}

// Passes a stream through, but throws if the whole thing takes longer than `ms`
// (and stops the underlying stream). No limit when ms is undefined.
async function* withTimeout<T>(stream: AsyncIterable<T>, ms: number | undefined, message: string): AsyncGenerator<T> {
  if (!ms) {
    yield* stream;
    return;
  }
  const it = stream[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  try {
    for (;;) {
      const next = await Promise.race([it.next(), timeout]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    clearTimeout(timer);
    void it.return?.(); // stop the planner's stream
  }
}

// Cuts a hidden <note>…</note> out of streamed text, even when it arrives split across
// chunks, so it never reaches the page. Anything else starting with "<" passes through.
export class NoteStripper {
  private buffer = "";
  noteText?: string;

  push(text: string): string {
    this.buffer += text;
    let out = "";
    for (;;) {
      const lt = this.buffer.indexOf("<");
      if (lt === -1) { out += this.buffer; this.buffer = ""; return out; }
      out += this.buffer.slice(0, lt);
      const rest = this.buffer.slice(lt);
      const lower = rest.toLowerCase();
      if (lower.startsWith("<note>")) {
        const end = lower.indexOf("</note>");
        if (end === -1) { this.buffer = rest; return out; } // wait for the rest of the note
        this.noteText = rest.slice(6, end);
        this.buffer = rest.slice(end + 7);
        continue;
      }
      if ("<note>".startsWith(lower)) { this.buffer = rest; return out; } // could still become "<note>"
      out += "<";
      this.buffer = rest.slice(1);
    }
  }

  // End of the answer: release held text, except an unfinished note (dropped).
  end(): string {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.toLowerCase().startsWith("<note>")) return "";
    return rest;
  }
}

// Gives each result a number [n] (same link → same number) and returns what the models see.
function numbered(sources: Map<string, Source>, r: SearchResult) {
  let source = sources.get(r.url);
  if (!source) {
    source = { n: sources.size + 1, title: r.title, url: r.url, ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}) };
    sources.set(r.url, source);
  }
  return { n: source.n, title: r.title, url: r.url, publishedDate: r.publishedDate, content: r.content };
}

// The writer's message: the question, then every search with its numbered results.
export function withResults(question: string, found: Found[]): string {
  if (found.length === 0) return question;
  const blocks = found.map(({ query, results, error }) => {
    if (error) return `Search "${query}": FAILED (${error})`;
    if (!results?.length) return `Search "${query}": no results`;
    const items = results.map((r) => `[${r.n}] ${r.title} (${r.url})${r.publishedDate ? `, published ${r.publishedDate}` : ""}\n${r.content}`);
    return `Search "${query}":\n${items.join("\n\n")}`;
  });
  return `${question}\n\n--- Web search results (cite as [n]) ---\n${blocks.join("\n\n")}`;
}

// Only the sources the answer actually cites, like [1], [2, 3] or [n:2, n:3]. If it cites none, all of them.
function citedSources(text: string, all: Source[]): Source[] {
  const cited = new Set<number>();
  for (const m of text.matchAll(/\[((?:n:)?\d+(?:\s*,\s*(?:n:)?\d+)*)\]/g)) {
    for (const n of m[1].split(",")) cited.add(Number(n.trim().replace("n:", "")));
  }
  const picked = all.filter((s) => cited.has(s.n));
  return picked.length ? picked : all;
}

// Fake Gemini for quick tests: plays a script of turns. Each turn is a list of
// streamed batches of parts. Records every input it got. `fail` makes it throw instead.
export function createFakeModel(script: Part[][][], name = "fake", fail?: Error) {
  const inputs: TurnInput[] = [];
  let turn = 0;
  const model: ChatModel = {
    name,
    async *stream(input) {
      inputs.push(structuredClone(input));
      if (fail) throw fail;
      const batches = script[Math.min(turn++, script.length - 1)];
      for (const batch of batches) yield batch;
    },
  };
  return { model, inputs };
}

// Helpers to write fake scripts briefly.
export const fake = {
  text: (text: string): Part => ({ text }),
  search: (query: string, id = query): Part => ({ functionCall: { id, name: "web_search", args: { query } } }),
};
