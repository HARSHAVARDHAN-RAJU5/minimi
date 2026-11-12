import { describe, it, expect } from "vitest";
import { checkUnderstanding, listenerInput, understand } from "../src/listener.js";
import { createFakeModel, fake, type ChatModel } from "../src/llm.js";

describe("code checks the listener's form", () => {
  it("accepts a good follow-up form", () => {
    expect(checkUnderstanding({ type: "follow_up", products: ["Supabase"], when: "", looking_for: "", topic: "", searches: ["Supabase auth features 2026"] })).toEqual({
      type: "follow_up", products: ["Supabase"], when: "", lookingFor: "", topic: "", searches: ["Supabase auth features 2026"],
    });
  });

  it("memory form: keeps time words, what is looked for and topic; drops searches", () => {
    expect(checkUnderstanding({ type: "memory", products: [], when: "last Tuesday", looking_for: "topic", topic: "Postgres hosting", searches: ["x"] })).toEqual({
      type: "memory", products: [], when: "last Tuesday", lookingFor: "topic", topic: "Postgres hosting", searches: [],
    });
  });

  it("cleans up: max 6 searches, no repeats, no empty ones; unknown looking_for becomes empty", () => {
    const u = checkUnderstanding({ type: "new", products: ["A", "", 5], searches: ["a", "a", "", "b", "c", "d", "e", "f", "g"] })!;
    expect(u.searches).toEqual(["a", "b", "c", "d", "e"].slice(0, 5));
    expect(u.products).toEqual(["A"]);
    expect(checkUnderstanding({ type: "memory", looking_for: "everything" })!.lookingFor).toBe("");
  });

  it("rejects forms it can't trust (→ the old way)", () => {
    for (const bad of [undefined, null, "text", {}, { type: "question" }, { type: "new", searches: [] }, { type: "follow_up" }]) {
      expect(checkUnderstanding(bad)).toBeUndefined();
    }
  });
});

describe("what the listener reads", () => {
  it("today's date, the last 6 messages (shortened), and the latest message", () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `m${i} ${"x".repeat(500)}` }));
    const input = listenerInput("what about auth?", history, "Asia/Kolkata", new Date("2026-11-12T03:00:00.000Z"));
    expect(input.startsWith("Today: Thursday, 12 November 2026 (Asia/Kolkata)")).toBe(true);
    expect(input).not.toContain("m1 ");
    expect(input).toContain("User: m2 ");
    expect(input).toContain("Latest message: what about auth?");
    expect(input).not.toContain("x".repeat(401));
    expect(listenerInput("hi")).toContain("(none: this is a new chat)");
  });
});

describe("asking the listener", () => {
  it("returns the checked form", async () => {
    const m = createFakeModel([[[fake.text('```json\n{"type":"follow_up","products":["Supabase"],"searches":["Supabase auth 2026"]}\n```')]]], "lite");
    const r = await understand(m.model, { question: "what about auth?" });
    expect(r.understanding).toMatchObject({ type: "follow_up", products: ["Supabase"], searches: ["Supabase auth 2026"] });
    expect(m.inputs[0].system).toContain("fill in a short form");
  });

  it("broken JSON, an error, or a slow reply → no form (and why)", async () => {
    expect((await understand(createFakeModel([[[fake.text("sorry")]]]).model, { question: "q" })).problem).toBe("form didn't pass the check");
    expect((await understand(createFakeModel([], "lite", new Error("503 UNAVAILABLE")).model, { question: "q" })).problem).toBe("503 UNAVAILABLE");
    const slow: ChatModel = { name: "lite", async *stream() { await new Promise((r) => setTimeout(r, 300)); yield [fake.text("{}")]; } };
    const r = await understand(slow, { question: "q" }, 50);
    expect(r.problem).toBe("no reply in 0 s");
    expect(r.ms).toBeLessThan(250);
  });
});
