// The tricky list (plan.md): end to end through the agent, with a fake AI and fake search.
// Same name for two things, same topic on two days, a changed price, a day with no chat,
// several chats on one day, and two users kept apart.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { saveCards } from "../src/extract.js";
import { createFakeModel, fake, type AgentEvent } from "../src/llm.js";
import { createFakeSearch } from "../src/search.js";

const NOW = new Date("2026-11-12T03:00:00.000Z"); // Thu 12 Nov 2026, 08:30 in India
const timezone = "Asia/Kolkata";
let db: Db;
let asha: number;

// A past chat saved the same way the app saves one (messages + memory cards).
function past(userId: number, at: string, question: string, answer: string, cards: Array<{ name: string; type: string; website?: string; facts?: Array<[string, string]> }>) {
  const chat = db.createChat(userId, question, { createdAt: at });
  db.addMessage(userId, chat.id, { role: "user", text: question, createdAt: at, timezone });
  const reply = db.addMessage(userId, chat.id, { role: "assistant", text: answer, createdAt: at, timezone });
  saveCards(db, userId, { chatId: chat.id, messageId: reply.id, at }, cards.map((c) => ({
    name: c.name, type: c.type, website: c.website, aliases: [],
    facts: (c.facts ?? []).map(([field, value]) => ({ field, value, sourceUrl: `https://${c.name.toLowerCase()}.example` })),
  })));
  return chat.id;
}

async function ask(userId: number, question: string) {
  const writer = createFakeModel([[[fake.text("ok")]]], "smart");
  const planner = createFakeModel([[[fake.text("NO_SEARCH")]]], "lite");
  const { search, queries } = createFakeSearch();
  const chat = createAgent(loadConfig({ GEMINI_API_KEY: "t", EXA_API_KEY: "t" }), () => {}, db, { planner: planner.model, writer: writer.model, search });
  const c = db.createChat(userId, question);
  const asked = db.addMessage(userId, c.id, { role: "user", text: question, timezone });
  const events: AgentEvent[] = [];
  for await (const e of chat({ question, timezone, userId, messageId: asked.id })) events.push(e);
  const recall = events.find((e) => e.type === "recall") as Extract<AgentEvent, { type: "recall" }> | undefined;
  return { recall, queries, writerText: writer.inputs[0]?.contents.at(-1)?.parts?.[0].text ?? "" };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = new Db(":memory:");
  asha = db.createUser("asha").id;
});
afterEach(() => { db.close(); vi.useRealTimers(); });

