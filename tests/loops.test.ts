import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { Db, type Loop } from "../src/db.js";
import { choiceIn, opensLoop, updateLoops } from "../src/loops.js";

let db: Db;
let user: number;
beforeEach(() => { db = new Db(":memory:"); user = db.createUser("asha").id; });
afterEach(() => db.close());

const CRMS = ["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Close"];
const turn = (question: string, things: string[] = [], chatId = db.createChat(user, question).id) => updateLoops(db, user, { chatId, question, things });
const loop = (things: string[]): Loop => ({ id: 1, chatId: 1, text: "", things, status: "open", openedAt: "" });

describe("when does a loop open?", () => {
  it("comparing, shortlisting or choosing between 2+ things", () => {
    for (const q of [
      "Shortlist CRM tools for a 20-person sales team", "Compare Neon and Supabase pricing", "Neon vs Supabase?",
      "Which one should we use?", "Help me choose a Postgres host", "What's the cheapest managed Postgres?", "Recommend a CRM for us",
    ]) expect(opensLoop(q, ["A", "B"])).toBe(true);
  });

  it("not for plain questions, or with fewer than 2 things", () => {
    expect(opensLoop("What does Neon cost?", ["Neon", "Supabase"])).toBe(false);
    expect(opensLoop("Who is HubSpot's CEO?", ["HubSpot"])).toBe(false);
    expect(opensLoop("Compare HubSpot plans", ["HubSpot"])).toBe(false);
  });
});

describe("when does a loop close?", () => {
  it("the user says they picked one of the options", () => {
    for (const [q, choice] of [
      ["We picked HubSpot.", "HubSpot"], ["we went with pipedrive in the end", "Pipedrive"], ["I've decided on Zoho CRM", "Zoho CRM"],
      ["Let's go with Close", "Close"], ["We signed up for Salesforce today", "Salesforce"], ["ok we're going with hubspot. how do I import contacts?", "HubSpot"],
    ] as const) expect(choiceIn(q, loop(CRMS))).toBe(choice);
  });

  it("not when it's not a decision, or the pick isn't one of the options", () => {
    for (const q of [
      "Should we go with HubSpot?", "We didn't pick HubSpot", "If we go with HubSpot, what's the price?",
      "We picked Notion for docs", "What does HubSpot cost?",
    ]) expect(choiceIn(q, loop(CRMS))).toBeUndefined();
  });
});

describe("updateLoops", () => {
  it("opens a loop, then closes it in a later chat with the choice", () => {
    const opened = turn("Shortlist CRM tools for a 20-person sales team", CRMS).opened!;
    expect(opened).toMatchObject({ text: "Pick one: HubSpot, Pipedrive, Salesforce, Zoho CRM, Close", status: "open" });

    const later = db.createChat(user, "later").id;
    const result = turn("We went with Pipedrive. How do I set up pipelines?", [], later);
    expect(result.closed).toEqual([{ loop: expect.objectContaining({ id: opened.id }), choice: "Pipedrive" }]);
    expect(db.listLoops(user, "open")).toEqual([]);
    expect(db.getLoop(user, opened.id)).toMatchObject({ status: "closed", choice: "Pipedrive", closedInChatId: later });
  });

  it("asking about the same options again doesn't open a duplicate; new options extend it", () => {
    const first = turn("Compare Neon and Supabase pricing", ["Neon", "Supabase Pro"]).opened!;
    expect(first.things).toEqual(["Neon", "Supabase Pro"]);
    const again = turn("Neon vs Supabase vs Railway: which is cheapest?", ["Neon", "Supabase", "Railway"]);
    expect(again.opened).toBeUndefined();
    expect(again.updated?.things).toEqual(["Neon", "Supabase", "Railway"]); // shorter main name kept
    expect(db.listLoops(user)).toHaveLength(1);
  });

  it("unrelated choices get their own loops", () => {
    turn("Compare Neon and Supabase", ["Neon", "Supabase"]);
    turn("Shortlist CRM tools", CRMS);
    expect(db.listLoops(user).map((l) => l.things.length)).toEqual([5, 2]); // newest first
  });

  it("a decision about one loop leaves the others open", () => {
    turn("Compare Neon and Supabase", ["Neon", "Supabase"]);
    turn("Shortlist CRM tools", CRMS);
    turn("we picked HubSpot");
    expect(db.listLoops(user, "open").map((l) => l.things)).toEqual([["Neon", "Supabase"]]);
  });

  it("another user's loops are never touched", () => {
    turn("Shortlist CRM tools", CRMS);
    const bob = db.createUser("bob").id;
    const bobChat = db.createChat(bob, "b").id;
    expect(updateLoops(db, bob, { chatId: bobChat, question: "We picked HubSpot", things: [] }).closed).toEqual([]);
    expect(db.listLoops(user, "open")).toHaveLength(1);
    expect(db.listLoops(bob)).toEqual([]);
  });
});

describe("loop routes", () => {
  let server: Server;
  let url: string;
  beforeEach(async () => {
    server = createApp({ db }).listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));
  const as = (id: number) => ({ "Content-Type": "application/json", "X-User-Id": String(id) });

  it("lists your open loops with their chat, and Done closes one", async () => {
    const { opened } = turn("Shortlist CRM tools for a 20-person sales team", CRMS);
    const list = await (await fetch(`${url}/api/loops`, { headers: as(user) })).json();
    expect(list.loops).toEqual([{
      id: opened!.id, text: opened!.text, things: CRMS, openedAt: opened!.openedAt,
      chat: { id: opened!.chatId, title: "Shortlist CRM tools for a 20-person sales team" },
    }]);

    const bob = db.createUser("bob").id;
    expect((await fetch(`${url}/api/loops/${opened!.id}/close`, { method: "POST", headers: as(bob), body: "{}" })).status).toBe(404);
    expect((await fetch(`${url}/api/loops/${opened!.id}/close`, { method: "POST", headers: as(user), body: "{}" })).status).toBe(200);
    expect((await (await fetch(`${url}/api/loops`, { headers: as(user) })).json()).loops).toEqual([]);
    expect((await fetch(`${url}/api/loops`)).status).toBe(401);
  });
});
