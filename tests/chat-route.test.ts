import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { createAgent, toContents, type ChatFn, type ChatInput } from "../src/agent.js";
import { makeTitle, parseChatRequest, toTurns, type RememberFn, type RememberJob } from "../src/chats.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { answer, createFakeModel, fake, type AgentEvent } from "../src/llm.js";
import { createFakeSearch } from "../src/search.js";

let server: Server | undefined;
let db: Db | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  db?.close();
  server = undefined;
  db = undefined;
});

// Starts the app with a temporary database and one user; returns helpers bound to that user.
async function start(chat?: ChatFn, remember?: RememberFn) {
  db = new Db(":memory:");
  server = createApp({ chat, db, remember }).listen(0);
  await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  const url = `http://localhost:${(server!.address() as AddressInfo).port}`;
  const alice = db.createUser("alice");
  return { url, db, user: alice, ...as(url, alice.id) };
}

// Requests as a given user.
function as(url: string, userId: number) {
  const headers = { "Content-Type": "application/json", "X-User-Id": String(userId) };
  return {
    ask: (body: unknown, signal?: AbortSignal) => fetch(`${url}/api/chat`, { method: "POST", headers, body: JSON.stringify(body), signal }),
    get: (path: string) => fetch(`${url}${path}`, { headers }),
  };
}

// Reads an SSE response into a list of { event, data }.
async function readEvents(res: Response) {
  const raw = await res.text();
  return raw.split("\n\n").filter(Boolean).map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "{}");
    return { event, data };
  });
}

// A chat made of fakes: plans one search, writes an answer citing [1], adds a note.
function fakeChat(seen: ChatInput[] = []): ChatFn {
  return async function* (input) {
    seen.push(input);
    const planner = createFakeModel([[[fake.search("Neon pricing")]], [[fake.text("done")]]]);
    const writer = createFakeModel([[[fake.text('Neon is $19 [1].<note>{"things": ["Neon"], "topic": "pricing"}</note>')]]]);
    const { search } = createFakeSearch({ "Neon pricing": [{ title: "Neon pricing", url: "https://neon.tech/pricing", content: "$19" }] });
    yield* answer({
      planner: planner.model, writer: writer.model, search, plannerSystem: "p", writerSystem: "w",
      question: input.question, history: toContents(input.history), options: { withNote: true },
    });
  };
}

