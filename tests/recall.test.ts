import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.js";
import { isMemoryQuestion, recall, thingsInQuestion, topicWords } from "../src/recall.js";

// Today: Thursday 12 Nov 2026, 08:30 in India.
const now = new Date("2026-11-12T03:00:00.000Z");
const timezone = "Asia/Kolkata";

let db: Db;
let user: number;
const ids: Record<string, number> = {};

// One saved chat: question + answer at a time, things it talked about (with kinds) and facts said then.
function pastChat(key: string, at: string, question: string, answer: string, things: Array<{ name: string; type: string; facts?: Array<[string, string]> }> = [], userId = user) {
  const chat = db.createChat(userId, question);
  ids[key] = chat.id;
  db.addMessage(userId, chat.id, { role: "user", text: question, createdAt: at, timezone });
  const reply = db.addMessage(userId, chat.id, { role: "assistant", text: answer, createdAt: at, timezone });
  for (const t of things) {
    const thing = db.findThingsByName(userId, t.name)[0] ?? db.createThing(userId, { name: t.name, type: t.type });
    db.addMention(userId, { thingId: thing.id, chatId: chat.id, messageId: reply.id, createdAt: at });
    for (const [field, value] of t.facts ?? []) {
      db.addFact(userId, { thingId: thing.id, field, value, sourceUrl: `https://${t.name.toLowerCase()}.example/pricing`, chatId: chat.id, messageId: reply.id, checkedAt: at });
    }
  }
  return chat;
}

beforeEach(() => {
  db = new Db(":memory:");
  user = db.createUser("asha").id;
  // Tue 3 Nov, 14:05 India
  pastChat("postgres3", "2026-11-03T08:35:00.000Z", "What's the cheapest managed Postgres for a small startup?",
    "Neon Launch is $19/month [1]; Supabase Pro is $25/month [2].", [
      { name: "Neon", type: "Postgres hosting", facts: [["Launch plan price", "$19/month"]] },
      { name: "Supabase", type: "Postgres hosting", facts: [["Pro plan price", "$25/month"]] },
    ]);
  // Mon 9 Nov, 10:00 India
  pastChat("crm", "2026-11-09T04:30:00.000Z", "Shortlist CRM tools for a 20-person sales team",
    "Shortlist: HubSpot, Pipedrive, Salesforce, Zoho CRM and Close.", [
      { name: "HubSpot", type: "CRM", facts: [["Sales Hub Starter price", "$20/seat/month"]] },
      { name: "Pipedrive", type: "CRM" }, { name: "Salesforce", type: "CRM" }, { name: "Zoho CRM", type: "CRM" }, { name: "Close", type: "sales CRM" },
    ]);
  // Tue 10 Nov, 11:00 and 16:00 India
  pastChat("nextjs", "2026-11-10T05:30:00.000Z", "What's new in Next.js 16?", "Next.js 16 adds …", [{ name: "Next.js", type: "web framework" }]);
  pastChat("postgres10", "2026-11-10T10:30:00.000Z", "Which Postgres hosts support branching?", "Neon supports branching [1].", [{ name: "Neon", type: "Postgres hosting" }]);
});
afterEach(() => db.close());

const ask = (q: string, extra: { beforeMessageId?: number; userId?: number } = {}) =>
  recall(db, extra.userId ?? user, q, { now, timezone, beforeMessageId: extra.beforeMessageId });

describe("is it a memory question?", () => {
  it("yes for date words and memory phrases", () => {
    for (const q of [
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?",
      "What did I ask you on 3 November? Is your answer still correct today?",
      "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
      "What did you recommend earlier?",
    ]) expect(isMemoryQuestion(q, now, timezone)).toBe(true);
  });

  it("no for normal questions", () => {
    for (const q of ["What does Neon cost?", "Compare HubSpot and Pipedrive pricing", "thanks!"]) {
      expect(isMemoryQuestion(q, now, timezone)).toBe(false);
      expect(ask(q)).toBeUndefined();
    }
  });
});

describe("topic", () => {
  it("keeps the topic words and drops memory, date and filler words", () => {
    expect(topicWords("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?")).toEqual(["postgres", "hosting", "pricing"]);
    expect(topicWords("What did I ask you on 3 November? Is your answer still correct today?")).toEqual([]);
  });

  it("finds remembered things by name or by kind", () => {
    expect(thingsInQuestion(db, user, "I asked about Postgres hosting").map((t) => t.name)).toEqual(["Neon", "Supabase"]);
    expect(thingsInQuestion(db, user, "we shortlisted 5 CRM tools").map((t) => t.name).sort()).toEqual(["Close", "HubSpot", "Pipedrive", "Salesforce", "Zoho CRM"]);
    expect(thingsInQuestion(db, user, "what about hubspot?").map((t) => t.name)).toEqual(["HubSpot"]);
  });
});

