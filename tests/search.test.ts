import { describe, it, expect } from "vitest";
import { createExa, createTavily, createWebSearch, webSearchFromConfig, createFakeSearch } from "../src/search.js";

// A fake internet: answers each address with a fixed status + body, and records requests.
function fakeFetch(replies: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const reply = replies[url];
    if (!reply) throw new Error(`no fake reply for ${url}`);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const EXA = "https://api.exa.ai/search";
const TAVILY = "https://api.tavily.com/search";

const exaOk = {
  status: 200,
  body: {
    results: [
      { title: "Neon pricing", url: "https://neon.tech/pricing", text: "Launch $19/month", publishedDate: "2026-11-01" },
      { title: null, url: "https://example.com/a", text: "no title", publishedDate: null },
      { title: "No link", text: "dropped" },
    ],
  },
};
const tavilyOk = {
  status: 200,
  body: { results: [{ title: "Supabase pricing", url: "https://supabase.com/pricing", content: "Pro $25/month", published_date: null }] },
};

describe("exa", () => {
  it("sends the query with the key and returns clean results", async () => {
    const net = fakeFetch({ [EXA]: exaOk });
    const results = await createExa("exa-key", net.fn)("neon pricing");

    const { init } = net.calls[0];
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("exa-key");
    expect(JSON.parse(init?.body as string)).toMatchObject({ query: "neon pricing", type: "lite", numResults: 5 });
    expect(results).toEqual([
      { title: "Neon pricing", url: "https://neon.tech/pricing", content: "Launch $19/month", publishedDate: "2026-11-01" },
      { title: "https://example.com/a", url: "https://example.com/a", content: "no title" },
    ]);
  });

  it("explains a wrong key and used-up credits", async () => {
    await expect(createExa("k", fakeFetch({ [EXA]: { status: 401 } }).fn)("q")).rejects.toThrow("Exa: key is wrong");
    await expect(createExa("k", fakeFetch({ [EXA]: { status: 402 } }).fn)("q")).rejects.toThrow("Exa: free credits used up");
    await expect(createExa("k", fakeFetch({ [EXA]: { status: 429 } }).fn)("q")).rejects.toThrow("too many searches");
  });
});

describe("tavily", () => {
  it("returns results in the same shape as Exa", async () => {
    const net = fakeFetch({ [TAVILY]: tavilyOk });
    const results = await createTavily("tv-key", net.fn)("supabase pricing");

    expect((net.calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tv-key");
    expect(results).toEqual([{ title: "Supabase pricing", url: "https://supabase.com/pricing", content: "Pro $25/month" }]);
  });

  it("explains used-up credits", async () => {
    await expect(createTavily("k", fakeFetch({ [TAVILY]: { status: 432 } }).fn)("q")).rejects.toThrow("Tavily: free credits used up");
  });
});

describe("web search with backup", () => {
  it("uses Exa when it works", async () => {
    const net = fakeFetch({ [EXA]: exaOk, [TAVILY]: tavilyOk });
    const res = await webSearchFromConfig({ exaApiKey: "e", tavilyApiKey: "t" }, net.fn)("q");
    expect(res.provider).toBe("exa");
    expect(net.calls.map((c) => c.url)).toEqual([EXA]); // Tavily not called
  });

  it("switches to Tavily when Exa fails", async () => {
    const net = fakeFetch({ [EXA]: { status: 402 }, [TAVILY]: tavilyOk });
    const res = await webSearchFromConfig({ exaApiKey: "e", tavilyApiKey: "t" }, net.fn)("q");
    expect(res.provider).toBe("tavily");
    expect(res.results[0].url).toBe("https://supabase.com/pricing");
  });

  it("gives one clear error naming both reasons when both fail", async () => {
    const net = fakeFetch({ [EXA]: { status: 402 }, [TAVILY]: { status: 401 } });
    await expect(webSearchFromConfig({ exaApiKey: "e", tavilyApiKey: "t" }, net.fn)("q")).rejects.toThrow(
      "Web search failed. Exa: free credits used up; Tavily: key is wrong (check TAVILY_API_KEY)",
    );
  });

  it("goes straight to Tavily when there is no Exa key", async () => {
    const net = fakeFetch({ [TAVILY]: tavilyOk });
    const res = await webSearchFromConfig({ tavilyApiKey: "t" }, net.fn)("q");
    expect(res.provider).toBe("tavily");
    expect(net.calls.map((c) => c.url)).toEqual([TAVILY]);
  });

  it("fails clearly when no search key is set", () => {
    expect(() => webSearchFromConfig({})).toThrow("No web search key set");
    expect(() => createWebSearch([])).toThrow("Add EXA_API_KEY");
  });

  it("treats a network error (e.g. timeout) like a failure and uses the backup", async () => {
    const fn = (async (url: string) => {
      if (url === EXA) throw new Error("Exa: timed out");
      return new Response(JSON.stringify(tavilyOk.body), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await webSearchFromConfig({ exaApiKey: "e", tavilyApiKey: "t" }, fn)("q");
    expect(res.provider).toBe("tavily");
  });
});

describe("fake search", () => {
  it("returns fixed results and records queries", async () => {
    const fake = createFakeSearch({ q: [{ title: "t", url: "https://u", content: "c" }] });
    expect((await fake.search("q")).results).toHaveLength(1);
    expect((await fake.search("other")).results).toEqual([]);
    expect(fake.queries).toEqual(["q", "other"]);
  });
});
