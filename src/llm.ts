// Talking to Gemini: plan searches → search → write the answer.
// - Planner (fast model) decides what to search. Gemini can't search by itself;
//   it asks for web_search and our code runs it (Exa, Tavily backup).
// - Writer (smart model) gets the question + numbered results and writes the answer.
//   If the writer is out of quota, a backup writer (fast model) takes over.
import { GoogleGenAI, FunctionCallingConfigMode, type Content, type Part, type Tool } from "@google/genai";
import type { SearchResult, WebSearch } from "./search.js";

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

// What answer() sends out, in order: search… → text… → sources → done.
export interface Source { n: number; title: string; url: string; publishedDate?: string }
export type AgentEvent =
  | { type: "search"; query: string }
  | { type: "search_failed"; query: string; error: string }
  | { type: "text"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done" };

// The "plug" shape both the real and the fake Gemini follow:
// one model turn, streamed as batches of raw parts.
export interface TurnInput { system: string; contents: Content[]; tools: boolean }
export interface ChatModel { name: string; stream(input: TurnInput): AsyncIterable<Part[]> }

export function createGeminiModel(apiKey: string, model: string): ChatModel {
  const ai = new GoogleGenAI({ apiKey });
  return {
    name: model,
    async *stream({ system, contents, tools }) {
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: system,
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
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|quota/i.test(msg);
}

// Uses `primary`; if it fails with quota/busy before sending anything, uses `backup`.
export function withFallback(
  primary: ChatModel,
  backup: ChatModel,
  onFallback: (info: { from: string; to: string; reason: string }) => void = () => {},
): ChatModel {
  return {
    name: primary.name,
    async *stream(input) {
      let sentAnything = false;
      try {
        for await (const parts of primary.stream(input)) {
          sentAnything = true;
          yield parts;
        }
        return;
      } catch (err) {
        if (sentAnything || !isQuotaOrBusy(err)) throw err;
        onFallback({ from: primary.name, to: backup.name, reason: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      }
      yield* backup.stream(input);
    },
  };
}

export interface AnswerInput {
  planner: ChatModel; // fast: decides searches
  writer: ChatModel; // smart: writes the answer
  search: WebSearch;
  plannerSystem: string;
  writerSystem: string;
  question: string;
  history?: Content[]; // earlier turns of this chat (plain text)
}

export async function* answer(input: AnswerInput): AsyncGenerator<AgentEvent> {
  const { planner, writer, search, plannerSystem, writerSystem, question, history = [] } = input;
  const sources = new Map<string, Source>(); // url → numbered source, so each link gets one number
  const found: Array<{ query: string; results?: ReturnType<typeof numbered>[]; error?: string }> = [];

  // 1) Planning: the planner asks for searches, up to MAX_SEARCH_ROUNDS rounds.
  const planContents: Content[] = [...history, { role: "user", parts: [{ text: question }] }];
  for (let round = 0; round < MAX_SEARCH_ROUNDS; round++) {
    const modelParts: Part[] = [];
    for await (const parts of planner.stream({ system: plannerSystem, contents: planContents, tools: true })) {
      modelParts.push(...parts); // planner text is a draft, never shown
    }
    // Keep the planner's own message exactly as given (it carries hidden thought signatures).
    planContents.push({ role: "model", parts: modelParts });

    const calls = modelParts.filter((p) => p.functionCall?.name === "web_search").map((p) => p.functionCall!);
    if (calls.length === 0) break;

    const queries = calls.map((c) => String(c.args?.query ?? "").trim());
    for (const query of queries) yield { type: "search", query };

    // All searches of a round run at the same time.
    const outcomes = await Promise.allSettled(queries.map((q) => search(q)));

    const responses: Part[] = [];
    for (let i = 0; i < calls.length; i++) {
      const outcome = outcomes[i];
      let response: Record<string, unknown>;
      if (outcome.status === "fulfilled") {
        const results = outcome.value.results.map((r) => numbered(sources, r));
        found.push({ query: queries[i], results });
        response = { results };
      } else {
        const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        found.push({ query: queries[i], error });
        yield { type: "search_failed", query: queries[i], error };
        response = { error: `search failed: ${error}` };
      }
      responses.push({ functionResponse: { id: calls[i].id, name: "web_search", response } });
    }
    planContents.push({ role: "user", parts: responses });
  }

  // 2) Writing: the writer gets the question plus results as plain numbered text
  //    (another model's tool messages and thought signatures can't be passed across models).
  const writeContents: Content[] = [...history, { role: "user", parts: [{ text: withResults(question, found) }] }];
  let fullText = "";
  for await (const parts of writer.stream({ system: writerSystem, contents: writeContents, tools: false })) {
    for (const part of parts) {
      if (part.text && !part.thought) {
        fullText += part.text;
        yield { type: "text", text: part.text };
      }
    }
  }

  yield { type: "sources", sources: citedSources(fullText, [...sources.values()]) };
  yield { type: "done" };
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
export function withResults(question: string, found: Array<{ query: string; results?: ReturnType<typeof numbered>[]; error?: string }>): string {
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
