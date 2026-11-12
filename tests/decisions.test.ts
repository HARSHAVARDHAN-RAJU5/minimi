import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { decisionsBlock, decisionsFor } from "../src/decisions.js";
import { createFakeModel, fake } from "../src/llm.js";
import { reasonIn, updateLoops } from "../src/loops.js";
import { createFakeSearch } from "../src/search.js";

const CRMS = ["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Close"];
let db: Db;
let user: number;
beforeEach(() => {
  db = new Db(":memory:", () => new Date("2026-11-12T04:00:00.000Z"));
  user = db.createUser("asha").id;
  for (const name of CRMS) db.createThing(user, { name, type: "CRM" });
  db.createThing(user, { name: "Neon", type: "Postgres hosting" });
});
afterEach(() => db.close());

const say = (question: string, things: string[] = []) => updateLoops(db, user, { chatId: db.createChat(user, question).id, question, things });

describe("the reason, if the user gives one", () => {
  it("is read after because / since / as / due to", () => {
    expect(reasonIn("We went with Pipedrive because it's cheaper for 20 seats.")).toBe("it's cheaper for 20 seats");
    expect(reasonIn("we picked HubSpot since the free CRM covers us")).toBe("the free CRM covers us");
    expect(reasonIn("We went with Pipedrive.")).toBeUndefined();
    expect(reasonIn("We went with Pipedrive because.")).toBeUndefined(); // too short to be a reason
  });

  it("is saved with the decision", () => {
    say("Shortlist CRM tools for a 20-person sales team", CRMS);
    const { closed } = say("We went with Pipedrive because it's cheaper for 20 seats. How do I import contacts?");
    expect(closed[0]).toMatchObject({ choice: "Pipedrive", reason: "it's cheaper for 20 seats" });
    expect(db.listDecisions(user)).toEqual([expect.objectContaining({ choice: "Pipedrive", reason: "it's cheaper for 20 seats", status: "closed" })]);
  });
});

describe("which decisions a question is about", () => {
  beforeEach(() => {
    say("Shortlist CRM tools for a 20-person sales team", CRMS);
    say("We went with Pipedrive because it's cheaper for 20 seats");
  });

  it("by an option's name, or by the same kind ('which CRM…')", () => {
    for (const q of ["Is HubSpot any good?", "Which CRM should we use for a new team?", "How do I set up Pipedrive pipelines?"]) {
      expect(decisionsFor(db, user, q).map((d) => d.choice)).toEqual(["Pipedrive"]);
    }
    expect(decisionsFor(db, user, "What does Neon cost?")).toEqual([]);
  });

  it("the block tells the writer what was picked, over what, when and why", () => {
    expect(decisionsBlock(decisionsFor(db, user, "Is HubSpot any good?"), "Asia/Kolkata")).toBe(
      "--- Memory: decisions this user made ---\n- Chose Pipedrive on Thu 12 Nov over HubSpot, Salesforce, Zoho CRM, Close (because it's cheaper for 20 seats).",
    );
  });

  it("a loop closed with Done (no choice) is not a decision", () => {
    const { opened } = say("Compare Neon and Supabase", ["Neon", "Supabase"]);
    db.closeLoop(user, opened!.id);
    expect(db.listDecisions(user).map((d) => d.choice)).toEqual(["Pipedrive"]);
    expect(decisionsFor(db, user, "What does Neon cost?")).toEqual([]);
  });

  it("never another user's decisions", () => {
    const bob = db.createUser("bob").id;
    expect(decisionsFor(db, bob, "Which CRM should we use?")).toEqual([]);
  });

  it("the agent gives the writer the decision for a related question", async () => {
    const writer = createFakeModel([[[fake.text("answer")]]], "smart");
    const chat = createAgent(loadConfig({ GEMINI_API_KEY: "t", EXA_API_KEY: "t" }), () => {}, db, {
      planner: createFakeModel([[[fake.text("NO_SEARCH")]]]).model, writer: writer.model, search: createFakeSearch().search,
    });
    const c = db.createChat(user, "q");
    const asked = db.addMessage(user, c.id, { role: "user", text: "Is HubSpot worth it for us?" });
    for await (const _ of chat({ question: "Is HubSpot worth it for us?", userId: user, messageId: asked.id, timezone: "Asia/Kolkata" })) { /* drain */ }
    expect(writer.inputs[0].contents.at(-1)!.parts![0].text).toContain("Chose Pipedrive on Thu 12 Nov over HubSpot");
  });
});