describe("/api/chat", () => {
  it("streams chat → search → text → note → sources → done", async () => {
    const { ask } = await start(fakeChat());
    const res = await ask({ question: "Neon price?" });

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await readEvents(res)).toEqual([
      { event: "chat", data: { id: 1, title: "Neon price?" } },
      { event: "search", data: { query: "Neon pricing" } },
      { event: "text", data: { text: "Neon is $19 [1]." } },
      { event: "note", data: { note: { things: ["Neon"], topic: "pricing" } } },
      { event: "sources", data: { sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" }] } },
      { event: "done", data: {} },
    ]);
  });

  it("saves the question and the answer with dates, sources, searches and time zone", async () => {
    const { ask, db, user } = await start(fakeChat());
    await (await ask({ question: "Neon price?", timezone: "Asia/Kolkata" })).text();

    const [q, a] = db.listMessages(user.id, 1);
    expect(q).toMatchObject({ role: "user", text: "Neon price?", timezone: "Asia/Kolkata", stopped: false });
    expect(a).toMatchObject({
      role: "assistant", text: "Neon is $19 [1].", searches: ["Neon pricing"], stopped: false,
      sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" }],
    });
    expect(q.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(db.getChat(user.id, 1)?.note).toEqual({ things: ["Neon"], topic: "pricing" });
  });

  it("a follow-up continues the same chat and loads earlier turns + note from the database", async () => {
    const seen: ChatInput[] = [];
    const { ask, db, user } = await start(fakeChat(seen));
    await (await ask({ question: "Neon price?" })).text();
    await (await ask({ question: "and Supabase?", chatId: 1, timezone: "Asia/Kolkata" })).text();

    expect(seen[1]).toEqual({
      question: "and Supabase?",
      history: [{ role: "user", text: "Neon price?" }, { role: "assistant", text: "Neon is $19 [1]." }],
      timezone: "Asia/Kolkata",
      note: { things: ["Neon"], topic: "pricing" },
      userId: user.id,
      messageId: db.listMessages(user.id, 1)[2].id, // the saved follow-up question
    });
    expect(db.listChats(user.id)).toHaveLength(1);
    expect(db.listMessages(user.id, 1)).toHaveLength(4);
  });

  it("no chatId starts a new chat with a title from the question", async () => {
    const { ask, db, user } = await start(fakeChat());
    await (await ask({ question: "Neon price?" })).text();
    await (await ask({ question: "Compare the top five CRM tools for a twenty person sales team in India please" })).text();
    expect(db.listChats(user.id).map((c) => c.title)).toEqual([
      "Compare the top five CRM tools for a twenty person sales…",
      "Neon price?",
    ]);
  });

  it("rejects an empty question and a bad chat number", async () => {
    const { ask } = await start(fakeChat());
    for (const body of [{}, { question: "   " }, { question: 42 }]) {
      const res = await ask(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Please type a question." });
    }
    expect((await ask({ question: "q", chatId: "abc" })).status).toBe(400);
    const missing = await ask({ question: "q", chatId: 999 });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Chat not found." });
  });

  it("needs a user", async () => {
    const { url } = await start(fakeChat());
    const res = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "q" }) });
    expect(res.status).toBe(401);
  });

  it("missing keys: error update; the question is still saved, no answer saved", async () => {
    const { ask, db, user } = await start(createAgent(loadConfig({}), () => {}));
    const events = await readEvents(await ask({ question: "hi" }));
    expect(events).toEqual([
      { event: "chat", data: { id: 1, title: "hi" } },
      { event: "error", data: { message: "Add GEMINI_API_KEY and EXA_API_KEY to .env (copy .env.example to .env first)." } },
    ]);
    expect(db.listMessages(user.id, 1).map((m) => m.role)).toEqual(["user"]);
  });

  it("breaks midway: error update, and the partial answer is saved as stopped", async () => {
    const { ask, db, user } = await start(async function* () {
      yield { type: "text", text: "partial" } as AgentEvent;
      throw new Error("Gemini went away");
    });
    expect(await readEvents(await ask({ question: "q" }))).toEqual([
      { event: "chat", data: { id: 1, title: "q" } },
      { event: "text", data: { text: "partial" } },
      { event: "error", data: { message: "Gemini went away" } },
    ]);
    expect(db.listMessages(user.id, 1)[1]).toMatchObject({ role: "assistant", text: "partial", stopped: true });
  });

  it("page closed mid-answer: stops the agent and saves the partial answer as stopped", async () => {
    let stopped = false;
    let yielded = 0;
    const { ask, db, user } = await start(async function* () {
      try {
        for (let i = 0; i < 1000; i++) {
          yielded++;
          yield { type: "text", text: "word " } as AgentEvent;
          await new Promise((r) => setTimeout(r, 5));
        }
      } finally {
        stopped = true;
      }
    });
    const controller = new AbortController();
    const res = await ask({ question: "q" }, controller.signal);
    const reader = res.body!.getReader();
    await reader.read(); // first update arrived
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(true);
    expect(yielded).toBeLessThan(1000);
    const saved = db.listMessages(user.id, 1)[1];
    expect(saved.stopped).toBe(true);
    expect(saved.text).toContain("word");
  });
});

describe("chat list and opening a chat", () => {
  it("lists your chats newest first and opens one with its messages", async () => {
    const { ask, get } = await start(fakeChat());
    await (await ask({ question: "first" })).text();
    await new Promise((r) => setTimeout(r, 5));
    await (await ask({ question: "second" })).text();

    const list = await (await get("/api/chats")).json();
    expect(list.chats.map((c: { title: string }) => c.title)).toEqual(["second", "first"]);

    const opened = await (await get("/api/chats/1")).json();
    expect(opened.chat.title).toBe("first");
    expect(opened.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
      ["user", "first"], ["assistant", "Neon is $19 [1]."],
    ]);
    expect(opened.messages[1].sources).toHaveLength(1);
  });

  it("user B can't see, open or continue user A's chat", async () => {
    const { ask, url, db } = await start(fakeChat());
    await (await ask({ question: "A's private question" })).text();
    const bob = as(url, db.createUser("bob").id);

    expect((await (await bob.get("/api/chats")).json()).chats).toEqual([]);
    expect((await bob.get("/api/chats/1")).status).toBe(404);
    const res = await bob.ask({ question: "sneaky", chatId: 1 });
    expect(res.status).toBe(404);
    expect(db.listMessages(1, 1).map((m) => m.text)).not.toContain("sneaky");
  });
});

