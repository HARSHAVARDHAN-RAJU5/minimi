import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, parseChatInput } from "../src/app.js";
import { createAgent, toContents, type ChatFn, type ChatInput } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { answer, createFakeModel, fake } from "../src/llm.js";
import { createFakeSearch } from "../src/search.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(chat?: ChatFn) {
  server = createApp({ chat }).listen(0);
  await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  return `http://localhost:${(server!.address() as AddressInfo).port}`;
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

const post = (url: string, body: unknown) =>
  fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// A chat made of fakes: plans one search, writes an answer citing [1].
function fakeChat(seen: ChatInput[] = []): ChatFn {
  return async function* (input) {
    seen.push(input);
    const planner = createFakeModel([[[fake.search("Neon pricing")]], [[fake.text("done")]]]);
    const writer = createFakeModel([[[fake.text("Neon is $19 [1].")]]]);
    const { search } = createFakeSearch({ "Neon pricing": [{ title: "Neon pricing", url: "https://neon.tech/pricing", content: "$19" }] });
    yield* answer({ planner: planner.model, writer: writer.model, search, plannerSystem: "p", writerSystem: "w", question: input.question, history: toContents(input.history) });
  };
}

describe("/api/chat", () => {
  it("streams search → text → sources → done", async () => {
    const url = await start(fakeChat());
    const res = await post(url, { question: "Neon price?" });

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await readEvents(res)).toEqual([
      { event: "search", data: { query: "Neon pricing" } },
      { event: "text", data: { text: "Neon is $19 [1]." } },
      { event: "sources", data: { sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" }] } },
      { event: "done", data: {} },
    ]);
  });

  it("passes history and time zone through", async () => {
    const seen: ChatInput[] = [];
    const url = await start(fakeChat(seen));
    await (await post(url, { question: "and Supabase?", history: [{ role: "user", text: "Neon price?" }, { role: "assistant", text: "$19" }], timezone: "Asia/Kolkata" })).text();
    expect(seen[0]).toEqual({ question: "and Supabase?", history: [{ role: "user", text: "Neon price?" }, { role: "assistant", text: "$19" }], timezone: "Asia/Kolkata" });
  });

  it("rejects an empty or missing question with a clear message", async () => {
    const url = await start(fakeChat());
    for (const body of [{}, { question: "   " }, { question: 42 }]) {
      const res = await post(url, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Please type a question." });
    }
  });

  it("sends an error update when keys are missing", async () => {
    const url = await start(createAgent(loadConfig({}), () => {}));
    const events = await readEvents(await post(url, { question: "hi" }));
    expect(events).toEqual([{ event: "error", data: { message: "Add GEMINI_API_KEY and EXA_API_KEY to .env (copy .env.example to .env first)." } }]);
  });

  it("sends an error update if something breaks midway, and closes the stream", async () => {
    const url = await start(async function* () {
      yield { type: "text", text: "partial" };
      throw new Error("Gemini went away");
    });
    expect(await readEvents(await post(url, { question: "q" }))).toEqual([
      { event: "text", data: { text: "partial" } },
      { event: "error", data: { message: "Gemini went away" } },
    ]);
  });

  it("stops the agent when the page closes mid-answer", async () => {
    let stopped = false;
    let yielded = 0;
    const url = await start(async function* () {
      try {
        for (let i = 0; i < 1000; i++) {
          yielded++;
          yield { type: "text", text: "word " };
          await new Promise((r) => setTimeout(r, 5));
        }
      } finally {
        stopped = true;
      }
    });
    const controller = new AbortController();
    const res = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "q" }), signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read(); // first update arrived
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(true);
    expect(yielded).toBeLessThan(1000);
  });
});

describe("parseChatInput", () => {
  it("keeps only valid history turns, max 20", () => {
    const history = [
      { role: "user", text: "a" }, { role: "robot", text: "x" }, { role: "assistant", text: "" }, { role: "assistant", text: "b" },
      ...Array.from({ length: 30 }, (_, i) => ({ role: "user", text: `m${i}` })),
    ];
    const parsed = parseChatInput({ question: "q", history });
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.history).toHaveLength(20);
      expect(parsed.history!.at(-1)).toEqual({ role: "user", text: "m29" });
    }
  });

  it("rejects bad history and too-long questions", () => {
    expect(parseChatInput({ question: "q", history: "nope" })).toEqual({ error: "history must be a list." });
    expect(parseChatInput({ question: "x".repeat(4001) })).toMatchObject({ error: expect.stringContaining("too long") });
  });
});
