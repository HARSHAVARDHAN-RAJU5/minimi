// The hybrid: the listener (fake here) fills the form, code checks it and does the work.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { saveCards } from "../src/extract.js";
import { createFakeModel, fake, type AgentEvent, type ChatModel } from "../src/llm.js";
import { updateLoops } from "../src/loops.js";
import { createFakeSearch } from "../src/search.js";

const NOW = new Date("2026-11-12T03:00:00.000Z"); // Thu 12 Nov 2026, 08:30 in India
const timezone = "Asia/Kolkata";
let db: Db;
let user: number;

function past(at: string, question: string, answer: string, things: Array<[string, string, Array<[string, string]>?]> = []) {
  const chat = db.createChat(user, question, { createdAt: at });
  db.addMessage(user, chat.id, { role: "user", text: question, createdAt: at, timezone });
  const reply = db.addMessage(user, chat.id, { role: "assistant", text: answer, createdAt: at, timezone });
  saveCards(db, user, { chatId: chat.id, messageId: reply.id, at }, things.map(([name, type, facts]) => ({
    name, type, aliases: [], facts: (facts ?? []).map(([field, value]) => ({ field, value, sourceUrl: "https://example.com" })),
  })));
  updateLoops(db, user, { chatId: chat.id, question, things: things.map((t) => t[0]), at });
  return chat.id;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = new Db(":memory:");
  user = db.createUser("asha").id;
  past("2026-10-27T09:30:00.000Z", "Our tooling budget is $500/month for a 20-person team. What should we prioritise?", "Start with a CRM.");
  past("2026-11-05T04:00:00.000Z", "Does Linear's Business plan include SSO?", "Yes.", [["Linear", "issue tracker"]]);
  past("2026-11-09T04:30:00.000Z", "Shortlist CRM tools for a 20-person sales team", "HubSpot, Pipedrive.", [["HubSpot", "CRM", [["Starter price", "$20/seat"]]], ["Pipedrive", "CRM"]]);
  past("2026-11-10T10:30:00.000Z", "Compare Postgres hosting: Neon vs Supabase", "Neon $19, Supabase $25.", [["Neon", "Postgres hosting", [["Launch price", "$19/month"]]], ["Supabase", "Postgres hosting"]]);
  past("2026-11-11T06:30:00.000Z", "We went with Pipedrive because it's cheaper. How do I import contacts?", "Use the CSV importer.", [["Pipedrive", "CRM"]]);
});
afterEach(() => { db.close(); vi.useRealTimers(); });

// Runs one question with a fake listener that returns `form` (or a broken / missing reply).
async function run(question: string, form: object | string | undefined, history: Array<{ role: "user" | "assistant"; text: string }> = []) {
  const listener: ChatModel | undefined = form === undefined ? undefined
    : createFakeModel([[[fake.text(typeof form === "string" ? form : JSON.stringify(form))]]], "listener").model;
  const listenerInputs: unknown[] = [];
  const spy: ChatModel | undefined = listener && { name: "listener", stream: (input) => { listenerInputs.push(input); return listener.stream(input); } };
  const writer = createFakeModel([[[fake.text("ok")]]], "smart");
  const planner = createFakeModel([[[fake.text("NO_SEARCH")]]], "lite");
  const { search, queries } = createFakeSearch();
  const log: string[] = [];
  const chat = createAgent(loadConfig({ GEMINI_API_KEY: "t", EXA_API_KEY: "t" }), (l) => log.push(l), db, {
    planner: planner.model, writer: writer.model, search, ...(spy ? { listener: spy } : {}),
  });
  const c = db.createChat(user, question);
  const asked = db.addMessage(user, c.id, { role: "user", text: question, timezone });
  const events: AgentEvent[] = [];
  for await (const e of chat({ question, history, timezone, userId: user, messageId: asked.id })) events.push(e);
  return {
    queries, log, listenerCalls: listenerInputs.length,
    recall: events.find((e) => e.type === "recall") as Extract<AgentEvent, { type: "recall" }> | undefined,
    writerText: writer.inputs[0]?.contents.at(-1)?.parts?.[0].text ?? "",
  };
}

