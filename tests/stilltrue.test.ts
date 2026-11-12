import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { createFakeModel, fake } from "../src/llm.js";
import { createFakeSearch } from "../src/search.js";
import { factMatchesQuestion, namedThings, oldFactsFor, stillTrueBlock } from "../src/stilltrue.js";

// Today: Thursday 12 Nov 2026, 08:30 in India.
const NOW = new Date("2026-11-12T03:00:00.000Z");
const timezone = "Asia/Kolkata";

let db: Db;
let user: number;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = new Db(":memory:");
  user = db.createUser("asha").id;
  const chat = db.createChat(user, "Postgres hosting");
  const neon = db.createThing(user, { name: "Neon", type: "Postgres hosting", aliases: ["Neon Postgres"] });
  const supa = db.createThing(user, { name: "Supabase", type: "Postgres hosting" });
  db.addMention(user, { thingId: neon.id, chatId: chat.id });
  db.addFact(user, { thingId: neon.id, field: "Launch plan price", value: "$19/month", chatId: chat.id, checkedAt: "2026-11-03T08:35:00.000Z" });
  db.addFact(user, { thingId: supa.id, field: "Pro plan price", value: "$25/month", chatId: chat.id, checkedAt: "2026-11-03T08:35:00.000Z" });
  db.addFact(user, { thingId: supa.id, field: "Free plan projects", value: "2", chatId: chat.id, checkedAt: "2026-11-12T02:00:00.000Z" }); // 1 hour ago
});
afterEach(() => { db.close(); vi.useRealTimers(); });

describe("which old facts are checked", () => {
  it("only things named in the question (by name or other name), not by kind", () => {
    expect(namedThings(db, user, "What does Neon cost?").map((t) => t.name)).toEqual(["Neon"]);
    expect(namedThings(db, user, "is neon postgres cheaper than supabase?").map((t) => t.name)).toEqual(["Neon", "Supabase"]);
    expect(namedThings(db, user, "cheapest Postgres hosting?")).toEqual([]); // a kind, not a name
  });

  it("only facts checked more than a day ago (fresh ones don't need a reminder)", () => {
    const facts = oldFactsFor(db, user, "Neon vs Supabase pricing", NOW);
    expect(facts.map((f) => `${f.thing}: ${f.value}`)).toEqual(["Neon: $19/month", "Supabase: $25/month"]);
  });

  it("the block for the writer: values with the day they were said", () => {
    expect(stillTrueBlock(oldFactsFor(db, user, "What does Neon cost?", NOW), timezone)).toBe(
      "--- Memory: facts you told this user before ---\n- Neon · Launch plan price: $19/month (said Tue 3 Nov)",
    );
    expect(stillTrueBlock([])).toBeUndefined();
  });

  it("only facts the question is about: a price only for price questions", () => {
    expect(factMatchesQuestion({ field: "Launch plan price", value: "$19/month" }, "What does Neon cost?")).toBe(true);
    expect(factMatchesQuestion({ field: "Launch plan price", value: "$19/month" }, "Is Neon any good?")).toBe(false);
    expect(factMatchesQuestion({ field: "CEO", value: "Yamini Rangan" }, "Who is HubSpot's CEO now?")).toBe(true);
    expect(factMatchesQuestion({ field: "CEO", value: "Yamini Rangan" }, "Is HubSpot any good?")).toBe(false);
    expect(oldFactsFor(db, user, "Is Neon any good for startups?", NOW)).toEqual([]);
  });

  it("never another user's facts", () => {
    const bob = db.createUser("bob").id;
    expect(oldFactsFor(db, bob, "What does Neon cost?", NOW)).toEqual([]);
  });
});

describe("in the agent's normal path", () => {
  async function run(question: string) {
    const writer = createFakeModel([[[fake.text("answer [1]")]]], "smart");
    const planner = createFakeModel([[[fake.text("NO_SEARCH")]]], "lite");
    const chat = createAgent(loadConfig({ GEMINI_API_KEY: "test", EXA_API_KEY: "test" }), () => {}, db, {
      planner: planner.model, writer: writer.model, search: createFakeSearch().search,
    });
    const c = db.createChat(user, question);
    const asked = db.addMessage(user, c.id, { role: "user", text: question });
    for await (const _ of chat({ question, timezone, userId: user, messageId: asked.id })) { /* drain */ }
    return writer.inputs[0].contents.at(-1)!.parts![0].text!;
  }

  it("a question naming Neon gives the writer the old Neon fact", async () => {
    expect(await run("What does Neon cost?")).toContain("- Neon · Launch plan price: $19/month (said Tue 3 Nov)");
  });

  it("nothing remembered about it → no block", async () => {
    expect(await run("What does Railway cost?")).not.toContain("facts you told this user before");
  });

  it("small talk → no block", async () => {
    expect(await run("thanks!")).not.toContain("facts you told this user before");
  });
});
