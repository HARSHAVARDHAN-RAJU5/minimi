import { describe, it, expect } from "vitest";
import {
  answer, createFakeModel, fake, withFallback, isQuotaOrBusy, isDailyQuota, retryAfterMs, MAX_SEARCH_ROUNDS, NoteStripper,
  type AgentEvent, type ChatModel, type FallbackInfo, type Timings,
} from "../src/llm.js";
import { fallbackLine } from "../src/agent.js";
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

  it("planner's round 2 (only when round 1 found nothing) gets its own message back untouched, then the results", async () => {
    const planner = plannerFor("Neon pricing");
    const { search } = createFakeSearch({}); // nothing found → the planner gets a second look
    await run(planner.model, writerSays("ok").model, search);

    const round2 = planner.inputs[1].contents;
    expect(round2.at(-2)).toEqual({ role: "model", parts: [fake.search("Neon pricing")] });
    expect(round2.at(-1)?.parts?.[0].functionResponse).toMatchObject({
      id: "Neon pricing", name: "web_search", response: { results: [] },
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

describe("writer remembers a used-up daily quota", () => {
  const daily = new Error('{"error":{"code":429,"message":"Quota exceeded ... GenerateRequestsPerDayPerProjectPerModel-FreeTier ... Please retry in 2h0m0s.","status":"RESOURCE_EXHAUSTED"}}');

  it("skips the main writer until the reset time, then tries it again", async () => {
    let t = 0;
    let mainCalls = 0;
    const main: ChatModel = { name: "smart", async *stream() { mainCalls++; throw daily; } };
    const backup = createFakeModel([[[fake.text("ok")]]], "lite");
    const infos: FallbackInfo[] = [];
    const writer = withFallback(main, backup.model, (i) => infos.push(i), { now: () => t });
    const ask = () => run(createFakeModel([[[fake.text("x")]]]).model, writer, createFakeSearch().search);

    await ask(); // refused once → remembered
    t += 60 * 60 * 1000; // 1 hour later: still before the 2h reset
    await ask();
    expect(mainCalls).toBe(1);
    expect(infos.map((i) => [i.daily, i.skipped])).toEqual([[true, false], [true, true]]);

    t += 61 * 60 * 1000; // past the reset
    await ask();
    expect(mainCalls).toBe(2);
  });

  it("after a short limit or 'busy', rests the main writer for 5 minutes (not saved), then tries again", async () => {
    let t = 0;
    let mainCalls = 0;
    const saved: number[] = [];
    const main: ChatModel = { name: "smart", async *stream() { mainCalls++; throw new Error("503 UNAVAILABLE high demand"); } };
    const infos: FallbackInfo[] = [];
    const writer = withFallback(main, createFakeModel([[[fake.text("ok")]]], "lite").model, (i) => infos.push(i), {
      now: () => t, memory: { load: () => undefined, save: (u) => saved.push(u) },
    });
    const ask = () => run(createFakeModel([[[fake.text("x")]]]).model, writer, createFakeSearch().search);
    await ask();
    t += 4 * 60 * 1000;
    await ask();
    expect(mainCalls).toBe(1);
    expect(infos.map((i) => [i.daily, i.skipped])).toEqual([[false, false], [false, true]]);
    expect(saved).toEqual([]); // only a daily limit is saved across restarts
    t += 2 * 60 * 1000;
    await ask();
    expect(mainCalls).toBe(2);
  });

  it("reads Google's wait time", () => {
    expect(isDailyQuota(daily)).toBe(true);
    expect(retryAfterMs(daily)).toBe(2 * 60 * 60 * 1000);
    expect(retryAfterMs(new Error('"retryDelay":"77455s"'))).toBe(77455 * 1000);
    expect(retryAfterMs(new Error("Please retry in 20h10m27.19s."))).toBe(((20 * 60 + 10) * 60 + 27.19) * 1000);
    expect(retryAfterMs(new Error("no hint"))).toBe(60 * 60 * 1000);
  });

  it("writes a clear log line", () => {
    const until = new Date(2026, 10, 12, 13, 30);
    expect(fallbackLine({ from: "a", to: "b", reason: "", daily: true, skipped: false, until })).toMatch(/writer fallback a → b \(daily quota used up; skipping it until .*(13|0?1).*30/);
    expect(fallbackLine({ from: "a", to: "b", reason: "", daily: true, skipped: true, until })).toMatch(/writer: skipping a \(daily quota used up until .*(13|0?1).*30.*\) → b/);
    expect(fallbackLine({ from: "a", to: "b", reason: "503", daily: false, skipped: false, until })).toMatch(/^writer fallback a → b \(quota or busy; skipping it until /);
    expect(fallbackLine({ from: "a", to: "b", reason: "no reply in 8 s", daily: false, skipped: false, until })).toMatch(/^writer fallback a → b \(no reply in 8 s; skipping it until /);
    expect(fallbackLine({ from: "a", to: "b", reason: "", daily: false, skipped: true, until })).toMatch(/^writer: skipping a \(resting after busy until /);
  });
});

describe("speed options", () => {
  const ask = (planner: ChatModel, search: Parameters<typeof answer>[0]["search"], options: Parameters<typeof answer>[0]["options"], question = "Neon price?") => {
    const writer = createFakeModel([[[fake.text("answer [1]")]]], "smart");
    let timings: Timings | undefined;
    const events = collect(answer({ planner, writer: writer.model, search, plannerSystem: "p", writerSystem: "w", question, options, onTimings: (t) => { timings = t; } }));
    return { events, writer, timings: () => timings! };
  };

  it("earlySearch: searches the question while the planner thinks, and puts those results first", async () => {
    const order: string[] = [];
    const search: WebSearch = async (q) => { order.push(`start ${q}`); await new Promise((r) => setTimeout(r, 30)); order.push(`end ${q}`); return { results: [q === "Neon price?" ? neon : supa], provider: "fake" }; };
    const planner: ChatModel = { name: "lite", async *stream() { order.push("planner"); yield [fake.text("NO_SEARCH")]; } };
    const r = ask(planner, search, { earlySearch: true });
    const events = await r.events;

    expect(order.slice(0, 2)).toEqual(["start Neon price?", "planner"]); // search started before planning
    expect(events[0]).toEqual({ type: "search", query: "Neon price?" });
    expect(r.writer.inputs[0].contents.at(-1)!.parts![0].text).toContain('Search "Neon price?":\n[1] Neon pricing');
  });

  it("skipPlanner: never calls the planner", async () => {
    const planner = createFakeModel([[[fake.search("x")]]], "lite");
    const { search, queries } = createFakeSearch({ "Neon price?": [neon] });
    await ask(planner.model, search, { skipPlanner: true }).events;
    expect(planner.inputs).toHaveLength(0);
    expect(queries).toEqual(["Neon price?"]);
  });

  it("maxResults / maxChars: the writer gets fewer, shorter results", async () => {
    const long = { title: "Long", url: "https://long.example", content: "x".repeat(1000) };
    const { search } = createFakeSearch({ q: [long, neon, supa] });
    const r = ask(plannerFor("q").model, search, { maxResults: 2, maxChars: 100 });
    await r.events;
    const text = r.writer.inputs[0].contents.at(-1)!.parts![0].text!;
    expect(text).toContain("x".repeat(100));
    expect(text).not.toContain("x".repeat(101));
    expect(text).toContain("[2] Neon pricing");
    expect(text).not.toContain("Supabase");
  });

  it("an early search failure is reported, and the answer still comes", async () => {
    const search: WebSearch = async () => { throw new Error("Exa: free credits used up"); };
    const events = await ask(createFakeModel([[[fake.text("x")]]]).model, search, { skipPlanner: true }).events;
    expect(events).toContainEqual({ type: "search_failed", query: "Neon price?", error: "Exa: free credits used up" });
    expect(textOf(events)).toBe("answer [1]");
  });

  it("reports how long each part took", async () => {
    const { search } = createFakeSearch({ q: [neon] });
    const r = ask(plannerFor("q").model, search, {});
    await r.events;
    const t = r.timings();
    expect(t.planMs).toHaveLength(1); // round 1 asks, found results → no second round
    expect(t.searchMs).toHaveLength(1);
    expect(t.firstTextMs).toBeGreaterThanOrEqual(0);
    expect(t.totalMs).toBeGreaterThanOrEqual(t.firstTextMs!);
  });
});

describe("hidden note", () => {
  it("cuts the note out of the stream even when split across chunks, and sends it as a note event", async () => {
    const writer = createFakeModel([[[fake.text("Neon is $19 [1].\n<no")], [fake.text('te>{"things": ["Neon"], "topic"')], [fake.text(': "pricing"}</note>')]]], "smart");
    const { search } = createFakeSearch({ "Neon pricing": [neon] });
    const events = await collect(answer({
      planner: plannerFor("Neon pricing").model, writer: writer.model, search, plannerSystem: "p", writerSystem: "w", question: "q",
      options: { withNote: true },
    }));
    expect(textOf(events)).toBe("Neon is $19 [1].\n");
    expect(textOf(events)).not.toContain("<");
    expect(events).toContainEqual({ type: "note", note: { things: ["Neon"], topic: "pricing" } });
    expect(typesOf(events).slice(-3)).toEqual(["note", "sources", "done"]);
  });

  it("lets other '<' text through", async () => {
    const s = new NoteStripper();
    expect(s.push("a < b and <b>bold</b>") + s.end()).toBe("a < b and <b>bold</b>");
    const t = new NoteStripper();
    expect(t.push("ends with <no") + t.end()).toBe("ends with <no");
  });

  it("missing or broken note: builds a backup note from the searches", async () => {
    const writer = createFakeModel([[[fake.text("Answer. <note>{broken</note>")]]], "smart");
    const { search } = createFakeSearch({ "Supabase Pro pricing 2026": [supa] });
    const events = await collect(answer({
      planner: plannerFor("Supabase Pro pricing 2026").model, writer: writer.model, search, plannerSystem: "p", writerSystem: "w",
      question: "What does Supabase Pro cost?", options: { withNote: true },
    }));
    expect(textOf(events)).toBe("Answer. ");
    expect(events).toContainEqual({ type: "note", note: { things: ["Supabase Pro"], topic: "pricing" } });
  });
});

describe("searches built by code", () => {
  it("runs the given searches at once and never calls the planner", async () => {
    const planner = createFakeModel([[[fake.search("x")]]], "lite");
    const { search, queries } = createFakeSearch({ "HubSpot pricing 2026": [neon], "Pipedrive pricing 2026": [supa] });
    const events = await collect(answer({
      planner: planner.model, writer: writerSays("ok [1] [2]").model, search, plannerSystem: "p", writerSystem: "w", question: "q",
      options: { presetQueries: ["HubSpot pricing 2026", "Pipedrive pricing 2026"] },
    }));
    expect(planner.inputs).toHaveLength(0);
    expect(queries).toEqual(["HubSpot pricing 2026", "Pipedrive pricing 2026"]);
    expect(events.filter((e) => e.type === "search")).toHaveLength(2);
  });
});

describe("planner breaks", () => {
  it("searches the question as-is instead, and still answers", async () => {
    const broken = createFakeModel([], "lite", new Error("503 UNAVAILABLE high demand"));
    const { search, queries } = createFakeSearch({ "Neon price?": [neon] });
    const errors: unknown[] = [];
    const events = await collect(answer({
      planner: broken.model, writer: writerSays("Neon $19 [1].").model, search, plannerSystem: "p", writerSystem: "w",
      question: "Neon price?", onPlannerError: (e) => errors.push(e),
    }));
    expect(errors).toHaveLength(1);
    expect(queries).toEqual(["Neon price?"]);
    expect(textOf(events)).toBe("Neon $19 [1].");
  });
});

describe("planner speed fixes", () => {
  it("stops planning after one round when the searches found something", async () => {
    const planner = createFakeModel([[[fake.search("Neon pricing")]], [[fake.search("more")]]], "lite");
    const { search, queries } = createFakeSearch({ "Neon pricing": [neon] });
    await collect(answer({ planner: planner.model, writer: writerSays("ok [1]").model, search, plannerSystem: "p", writerSystem: "w", question: "q" }));
    expect(planner.inputs).toHaveLength(1);
    expect(queries).toEqual(["Neon pricing"]);
  });

  it("a planner that takes too long is dropped; the question is searched as-is instead", async () => {
    const slow: ChatModel = {
      name: "lite",
      async *stream() { await new Promise((r) => setTimeout(r, 300)); yield [fake.search("too late")]; },
    };
    const { search, queries } = createFakeSearch({ "Neon price?": [neon] });
    const errors: string[] = [];
    const start = Date.now();
    const events = await collect(answer({
      planner: slow, writer: writerSays("Neon $19 [1].").model, search, plannerSystem: "p", writerSystem: "w",
      question: "Neon price?", options: { plannerTimeoutMs: 50 }, onPlannerError: (e) => errors.push((e as Error).message),
    }));
    expect(Date.now() - start).toBeLessThan(250);
    expect(errors).toEqual(["planner took too long"]);
    expect(queries).toEqual(["Neon price?"]);
    expect(textOf(events)).toBe("Neon $19 [1].");
  });

  it("noSearch (small talk): no planner, no search, just the writer", async () => {
    const planner = createFakeModel([[[fake.search("x")]]], "lite");
    const { search, queries } = createFakeSearch();
    const events = await collect(answer({
      planner: planner.model, writer: writerSays("You're welcome!").model, search, plannerSystem: "p", writerSystem: "w",
      question: "thanks!", options: { noSearch: true },
    }));
    expect(planner.inputs).toHaveLength(0);
    expect(queries).toEqual([]);
    expect(textOf(events)).toBe("You're welcome!");
  });
});

describe("writer remembers the used-up quota across restarts", () => {
  const daily = new Error('429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel-FreeTier. Please retry in 1h0m0s.');

  it("saves the skip time, and a new writer (after restart) loads it and skips straight away", async () => {
    let saved: number | undefined;
    const memory = { load: () => saved, save: (until: number) => { saved = until; } };
    let mainCalls = 0;
    const main: ChatModel = { name: "smart", async *stream() { mainCalls++; throw daily; } };
    const backup = () => createFakeModel([[[fake.text("ok")]]], "lite").model;
    const ask = (writer: ChatModel) => run(createFakeModel([[[fake.text("x")]]]).model, writer, createFakeSearch().search);

    await ask(withFallback(main, backup(), () => {}, { now: () => 1000, memory }));
    expect(saved).toBe(1000 + 60 * 60 * 1000);

    const afterRestart = withFallback(main, backup(), () => {}, { now: () => 2000, memory });
    await ask(afterRestart);
    expect(mainCalls).toBe(1); // not tried again
  });
});

describe("writer: no reply in time", () => {
  it("switches to the backup when the main writer sends nothing within the limit, then rests it", async () => {
    let mainCalls = 0;
    const hanging: ChatModel = {
      name: "smart",
      async *stream() { mainCalls++; await new Promise((r) => setTimeout(r, 2000)); yield [fake.text("too late")]; },
    };
    const infos: FallbackInfo[] = [];
    const writer = withFallback(hanging, createFakeModel([[[fake.text("from backup")]]], "lite").model, (i) => infos.push(i), { firstChunkMs: 50 });
    const ask = () => run(createFakeModel([[[fake.text("x")]]]).model, writer, createFakeSearch().search);

    const start = Date.now();
    expect(textOf(await ask())).toBe("from backup");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(infos[0]).toMatchObject({ reason: "no reply in 0 s", daily: false, skipped: false });

    await ask(); // resting: not tried again
    expect(mainCalls).toBe(1);
  });

  it("a writer that starts in time is not cut off later", async () => {
    const slowButStarted: ChatModel = {
      name: "smart",
      async *stream() { yield [fake.text("first ")]; await new Promise((r) => setTimeout(r, 120)); yield [fake.text("second")]; },
    };
    const writer = withFallback(slowButStarted, writerSays("backup").model, () => {}, { firstChunkMs: 50 });
    expect(textOf(await run(createFakeModel([[[fake.text("x")]]]).model, writer, createFakeSearch().search))).toBe("first second");
  });
});
