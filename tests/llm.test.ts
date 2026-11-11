import { describe, it, expect } from "vitest";
import { answer, createFakeModel, fake, withFallback, isQuotaOrBusy, MAX_SEARCH_ROUNDS, type AgentEvent, type ChatModel } from "../src/llm.js";
import { createFakeSearch, type WebSearch } from "../src/search.js";

async function collect(gen: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}
const textOf = (events: AgentEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
const typesOf = (events: AgentEvent[]) => events.map((e) => e.type);
const sourceNums = (events: AgentEvent[]) => (events.find((e) => e.type === "sources") as { sources: Array<{ n: number }> }).sources.map((s) => s.n);

const neon = { title: "Neon pricing", url: "https://neon.tech/pricing", content: "Launch $19/month" };
const supa = { title: "Supabase pricing", url: "https://supabase.com/pricing", content: "Pro $25/month" };

// Planner that asks for the given searches in round 1, then stops.
const plannerFor = (...queries: string[]) => createFakeModel([[queries.map((q) => fake.search(q))], [[fake.text("enough")]]], "lite");
const writerSays = (...chunks: string[]) => createFakeModel([[chunks.map((c) => fake.text(c))]], "smart");

function run(planner: ChatModel, writer: ChatModel, search: WebSearch, question = "q") {
  return collect(answer({ planner, writer, search, plannerSystem: "PLAN", writerSystem: "WRITE", question }));
}

describe("answer: plan → search → write", () => {
  it("no search needed: planner draft is hidden, writer answers", async () => {
    const planner = createFakeModel([[[fake.text("planner draft")]]], "lite");
    const writer = writerSays("Hello", " there");
    const { search, queries } = createFakeSearch();
    const events = await run(planner.model, writer.model, search, "hi");

    expect(textOf(events)).toBe("Hello there");
    expect(queries).toEqual([]);
    expect(typesOf(events)).toEqual(["text", "text", "sources", "done"]);
    expect(writer.inputs[0].contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]); // no results block
    expect(writer.inputs[0].tools).toBe(false);
    expect(planner.inputs[0].tools).toBe(true);
  });

  it("planner searches, writer gets numbered results as plain text and cites them", async () => {
    const planner = plannerFor("Neon pricing");
    const writer = writerSays("Neon Launch is $19/month [1].");
    const { search, queries } = createFakeSearch({ "Neon pricing": [neon] });
    const events = await run(planner.model, writer.model, search, "Neon price?");

    expect(queries).toEqual(["Neon pricing"]);
    expect(typesOf(events)).toEqual(["search", "text", "sources", "done"]);
    expect(events.at(-2)).toEqual({ type: "sources", sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" }] });

    const writerText = writer.inputs[0].contents.at(-1)!.parts![0].text!;
    expect(writerText).toContain("Neon price?");
    expect(writerText).toContain('Search "Neon pricing"');
    expect(writerText).toContain("[1] Neon pricing (https://neon.tech/pricing)\nLaunch $19/month");
    // Writer never sees tool messages from the planner.
    expect(writer.inputs[0].contents.flatMap((c) => c.parts ?? []).some((p) => p.functionCall || p.functionResponse)).toBe(false);
  });

  it("planner's round 2 gets its own message back untouched, then the results", async () => {
    const planner = plannerFor("Neon pricing");
    const { search } = createFakeSearch({ "Neon pricing": [neon] });
    await run(planner.model, writerSays("ok").model, search);

    const round2 = planner.inputs[1].contents;
    expect(round2.at(-2)).toEqual({ role: "model", parts: [fake.search("Neon pricing")] });
    expect(round2.at(-1)?.parts?.[0].functionResponse).toMatchObject({
      id: "Neon pricing", name: "web_search", response: { results: [{ n: 1, url: "https://neon.tech/pricing" }] },
    });
  });

  it("runs several searches of one round at the same time", async () => {
    let running = 0;
    let maxRunning = 0;
    const search: WebSearch = async (q) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { results: q.startsWith("Neon") ? [neon] : [supa], provider: "fake" };
    };
    const events = await run(plannerFor("Neon pricing", "Supabase pricing").model, writerSays("x").model, search);

    expect(maxRunning).toBe(2);
    expect(events.filter((e) => e.type === "search")).toHaveLength(2);
  });

  it(`stops planning after ${MAX_SEARCH_ROUNDS} search rounds; the writer still answers`, async () => {
    const planner = createFakeModel([[[fake.search("again")]]], "lite"); // asks every time
    const writer = writerSays("final");
    const { search, queries } = createFakeSearch();
    const events = await run(planner.model, writer.model, search);

    expect(queries).toHaveLength(MAX_SEARCH_ROUNDS);
    expect(planner.inputs).toHaveLength(MAX_SEARCH_ROUNDS);
    expect(textOf(events)).toBe("final");
  });

  it("tells both models when a search failed, so the answer is honest", async () => {
    const planner = plannerFor("Neon pricing");
    const writer = writerSays("I couldn't check current prices.");
    const search: WebSearch = async () => { throw new Error("Web search failed. Exa: free credits used up"); };
    const events = await run(planner.model, writer.model, search);

    expect(events).toContainEqual({ type: "search_failed", query: "Neon pricing", error: "Web search failed. Exa: free credits used up" });
    expect(planner.inputs[1].contents.at(-1)?.parts?.[0].functionResponse?.response).toEqual({
      error: "search failed: Web search failed. Exa: free credits used up",
    });
    expect(writer.inputs[0].contents.at(-1)!.parts![0].text).toContain('Search "Neon pricing": FAILED (Web search failed. Exa: free credits used up)');
  });

  it("gives the same link one number across searches", async () => {
    const writer = writerSays("done [1] [2]");
    const { search } = createFakeSearch({ a: [neon], b: [neon, supa] });
    const events = await run(plannerFor("a", "b").model, writer.model, search);

    const writerText = writer.inputs[0].contents.at(-1)!.parts![0].text!;
    expect(writerText.match(/\[1\] Neon pricing/g)).toHaveLength(2); // same number both times
    expect(writerText).toContain("[2] Supabase pricing");
    expect(sourceNums(events)).toEqual([1, 2]);
  });

  it("lists only cited sources ([2] or [n:2] style); all of them if none are cited", async () => {
    const { search } = createFakeSearch({ a: [neon, supa] });
    expect(sourceNums(await run(plannerFor("a").model, writerSays("Only Supabase [2].").model, search))).toEqual([2]);
    expect(sourceNums(await run(plannerFor("a").model, writerSays("Both [n:1, n:2].").model, search))).toEqual([1, 2]);
    expect(sourceNums(await run(plannerFor("a").model, writerSays("No citations.").model, search))).toEqual([1, 2]);
  });

  it("does not show the writer's hidden thinking", async () => {
    const writer = createFakeModel([[[{ text: "secret", thought: true }, fake.text("Answer")]]], "smart");
    const events = await run(createFakeModel([[[fake.text("x")]]]).model, writer.model, createFakeSearch().search);
    expect(textOf(events)).toBe("Answer");
  });

  it("passes earlier chat turns and each model's own system prompt", async () => {
    const planner = createFakeModel([[[fake.text("x")]]], "lite");
    const writer = writerSays("ok");
    const history = [{ role: "user", parts: [{ text: "earlier" }] }, { role: "model", parts: [{ text: "reply" }] }];
    await collect(answer({ planner: planner.model, writer: writer.model, search: createFakeSearch().search, plannerSystem: "PLAN", writerSystem: "WRITE", question: "now", history }));

    expect(planner.inputs[0].system).toBe("PLAN");
    expect(writer.inputs[0].system).toBe("WRITE");
    expect(planner.inputs[0].contents).toEqual([...history, { role: "user", parts: [{ text: "now" }] }]);
    expect(writer.inputs[0].contents).toEqual([...history, { role: "user", parts: [{ text: "now" }] }]);
  });
});

describe("writer fallback", () => {
  const quota = new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');

  it("uses the backup writer when the main one is out of quota", async () => {
    const main = createFakeModel([], "smart", quota);
    const backup = createFakeModel([[[fake.text("from backup")]]], "lite");
    const switched: Array<{ from: string; to: string }> = [];
    const writer = withFallback(main.model, backup.model, (i) => switched.push(i));

    const events = await run(createFakeModel([[[fake.text("x")]]]).model, writer, createFakeSearch().search);
    expect(textOf(events)).toBe("from backup");
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({ from: "smart", to: "lite" });
    expect(backup.inputs[0]).toEqual(main.inputs[0]); // backup got the same input
  });

  it("does not hide other errors", async () => {
    const writer = withFallback(createFakeModel([], "smart", new Error("bad request 400")).model, writerSays("x").model);
    await expect(run(createFakeModel([[[fake.text("x")]]]).model, writer, createFakeSearch().search)).rejects.toThrow("bad request 400");
  });

  it("does not switch after text was already sent", async () => {
    const half: ChatModel = {
      name: "smart",
      async *stream() { yield [fake.text("half ")]; throw quota; },
    };
    const writer = withFallback(half, writerSays("backup").model);
    await expect(run(createFakeModel([[[fake.text("x")]]]).model, writer, createFakeSearch().search)).rejects.toThrow("RESOURCE_EXHAUSTED");
  });

  it("recognises quota and busy errors", () => {
    expect(isQuotaOrBusy(quota)).toBe(true);
    expect(isQuotaOrBusy(new Error("503 UNAVAILABLE"))).toBe(true);
    expect(isQuotaOrBusy(new Error("400 INVALID_ARGUMENT"))).toBe(false);
  });
});
