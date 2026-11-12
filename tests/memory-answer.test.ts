// Step 3: memory questions get THEN (the old chat) and NOW (code-built searches for each remembered thing).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { createFakeModel, fake, type AgentEvent } from "../src/llm.js";
import { memoryBlock, memorySearches, recall, recallSummary } from "../src/recall.js";
import { createFakeSearch } from "../src/search.js";

// Today: Thursday 12 Nov 2026, 08:30 in India.
const NOW = new Date("2026-11-12T03:00:00.000Z");
const timezone = "Asia/Kolkata";

let db: Db;
let user: number;
const ids: Record<string, number> = {};

function pastChat(key: string, at: string, question: string, answer: string, things: Array<{ name: string; type: string; facts?: Array<[string, string]> }> = []) {
  const chat = db.createChat(user, question);
  ids[key] = chat.id;
  db.addMessage(user, chat.id, { role: "user", text: question, createdAt: at, timezone });
  const reply = db.addMessage(user, chat.id, { role: "assistant", text: answer, createdAt: at, timezone });
  for (const t of things) {
    const thing = db.findThingsByName(user, t.name)[0] ?? db.createThing(user, { name: t.name, type: t.type });
    db.addMention(user, { thingId: thing.id, chatId: chat.id, messageId: reply.id, createdAt: at });
    for (const [field, value] of t.facts ?? []) {
      db.addFact(user, { thingId: thing.id, field, value, sourceUrl: `https://${t.name.toLowerCase().replace(/\s/g, "")}.com/pricing`, chatId: chat.id, messageId: reply.id, checkedAt: at });
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = new Db(":memory:");
  user = db.createUser("asha").id;
  pastChat("postgres3", "2026-11-03T08:35:00.000Z", "What's the cheapest managed Postgres for a small startup?",
    "Neon Launch is $19/month [1]; Supabase Pro is $25/month [2].", [
      { name: "Neon", type: "Postgres hosting", facts: [["Launch plan price", "$19/month"]] },
      { name: "Supabase", type: "Postgres hosting", facts: [["Pro plan price", "$25/month"]] },
    ]);
  pastChat("crm", "2026-11-09T04:30:00.000Z", "Shortlist CRM tools for a 20-person sales team",
    "Shortlist: HubSpot, Pipedrive, Salesforce, Zoho CRM and Close.", [
      { name: "HubSpot", type: "CRM", facts: [["Sales Hub Starter price", "$20/seat/month"]] },
      { name: "Pipedrive", type: "CRM" }, { name: "Salesforce", type: "CRM" }, { name: "Zoho CRM", type: "CRM" }, { name: "Close", type: "sales CRM" },
    ]);
  pastChat("nextjs", "2026-11-10T05:30:00.000Z", "What's new in Next.js 16?", "Next.js 16 adds caching changes.", [{ name: "Next.js", type: "web framework" }]);
  pastChat("postgres10", "2026-11-10T10:30:00.000Z", "Which Postgres hosts support branching?", "Neon supports branching [1].", [{ name: "Neon", type: "Postgres hosting" }]);
});
afterEach(() => { db.close(); vi.useRealTimers(); });

const rec = (q: string) => recall(db, user, q, { now: NOW, timezone })!;

describe("memorySearches: one search per remembered thing", () => {
  it("CRM question: all 5 CRMs, for pricing AND news (the question asks both)", () => {
    expect(memorySearches(rec("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"), "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", 2026)).toEqual([
      "HubSpot pricing 2026", "Pipedrive pricing 2026", "Salesforce pricing 2026", "Zoho CRM pricing 2026", "Close pricing 2026",
      "HubSpot news announcements 2026", "Pipedrive news announcements 2026", "Salesforce news announcements 2026", "Zoho CRM news announcements 2026", "Close news announcements 2026",
    ]);
  });

  it("'still correct?' names no aspect: checks what the old facts were about (prices)", () => {
    const q = "What did I ask you on 3 November? Is your answer still correct today?";
    expect(memorySearches(rec(q), q, 2026)).toEqual(["Neon pricing 2026", "Supabase pricing 2026"]);
  });

  it("a question naming one remembered thing checks only that one", () => {
    const q = "Has HubSpot changed its pricing since we talked?";
    expect(memorySearches(rec(q), q, 2026)).toEqual(["HubSpot pricing 2026"]);
  });

  it("asked about something never discussed then → no searches", () => {
    const q = "Last Tuesday I asked about Kubernetes pricing";
    expect(memorySearches(rec(q), q, 2026)).toEqual([]);
  });

  it("old chat with no remembered things → search the old question itself", () => {
    pastChat("plain", "2026-11-11T06:00:00.000Z", "How do Vercel prices work?", "Vercel Pro is $20 per member.");
    const q = "What did I ask you yesterday? Still correct?";
    expect(memorySearches(rec(q), q, 2026)).toEqual(["How do Vercel prices work?"]);
  });
});

describe("memoryBlock: THEN, as data", () => {
  it("has the old chat, its date, the real messages and the facts saved then", () => {
    const block = memoryBlock(rec("On Monday we shortlisted 5 CRM tools. Any price changes?"), timezone);
    expect(block).toContain('Chat "Shortlist CRM tools for a 20-person sales team", Mon 9 Nov, 10:00:');
    expect(block).toContain("User asked: Shortlist CRM tools for a 20-person sales team");
    expect(block).toContain("You answered: Shortlist: HubSpot, Pipedrive, Salesforce, Zoho CRM and Close.");
    expect(block).toContain("- HubSpot · Sales Hub Starter price: $20/seat/month (checked Mon 9 Nov, https://hubspot.com/pricing)");
    expect(block).toContain("Things talked about: HubSpot, Pipedrive, Salesforce, Zoho CRM, Close");
  });

  it("removes the old answer's citation numbers (they pointed to old sources, not today's)", () => {
    const block = memoryBlock(rec("What did I ask you on 3 November?"), timezone);
    expect(block).toContain("You answered: Neon Launch is $19/month; Supabase Pro is $25/month.");
    expect(block).not.toMatch(/You answered:.*\[\d/);
  });

  it("says when the chat was found a week earlier, when the topic didn't match, and when nothing was found", () => {
    expect(memoryBlock(rec("Last Tuesday I asked about Supabase pricing"))).toContain("NOTE: nothing matched on Tue 10 Nov; these chats are from Tue 3 Nov (one week earlier).");
    expect(memoryBlock(rec("Last Tuesday I asked about Kubernetes"))).toContain("NOTE: no chat on Tue 10 Nov was about kubernetes. These are all the chats from that day.");
    expect(memoryBlock(rec("What did I ask you on 5 November?"))).toContain("NOT FOUND: no saved chat on Thu 5 Nov.");
  });

  it("the page summary says what was found", () => {
    expect(recallSummary(rec("What did I ask you on 3 November?"))).toEqual({
      found: true, label: "Tue 3 Nov", chats: [{ id: ids.postgres3, title: "What's the cheapest managed Postgres for a small startup?", when: "Tue 3 Nov, 14:05" }],
    });
    expect(recallSummary(rec("Last Tuesday I asked about Supabase pricing")).note).toBe("Nothing on Tue 10 Nov; found one a week earlier");
    expect(recallSummary(rec("What did I ask you on 5 November?"))).toEqual({ found: false, label: "Thu 5 Nov", chats: [], note: "No saved chat on Thu 5 Nov" });
  });
});

describe("the agent's memory path (fake AI and fake search)", () => {
  async function run(question: string) {
    const planner = createFakeModel([[[fake.search("planner should not be needed")]]], "lite");
    const writer = createFakeModel([[[fake.text("answer [1]")]]], "smart");
    const fakeSearch = createFakeSearch({ "HubSpot pricing 2026": [{ title: "HubSpot pricing", url: "https://hubspot.com/pricing", content: "Starter $20" }] });
    const chat = createAgent(loadConfig({ GEMINI_API_KEY: "test", EXA_API_KEY: "test" }), () => {}, db, { planner: planner.model, writer: writer.model, search: fakeSearch.search });
    const c = db.createChat(user, question);
    const asked = db.addMessage(user, c.id, { role: "user", text: question, timezone });
    const events: AgentEvent[] = [];
    for await (const e of chat({ question, timezone, userId: user, messageId: asked.id })) events.push(e);
    return { events, planner, writer, queries: fakeSearch.queries, writerText: writer.inputs[0]?.contents.at(-1)?.parts?.[0].text ?? "" };
  }

  it("CRM question: tells the page what it found, searches all 5 CRMs (no planner), gives the writer THEN + NOW", async () => {
    const r = await run("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?");
    expect(r.events[0]).toEqual({
      type: "recall", found: true, label: "Mon 9 Nov",
      chats: [{ id: ids.crm, title: "Shortlist CRM tools for a 20-person sales team", when: "Mon 9 Nov, 10:00" }],
    });
    expect(r.queries).toHaveLength(10);
    expect(r.queries).toContain("Close pricing 2026");
    expect(r.planner.inputs).toHaveLength(0);
    expect(r.writerText).toContain("--- Memory: earlier chats (THEN) ---");
    expect(r.writerText).toContain("Sales Hub Starter price: $20/seat/month");
    expect(r.writerText).toContain("--- Web search results (cite as [n]) ---");
  });

  it("nothing found: no web search, and the writer is told NOT FOUND", async () => {
    const r = await run("What did I ask you on 5 November? Is it still correct?");
    expect(r.events[0]).toMatchObject({ type: "recall", found: false });
    expect(r.queries).toEqual([]);
    expect(r.writerText).toContain("NOT FOUND: no saved chat on Thu 5 Nov.");
  });

  it("a normal question is not a memory question: no recall update, normal path", async () => {
    const r = await run("What does Neon cost?");
    expect(r.events.some((e) => e.type === "recall")).toBe(false);
    expect(r.writerText).not.toContain("Memory: earlier chats");
  });

  it("the question being answered is never treated as an old chat", async () => {
    const r = await run("What did I ask you earlier today?");
    expect(r.events[0]).toMatchObject({ type: "recall", found: false });
  });
});
