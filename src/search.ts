// Web search: the agent's only tool. Exa is the main search, Tavily the backup.
// Both are turned into the same simple result shape, so the rest of the agent
// never cares which one ran.

export interface SearchResult {
  title: string;
  url: string;
  content: string; // short text from the page
  publishedDate?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  provider: string; // which search answered: "exa", "tavily", "fake"
}

export type Provider = (query: string) => Promise<SearchResult[]>;
export type WebSearch = (query: string) => Promise<SearchResponse>;

const MAX_RESULTS = 5;
const MAX_CHARS = 1500; // enough page text for prices and facts, not whole pages
const TIMEOUT_MS = 10_000;

// Turns an HTTP error into a short, clear reason.
function httpError(name: string, status: number, reasons: Record<number, string>): Error {
  const reason = reasons[status] ?? (status === 429 ? "too many searches, slow down" : `HTTP ${status}`);
  return new Error(`${name}: ${reason}`);
}

// fetchFn is swappable so tests can run without the internet.
export function createExa(apiKey: string, fetchFn: typeof fetch = fetch): Provider {
  return async (query) => {
    const res = await fetchFn("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        query,
        type: "lite", // fastest type
        numResults: MAX_RESULTS,
        contents: { text: { maxCharacters: MAX_CHARS } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw httpError("Exa", res.status, { 401: "key is wrong (check EXA_API_KEY)", 402: "free credits used up" });
    const data = (await res.json()) as {
      results?: Array<{ title?: string | null; url?: string; text?: string; publishedDate?: string | null }>;
    };
    return clean((data.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.text, date: r.publishedDate })));
  };
}

export function createTavily(apiKey: string, fetchFn: typeof fetch = fetch): Provider {
  return async (query) => {
    const res = await fetchFn("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, search_depth: "basic", max_results: MAX_RESULTS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw httpError("Tavily", res.status, { 401: "key is wrong (check TAVILY_API_KEY)", 432: "free credits used up" });
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string; published_date?: string | null }>;
    };
    return clean((data.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content, date: r.published_date })));
  };
}

// Same simple shape for every provider; drops results without a link.
function clean(
  raw: Array<{ title?: string | null; url?: string; content?: string; date?: string | null }>,
): SearchResult[] {
  return raw
    .filter((r): r is typeof r & { url: string } => Boolean(r.url))
    .map((r) => ({
      title: r.title || r.url,
      url: r.url,
      content: (r.content ?? "").slice(0, MAX_CHARS),
      ...(r.date ? { publishedDate: r.date } : {}),
    }));
}

// Tries each provider in order; the first one that works answers.
// If all fail, one error lists every reason.
export function createWebSearch(providers: Array<{ name: string; search: Provider }>): WebSearch {
  if (providers.length === 0) {
    throw new Error("No web search key set. Add EXA_API_KEY (or TAVILY_API_KEY) to .env.");
  }
  return async (query) => {
    const reasons: string[] = [];
    for (const { name, search } of providers) {
      try {
        return { results: await search(query), provider: name };
      } catch (err) {
        reasons.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new Error(`Web search failed. ${reasons.join("; ")}`);
  };
}

// Builds the real search from settings: Exa first, Tavily as backup (only those with keys).
export function webSearchFromConfig(
  config: { exaApiKey?: string; tavilyApiKey?: string },
  fetchFn: typeof fetch = fetch,
): WebSearch {
  const providers: Array<{ name: string; search: Provider }> = [];
  if (config.exaApiKey) providers.push({ name: "exa", search: createExa(config.exaApiKey, fetchFn) });
  if (config.tavilyApiKey) providers.push({ name: "tavily", search: createTavily(config.tavilyApiKey, fetchFn) });
  return createWebSearch(providers);
}

// Fake search for quick tests: fixed results, records what was searched.
export function createFakeSearch(results: Record<string, SearchResult[]> = {}) {
  const queries: string[] = [];
  const search: WebSearch = async (query) => {
    queries.push(query);
    return { results: results[query] ?? [], provider: "fake" };
  };
  return { search, queries };
}
