import { describe, it, expect } from "vitest";
import { answer, createFakeModel, fake, MAX_SEARCH_ROUNDS, type AgentEvent } from "../src/llm.js";
import { createFakeSearch, type WebSearch } from "../src/search.js";

async function collect(gen: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}
const textOf = (events: AgentEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
const typesOf = (events: AgentEvent[]) => events.map((e) => e.type);

const neon = { title: "Neon pricing", url: "https://neon.tech/pricing", content: "Launch $19/month" };
const supa = { title: "Supabase pricing", url: "https://supabase.com/pricing", content: "Pro $25/month" };

describe("answer loop", () => {
  it("streams straight out when no search is needed", async () => {
    const { model } = createFakeModel([[[fake.text("Hello")], [fake.text(" there")]]]);
    const { search, queries } = createFakeSearch();
    const events = await collect(answer({ model, search, system: "s", question: "hi" }));

    expect(textOf(events)).toBe("Hello there");
    expect(queries).toEqual([]);
    expect(typesOf(events)).toEqual(["text", "text", "sources", "done"]);
  });

  it("runs a search, hands results back, then answers with sources", async () => {
    const { model, inputs } = createFakeModel([
      [[fake.search("Neon pricing")]],
      [[fake.text("Neon Launch is $19/month [1].")]],
    ]);
    const { search, queries } = createFakeSearch({ "Neon pricing": [neon] });
    const events = await collect(answer({ model, search, system: "s", question: "Neon price?" }));

    expect(queries).toEqual(["Neon pricing"]);
    expect(typesOf(events)).toEqual(["search", "text", "sources", "done"]);
    expect(events.at(-2)).toEqual({ type: "sources", sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" }] });

    // Round 2 got Gemini's own message back untouched, then the numbered results.
    const round2 = inputs[1].contents;
    expect(round2.at(-2)).toEqual({ role: "model", parts: [fake.search("Neon pricing")] });
    expect(round2.at(-1)?.parts?.[0].functionResponse).toMatchObject({
      id: "Neon pricing", name: "web_search", response: { results: [{ n: 1, url: "https://neon.tech/pricing", content: "Launch $19/month" }] },
    });
  });

  it("runs several searches of one round at the same time", async () => {
    const { model } = createFakeModel([
      [[fake.search("Neon pricing"), fake.search("Supabase pricing")]],
      [[fake.text("Neon $19 [1], Supabase $25 [2].")]],
    ]);
    let running = 0;
    let maxRunning = 0;
    const search: WebSearch = async (q) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { results: q.startsWith("Neon") ? [neon] : [supa], provider: "fake" };
    };
    const events = await collect(answer({ model, search, system: "s", question: "compare" }));

    expect(maxRunning).toBe(2);
    expect(events.filter((e) => e.type === "search")).toHaveLength(2);
  });

  it(`stops after ${MAX_SEARCH_ROUNDS} search rounds and still answers`, async () => {
    // Keeps asking for searches every turn.
    const { model, inputs } = createFakeModel([[[fake.search("again"), fake.text("partial answer")]]]);
    const { search, queries } = createFakeSearch();
    const events = await collect(answer({ model, search, system: "s", question: "q" }));

    expect(queries).toHaveLength(MAX_SEARCH_ROUNDS);
    expect(inputs).toHaveLength(MAX_SEARCH_ROUNDS + 1);
    expect(inputs.at(-1)?.allowSearch).toBe(false); // last round: answer, no more searching
    expect(inputs.slice(0, -1).every((i) => i.allowSearch)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("tells Gemini when a search failed, so it can answer honestly", async () => {
    const { model, inputs } = createFakeModel([
      [[fake.search("Neon pricing")]],
      [[fake.text("I couldn't check current prices.")]],
    ]);
    const search: WebSearch = async () => { throw new Error("Web search failed. Exa: free credits used up"); };
    const events = await collect(answer({ model, search, system: "s", question: "q" }));

    expect(events).toContainEqual({ type: "search_failed", query: "Neon pricing", error: "Web search failed. Exa: free credits used up" });
    expect(inputs[1].contents.at(-1)?.parts?.[0].functionResponse?.response).toEqual({
      error: "search failed: Web search failed. Exa: free credits used up",
    });
    expect(textOf(events)).toBe("I couldn't check current prices.");
  });

  it("gives the same link one number across searches", async () => {
    const { model, inputs } = createFakeModel([
      [[fake.search("a"), fake.search("b")]],
      [[fake.text("done [1] [2]")]],
    ]);
    const { search } = createFakeSearch({ a: [neon], b: [neon, supa] });
    const events = await collect(answer({ model, search, system: "s", question: "q" }));

    const parts = inputs[1].contents.at(-1)!.parts!;
    const nums = parts.map((p) => (p.functionResponse!.response as { results: Array<{ n: number }> }).results.map((r) => r.n));
    expect(nums).toEqual([[1], [1, 2]]);
    const sources = events.find((e) => e.type === "sources") as { sources: Array<{ n: number }> };
    expect(sources.sources.map((s) => s.n)).toEqual([1, 2]);
  });

  it("lists only cited sources; all of them if none are cited", async () => {
    const cites = createFakeModel([[[fake.search("a")]], [[fake.text("Only Supabase [2].")]]]);
    const s1 = createFakeSearch({ a: [neon, supa] });
    const e1 = await collect(answer({ model: cites.model, search: s1.search, system: "s", question: "q" }));
    expect((e1.find((e) => e.type === "sources") as { sources: Array<{ n: number }> }).sources.map((s) => s.n)).toEqual([2]);

    const nStyle = createFakeModel([[[fake.search("a")]], [[fake.text("Neon [n:1, n:2].")]]]);
    const s3 = createFakeSearch({ a: [neon, supa] });
    const e3 = await collect(answer({ model: nStyle.model, search: s3.search, system: "s", question: "q" }));
    expect((e3.find((e) => e.type === "sources") as { sources: Array<{ n: number }> }).sources.map((s) => s.n)).toEqual([1, 2]);

    const noCites = createFakeModel([[[fake.search("a")]], [[fake.text("No citations here.")]]]);
    const s2 = createFakeSearch({ a: [neon, supa] });
    const e2 = await collect(answer({ model: noCites.model, search: s2.search, system: "s", question: "q" }));
    expect((e2.find((e) => e.type === "sources") as { sources: Array<{ n: number }> }).sources.map((s) => s.n)).toEqual([1, 2]);
  });

  it("does not show hidden thinking as answer text", async () => {
    const { model } = createFakeModel([[[{ text: "secret thoughts", thought: true }, fake.text("Answer")]]]);
    const events = await collect(answer({ model, search: createFakeSearch().search, system: "s", question: "q" }));
    expect(textOf(events)).toBe("Answer");
  });

  it("passes earlier chat turns and the system prompt to Gemini", async () => {
    const { model, inputs } = createFakeModel([[[fake.text("ok")]]]);
    const history = [{ role: "user", parts: [{ text: "earlier" }] }, { role: "model", parts: [{ text: "reply" }] }];
    await collect(answer({ model, search: createFakeSearch().search, system: "SYSTEM", question: "now", history }));
    expect(inputs[0].system).toBe("SYSTEM");
    expect(inputs[0].contents).toEqual([...history, { role: "user", parts: [{ text: "now" }] }]);
  });
});
