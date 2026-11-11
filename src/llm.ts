// Talking to Gemini: the "ask, search, answer" loop.
// Gemini can't search by itself; it asks for web_search, our code runs it
// (Exa, Tavily backup) and hands the results back, then Gemini writes the answer.
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
export interface TurnInput { system: string; contents: Content[]; allowSearch: boolean }
export interface ChatModel { stream(input: TurnInput): AsyncIterable<Part[]> }

export function createGeminiModel(apiKey: string, model: string): ChatModel {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async *stream({ system, contents, allowSearch }) {
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: system,
          tools: [WEB_SEARCH_TOOL],
          // Last round: tool stays declared (history has calls) but Gemini must answer.
          toolConfig: { functionCallingConfig: { mode: allowSearch ? FunctionCallingConfigMode.AUTO : FunctionCallingConfigMode.NONE } },
        },
      });
      for await (const chunk of stream) {
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts?.length) yield parts;
      }
    },
  };
}

export interface AnswerInput {
  model: ChatModel;
  search: WebSearch;
  system: string;
  question: string;
  history?: Content[]; // earlier turns of this chat
}

export async function* answer({ model, search, system, question, history = [] }: AnswerInput): AsyncGenerator<AgentEvent> {
  const contents: Content[] = [...history, { role: "user", parts: [{ text: question }] }];
  const sources = new Map<string, Source>(); // url → numbered source, so each link gets one number
  let fullText = "";

  for (let round = 0; round <= MAX_SEARCH_ROUNDS; round++) {
    const allowSearch = round < MAX_SEARCH_ROUNDS;
    const modelParts: Part[] = [];

    for await (const parts of model.stream({ system, contents, allowSearch })) {
      for (const part of parts) {
        modelParts.push(part);
        if (part.text && !part.thought) {
          fullText += part.text;
          yield { type: "text", text: part.text };
        }
      }
    }

    // Keep Gemini's own message exactly as given (it carries hidden thought signatures).
    contents.push({ role: "model", parts: modelParts });

    const calls = modelParts.filter((p) => p.functionCall?.name === "web_search").map((p) => p.functionCall!);
    if (calls.length === 0 || !allowSearch) break;

    const queries = calls.map((c) => String(c.args?.query ?? "").trim());
    for (const query of queries) yield { type: "search", query };

    // All searches of a round run at the same time.
    const outcomes = await Promise.allSettled(queries.map((q) => search(q)));

    const responses: Part[] = [];
    for (let i = 0; i < calls.length; i++) {
      const outcome = outcomes[i];
      let response: Record<string, unknown>;
      if (outcome.status === "fulfilled") {
        response = { results: outcome.value.results.map((r) => numbered(sources, r)) };
      } else {
        const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        yield { type: "search_failed", query: queries[i], error };
        response = { error: `search failed: ${error}` };
      }
      responses.push({ functionResponse: { id: calls[i].id, name: "web_search", response } });
    }
    contents.push({ role: "user", parts: responses });
  }

  yield { type: "sources", sources: citedSources(fullText, [...sources.values()]) };
  yield { type: "done" };
}

// Gives each result a number [n] (same link → same number) and returns what Gemini sees.
function numbered(sources: Map<string, Source>, r: SearchResult) {
  let source = sources.get(r.url);
  if (!source) {
    source = { n: sources.size + 1, title: r.title, url: r.url, ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}) };
    sources.set(r.url, source);
  }
  return { n: source.n, title: r.title, url: r.url, publishedDate: r.publishedDate, content: r.content };
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
// streamed batches of parts. Records every input it got.
export function createFakeModel(script: Part[][][]) {
  const inputs: TurnInput[] = [];
  let turn = 0;
  const model: ChatModel = {
    async *stream(input) {
      inputs.push(structuredClone(input));
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