describe("helpers", () => {
  it("makeTitle keeps short questions and cuts long ones at a word", () => {
    expect(makeTitle("  Neon   price? ")).toBe("Neon price?");
    expect(makeTitle("Compare the top five CRM tools for a twenty person sales team in India please")).toBe(
      "Compare the top five CRM tools for a twenty person sales…",
    );
  });

  it("parseChatRequest checks the body", () => {
    expect(parseChatRequest({ question: " q ", chatId: 3, timezone: "Asia/Kolkata" })).toEqual({ question: "q", chatId: 3, timezone: "Asia/Kolkata" });
    expect(parseChatRequest({ question: "x".repeat(4001) })).toMatchObject({ error: expect.stringContaining("too long") });
    expect(parseChatRequest({ question: "q", chatId: -2 })).toEqual({ error: "chatId must be a chat number." });
  });

  it("toTurns marks stopped answers and keeps the last 20", () => {
    const base = { chatId: 1, sources: [], searches: [], createdAt: "t" };
    const msgs = Array.from({ length: 25 }, (_, i) => ({ ...base, id: i, role: "user" as const, text: `m${i}`, stopped: false }));
    msgs.push({ ...base, id: 99, role: "user", text: "half", stopped: true });
    const turns = toTurns(msgs);
    expect(turns).toHaveLength(20);
    expect(turns.at(-1)).toEqual({ role: "user", text: "half\n\n(stopped early)" });
  });
});

describe("memory writer after answers", () => {
  it("runs after a finished answer that used web search, with the saved message's id and time", async () => {
    const jobs: RememberJob[] = [];
    const { ask, db, user } = await start(fakeChat(), (job) => jobs.push(job));
    await (await ask({ question: "Neon price?" })).text();

    const saved = db.listMessages(user.id, 1)[1];
    expect(jobs).toEqual([{
      userId: user.id, chatId: 1, messageId: saved.id, at: saved.createdAt,
      question: "Neon price?", answer: "Neon is $19 [1].",
      sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" }],
    }]);
  });

  it("does not run for answers without searches (small talk), broken answers, or stopped answers", async () => {
    const jobs: RememberJob[] = [];
    const noSearch: ChatFn = async function* () {
      yield { type: "text", text: "You're welcome!" } as AgentEvent;
      yield { type: "sources", sources: [] } as AgentEvent;
      yield { type: "done" } as AgentEvent;
    };
    const s1 = await start(noSearch, (job) => jobs.push(job));
    await (await s1.ask({ question: "thanks!" })).text();
    expect(jobs).toEqual([]);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    db!.close();

    const broken: ChatFn = async function* () {
      yield { type: "search", query: "x" } as AgentEvent;
      yield { type: "text", text: "partial" } as AgentEvent;
      throw new Error("Gemini went away");
    };
    const s2 = await start(broken, (job) => jobs.push(job));
    await (await s2.ask({ question: "q" })).text();
    expect(jobs).toEqual([]);
  });
});

describe("GET /api/memory", () => {
  it("lists your things with the latest fact values and the chats that talked about them", async () => {
    const { get, db, user, url } = await start(fakeChat());
    const chat1 = db.createChat(user.id, "Postgres hosting");
    const chat2 = db.createChat(user.id, "Neon again");
    const neon = db.createThing(user.id, { name: "Neon", type: "Postgres hosting", website: "neon.tech" });
    db.addMention(user.id, { thingId: neon.id, chatId: chat1.id, createdAt: "2026-11-03T09:00:00.000Z" });
    db.addMention(user.id, { thingId: neon.id, chatId: chat2.id, createdAt: "2026-11-11T09:00:00.000Z" });
    db.addFact(user.id, { thingId: neon.id, field: "Launch price", value: "$19/month", sourceUrl: "https://neon.tech/pricing", checkedAt: "2026-11-03T09:00:00.000Z" });
    db.addFact(user.id, { thingId: neon.id, field: "Launch price", value: "$25/month", sourceUrl: "https://neon.tech/pricing", checkedAt: "2026-11-11T09:00:00.000Z" });
    const old = db.createThing(user.id, { name: "Supabase" });
    db.addMention(user.id, { thingId: old.id, chatId: chat1.id, createdAt: "2026-11-03T09:00:00.000Z" });

    const { things } = await (await get("/api/memory")).json();
    expect(things.map((t: { name: string }) => t.name)).toEqual(["Neon", "Supabase"]); // most recent first
    expect(things[0]).toMatchObject({
      type: "Postgres hosting", website: "neon.tech", lastSeen: "2026-11-11T09:00:00.000Z",
      facts: [{ field: "Launch price", value: "$25/month", sourceUrl: "https://neon.tech/pricing", checkedAt: "2026-11-11T09:00:00.000Z" }],
      chats: [{ id: chat2.id, title: "Neon again", at: "2026-11-11T09:00:00.000Z" }, { id: chat1.id, title: "Postgres hosting", at: "2026-11-03T09:00:00.000Z" }],
    });

    // Another user sees nothing, and it needs a user.
    const bob = as(url, db.createUser("bob").id);
    expect((await (await bob.get("/api/memory")).json()).things).toEqual([]);
    expect((await fetch(`${url}/api/memory`)).status).toBe(401);
  });
});