describe("tricky list", () => {
  it("same name, two different things (Apollo the sales tool vs Apollo the coding tool) stay apart", async () => {
    past(asha, "2026-11-09T04:30:00.000Z", "Is Apollo good for sales prospecting?", "Apollo.io is a sales tool.", [{ name: "Apollo", type: "sales tool", website: "apollo.io", facts: [["Basic plan price", "$49/month"]] }]);
    past(asha, "2026-11-10T05:30:00.000Z", "Is Apollo GraphQL free?", "Apollo GraphQL has a free tier.", [{ name: "Apollo", type: "GraphQL tool", website: "apollographql.com" }]);
    expect(db.findThingsByName(asha, "Apollo").map((t) => t.website)).toEqual(["apollo.io", "apollographql.com"]);

    // "On Monday… Apollo" finds Monday's (sales) chat and checks only that Apollo.
    const r = await ask(asha, "On Monday I asked about Apollo. Has the price changed?");
    expect(r.recall).toMatchObject({ found: true, label: "Mon 9 Nov" });
    expect(r.writerText).toContain("Basic plan price: $49/month");
    expect(r.writerText).not.toContain("GraphQL");
  });

  it("same topic on two days: the date decides which chat", async () => {
    past(asha, "2026-11-03T08:35:00.000Z", "Cheapest managed Postgres?", "Neon $19/month.", [{ name: "Neon", type: "Postgres hosting", facts: [["Launch price", "$19/month"]] }]);
    past(asha, "2026-11-10T10:30:00.000Z", "Postgres hosting with branching?", "Neon supports branching.", [{ name: "Neon", type: "Postgres hosting" }]);
    expect((await ask(asha, "What did I ask about Postgres on 3 November?")).recall?.chats.map((c) => c.title)).toEqual(["Cheapest managed Postgres?"]);
    expect((await ask(asha, "What did I ask about Postgres last Tuesday?")).recall?.chats.map((c) => c.title)).toEqual(["Postgres hosting with branching?"]);
  });

  it("a changed price: both values are kept; THEN shows the old one, the newest is what 'What I remember' shows", async () => {
    past(asha, "2026-11-03T08:35:00.000Z", "Neon pricing?", "Neon Launch is $19/month.", [{ name: "Neon", type: "Postgres hosting", facts: [["Launch price", "$19/month"]] }]);
    past(asha, "2026-11-10T10:30:00.000Z", "Neon pricing again?", "Neon Launch is usage-based.", [{ name: "Neon", type: "Postgres hosting", facts: [["Launch price", "usage-based"]] }]);
    const neon = db.findThingsByName(asha, "Neon")[0];
    expect(db.listFacts(asha, neon.id).map((f) => f.value)).toEqual(["$19/month", "usage-based"]);
    expect(db.latestFacts(asha, neon.id).map((f) => f.value)).toEqual(["usage-based"]);
    expect((await ask(asha, "What did I ask on 3 November? Is it still correct?")).writerText).toContain("Launch price: $19/month (checked Tue 3 Nov");
  });

  it("a day with no chat: says so, and does not search or guess", async () => {
    past(asha, "2026-11-09T04:30:00.000Z", "Shortlist CRMs", "HubSpot, Pipedrive.", [{ name: "HubSpot", type: "CRM" }]);
    const r = await ask(asha, "What did I ask you on 5 November?");
    expect(r.recall).toMatchObject({ found: false });
    expect(r.queries).toEqual([]);
    expect(r.writerText).toContain("NOT FOUND");
  });

  it("several chats on one day with no topic: all of them go to the writer (it can list or ask)", async () => {
    past(asha, "2026-11-10T05:30:00.000Z", "What's new in Next.js 16?", "Faster builds.", [{ name: "Next.js", type: "web framework" }]);
    past(asha, "2026-11-10T10:30:00.000Z", "Postgres hosting with branching?", "Neon.", [{ name: "Neon", type: "Postgres hosting" }]);
    const r = await ask(asha, "What did I ask you last Tuesday?");
    expect(r.recall?.chats.map((c) => c.title).sort()).toEqual(["Postgres hosting with branching?", "What's new in Next.js 16?"]);
    expect(r.writerText).toContain("What's new in Next.js 16?");
    expect(r.writerText).toContain("Postgres hosting with branching?");
  });

  it("two users: Bob never sees Asha's chats, memory, loops or decisions", async () => {
    past(asha, "2026-11-09T04:30:00.000Z", "Shortlist CRM tools for a 20-person sales team", "HubSpot, Pipedrive.", [
      { name: "HubSpot", type: "CRM", facts: [["Starter price", "$20/seat"]] }, { name: "Pipedrive", type: "CRM" },
    ]);
    const bob = db.createUser("bob").id;
    const r = await ask(bob, "On Monday we shortlisted 5 CRM tools. Has any changed pricing?");
    expect(r.recall).toMatchObject({ found: false });
    expect(r.writerText).not.toContain("HubSpot");
    expect(db.listThings(bob)).toEqual([]);
    expect(db.listLoops(bob, "all")).toEqual([]);
    expect(db.listDecisions(bob)).toEqual([]);
    const normal = await ask(bob, "What does HubSpot cost?"); // still-true check must not use Asha's facts
    expect(normal.writerText).not.toContain("facts you told this user before");
  });
});