describe("follow-ups: the listener works out what 'it' / 'and X?' mean", () => {
  it("'what about auth?' after Supabase → searches Supabase auth (code alone dropped Supabase)", async () => {
    const r = await run("what about auth?", { type: "follow_up", products: ["Supabase"], searches: ["Supabase auth features 2026"] }, [
      { role: "user", text: "Does Supabase have vector search?" }, { role: "assistant", text: "Yes, pgvector." },
    ]);
    expect(r.queries).toEqual(["Supabase auth features 2026"]);
    expect(r.log.some((l) => l.startsWith("listener ("))).toBe(true);
  });

  it("the still-true check uses the products the listener worked out ('is it cheaper?' → Neon)", async () => {
    const r = await run("is it cheaper than it used to be?", { type: "follow_up", products: ["Neon"], searches: ["Neon pricing 2026"] });
    expect(r.writerText).toContain("Neon · Launch price: $19/month");
  });
});

describe("memory: the listener says what's looked for; code finds it", () => {
  it("'my last question' → the previous question and its answer, no web search", async () => {
    const r = await run("What was my last question?", { type: "memory", looking_for: "last_question" });
    expect(r.writerText).toContain("User asked: We went with Pipedrive because it's cheaper. How do I import contacts?");
    expect(r.queries).toEqual([]);
  });

  it("'which tool did we pick?' → the decision log", async () => {
    const r = await run("Which tool did we pick in the end?", { type: "memory", looking_for: "decision" });
    expect(r.writerText).toContain("Chose Pipedrive on Wed 11 Nov over HubSpot (because it's cheaper)");
    expect(r.recall).toMatchObject({ found: true, note: "Your decisions: Pipedrive" });
    expect(r.queries).toEqual([]);
  });

  it("'what was our budget?' → the user's own earlier message", async () => {
    const r = await run("What was our tooling budget again?", { type: "memory", looking_for: "user_fact", topic: "tooling budget" });
    expect(r.writerText).toContain("Our tooling budget is $500/month");
  });

  it("time words go to code, which turns them into days ('last Tuesday' → Tue 10 Nov)", async () => {
    const r = await run("Last Tuesday I asked about database hosting. Did prices change?", {
      type: "memory", looking_for: "topic", when: "last Tuesday", topic: "Postgres hosting",
    });
    expect(r.recall).toMatchObject({ found: true, label: "Tue 10 Nov" });
    expect(r.queries).toEqual(["Neon pricing 2026", "Supabase pricing 2026"]);
  });

  it("never discussed ('a Figma plan last Thursday') → honest 'not about it' instead of a false match", async () => {
    const r = await run("Did we decide on a Figma plan last Thursday?", {
      type: "memory", looking_for: "topic", when: "last Thursday", topic: "Figma plan", products: ["Figma"],
    });

    expect(r.writerText).toMatch(/NOT FOUND|no chat on Thu 5 Nov was about/);
    expect(r.queries).toEqual([]);
  });
});

describe("safety: the old way still works", () => {
  it("obvious questions skip the listener", async () => {
    const r = await run("What does Neon cost?", { type: "new", searches: ["should not be used"] });
    expect(r.listenerCalls).toBe(0);
    expect(r.queries).toEqual(["Neon cost 2026"]);
  });

  it("a broken form falls back to the old way", async () => {
    const r = await run("and supabase?", "not json at all", [{ role: "user", text: "What does Neon cost?" }, { role: "assistant", text: "$19" }]);
    expect(r.log).toContain("listener failed (form didn't pass the check) → old way");
    expect(r.log.some((l) => l.startsWith("path: code"))).toBe(true); // the old code rules ran instead
  });

  it("small talk → no search", async () => {
    const r = await run("cool, thank you so much for all of this!", { type: "small_talk" });
    expect(r.queries).toEqual([]);
  });
});