describe("your 3 example questions", () => {
  it("'On Monday we shortlisted 5 CRM tools…' → the Monday CRM chat, with all 5 things and the facts said then", () => {
    const r = ask("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?")!;
    expect(r.status).toBe("found");
    expect(r.range?.label).toBe("Mon 9 Nov");
    expect(r.chats.map((c) => c.chat.id)).toEqual([ids.crm]);
    expect(r.chats[0].things.map((t) => t.name)).toEqual(["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Close"]);
    expect(r.chats[0].facts).toEqual([expect.objectContaining({ thing: "HubSpot", field: "Sales Hub Starter price", value: "$20/seat/month", checkedAt: "2026-11-09T04:30:00.000Z" })]);
    expect(r.chats[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(r.chats[0].when).toBe("Mon 9 Nov, 10:00");
  });

  it("'What did I ask you on 3 November?' → that day's chat (no topic needed)", () => {
    const r = ask("What did I ask you on 3 November? Is your answer still correct today?")!;
    expect(r).toMatchObject({ status: "found", usedWeekEarlier: false });
    expect(r.chats.map((c) => c.chat.id)).toEqual([ids.postgres3]);
    expect(r.chats[0].messages[0].text).toBe("What's the cheapest managed Postgres for a small startup?");
  });

  it("'Last Tuesday I asked about Postgres hosting' → the Postgres chat on Tue 10 Nov, not the Next.js one", () => {
    const r = ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?")!;
    expect(r.range?.label).toBe("Tue 10 Nov");
    expect(r.chats.map((c) => c.chat.id)).toEqual([ids.postgres10]);
  });
});

describe("tricky cases", () => {
  it("nothing on the topic that Tuesday → looks one week earlier, and says so", () => {
    const r = ask("Last Tuesday I asked about Supabase pricing")!; // Supabase only came up on Tue 3 Nov
    expect(r).toMatchObject({ status: "found", usedWeekEarlier: true });
    expect(r.chats.map((c) => c.chat.id)).toEqual([ids.postgres3]);
    expect(r.reason).toBe("found 1 chat on Tue 3 Nov (a week earlier)");
  });

  it("nothing on the topic → 'none', with what was talked about that day instead", () => {
    const r = ask("Last Tuesday I asked about Kubernetes")!;
    expect(r.status).toBe("none");
    expect(r.otherChatsInRange.map((c) => c.id).sort()).toEqual([ids.nextjs, ids.postgres10].sort());
    expect(r.reason).toBe("no chat on Tue 10 Nov about kubernetes");
  });

  it("a day with no chats at all → 'none'", () => {
    const r = ask("What did I ask you yesterday?")!;
    expect(r).toMatchObject({ status: "none", otherChatsInRange: [] });
  });

  it("no date: finds the chats on the topic, most relevant first", () => {
    const r = ask("What did I ask you about Postgres before?")!;
    expect(r.status).toBe("found");
    expect(r.chats.map((c) => c.chat.id).sort()).toEqual([ids.postgres3, ids.postgres10].sort());
    expect(r.chats.map((c) => c.chat.id)).not.toContain(ids.nextjs);
  });

  it("the search index finds words in messages even without a memory card ('pricing' finds 'price')", () => {
    pastChat("plain", "2026-11-11T06:00:00.000Z", "How do Vercel prices work?", "Vercel Pro is $20 per member.");
    const r = ask("What did I ask about Vercel pricing yesterday?")!;
    expect(r.chats.map((c) => c.chat.id)).toEqual([ids.plain]);
  });

  it("does not count the question being answered right now", () => {
    const chat = db.createChat(user, "today");
    const current = db.addMessage(user, chat.id, { role: "user", text: "What did I ask you earlier today?", createdAt: "2026-11-12T02:59:00.000Z" });
    expect(ask("What did I ask you earlier today?", { beforeMessageId: current.id })!.status).toBe("none");
  });

  it("never finds another user's chats", () => {
    const bob = db.createUser("bob").id;
    const r = ask("What did I ask you on 3 November?", { userId: bob })!;
    expect(r).toMatchObject({ status: "none", chats: [], otherChatsInRange: [] });
    expect(thingsInQuestion(db, bob, "Postgres hosting")).toEqual([]);
  });
});

describe("search index", () => {
  it("is kept up to date as messages are saved, and odd words can't break the search", () => {
    expect(db.searchMessages(user, ["branching"]).map((m) => m.chatId)).toEqual([ids.postgres10, ids.postgres10]);
    expect(db.searchMessages(user, ['"quotes" can\'t break it'])).toEqual([]);
  });

  it("is filled for messages saved before it existed (a database from an earlier phase)", () => {
    const dir = mkdtempSync(join(tmpdir(), "minimi-fts-"));
    const path = join(dir, "old.db");
    try {
      const first = new Db(path);
      const u = first.createUser("old").id;
      const c = first.createChat(u, "old chat");
      first.addMessage(u, c.id, { role: "user", text: "Which Postgres hosts support branching?" });
      first.close();

      // Make it look like a database from before the search index (version 2).
      const raw = new DatabaseSync(path);
      raw.exec(`DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_delete; DROP TRIGGER messages_fts_update;
                DROP TABLE messages_fts; PRAGMA user_version = 2;`);
      raw.close();

      const reopened = new Db(path);
      expect(reopened.searchMessages(u, ["branching"]).map((m) => m.text)).toEqual(["Which Postgres hosts support branching?"]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
