import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db } from "../src/db.js";
import { checkCards, parseCardsJson, rememberAnswer, valueInAnswer } from "../src/extract.js";
import { createFakeModel, fake, type ChatModel } from "../src/llm.js";

const sources = [
  { n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" },
  { n: 2, title: "Supabase pricing", url: "https://supabase.com/pricing" },
];
const question = "Compare Neon and Supabase pricing";
const answer = "As of 11 Nov 2026, **Neon** Launch is $19/month [1] and Supabase Pro is **$25 per month** with 8 GB of disk [2]. A team plan is $1,200 a year.";
const input = { question, answer, sources };

const good = {
  things: [
    { name: "Neon", type: "Postgres hosting", website: "neon.tech", also_known_as: [], facts: [{ field: "Launch plan price", value: "$19/month", source: 1 }] },
    { name: "Supabase", type: "Postgres hosting", website: "supabase.com", facts: [
      { field: "Pro plan price", value: "$25/month", source: 2 },
      { field: "Pro plan disk", value: "8 GB", source: 2 },
    ] },
  ],
};

describe("valueInAnswer", () => {
  it("accepts a value whose numbers are in the answer, however it is worded", () => {
    expect(valueInAnswer("$25/month", answer)).toBe(true); // answer says "$25 per month"
    expect(valueInAnswer("$1200/year", answer)).toBe(true); // answer says "$1,200"
    expect(valueInAnswer("8 GB", answer)).toBe(true);
  });

  it("rejects numbers that are not in the answer, or only part of a bigger number", () => {
    expect(valueInAnswer("$29/month", answer)).toBe(false);
    expect(valueInAnswer("$2/month", answer)).toBe(false); // "2" is only inside "25", "2026", "[2]"… as part
    expect(valueInAnswer("$120", answer)).toBe(false); // part of 1200
  });

  it("a value without numbers must appear word for word", () => {
    expect(valueInAnswer("Launch", answer)).toBe(true);
    expect(valueInAnswer("Enterprise", answer)).toBe(false);
  });
});

describe("parseCardsJson", () => {
  it("reads JSON with fences or stray words around it", () => {
    expect(parseCardsJson('```json\n{"things": []}\n```')).toEqual({ things: [] });
    expect(parseCardsJson('Here you go: {"things": []} done')).toEqual({ things: [] });
    expect(parseCardsJson("no json here")).toBeUndefined();
    expect(parseCardsJson("{broken")).toBeUndefined();
  });
});

describe("checkCards", () => {
  it("keeps good cards and turns source numbers into links", () => {
    const { cards, dropped } = checkCards(good, input);
    expect(dropped).toEqual([]);
    expect(cards.map((c) => c.name)).toEqual(["Neon", "Supabase"]);
    expect(cards[0].facts).toEqual([{ field: "Launch plan price", value: "$19/month", sourceUrl: "https://neon.tech/pricing" }]);
    expect(cards[1].facts).toHaveLength(2);
  });

  it("drops a made-up value, a fake source, and a thing nobody named", () => {
    const { cards, dropped } = checkCards({
      things: [
        { name: "Neon", facts: [
          { field: "Scale plan price", value: "$69/month", source: 1 }, // not in the answer
          { field: "Launch plan price", value: "$19/month", source: 7 }, // no such source
          { field: "Launch plan price", value: "$19/month" }, // no source at all
        ] },
        { name: "PlanetScale", facts: [] }, // never mentioned
      ],
    }, input);
    expect(cards).toEqual([{ name: "Neon", aliases: [], facts: [] }]);
    expect(dropped.map((d) => d.why)).toEqual([
      "value is not in the answer", "no real source number", "no real source number", "not named in the question or answer",
    ]);
  });

  it("keeps a thing with no facts (so we still know it was talked about)", () => {
    const { cards } = checkCards({ things: [{ name: "Supabase", type: "Postgres hosting" }] }, input);
    expect(cards).toEqual([{ name: "Supabase", type: "Postgres hosting", aliases: [], facts: [] }]);
  });

  it("survives junk input", () => {
    for (const junk of [undefined, null, "text", {}, { things: "no" }, { things: [null, 5, { name: 3 }] }]) {
      expect(checkCards(junk, input).cards).toEqual([]);
    }
  });
});

describe("rememberAnswer (ask → check → save)", () => {
  let db: Db;
  let user: number;
  let chat: number;
  beforeEach(() => {
    db = new Db(":memory:");
    user = db.createUser("a").id;
    chat = db.createChat(user, "Compare Neon and Supabase pricing").id;
  });
  afterEach(() => db.close());

  const modelSaying = (text: string) => createFakeModel([[[fake.text(text)]]], "lite");
  const remember = (model: ChatModel, log: string[] = [], at = "2026-11-11T09:00:00.000Z") =>
    rememberAnswer({ db, model, system: "SYSTEM", userId: user, chatId: chat, at, question, answer, sources, log: (l) => log.push(l) });

  it("saves things, links to the chat, and facts with date and source", async () => {
    const m = modelSaying("```json\n" + JSON.stringify(good) + "\n```");
    const log: string[] = [];
    expect(await remember(m.model, log)).toEqual({ things: 2, newThings: 2, facts: 3 });

    const neon = db.findThingsByName(user, "Neon")[0];
    expect(neon).toMatchObject({ type: "Postgres hosting", website: "neon.tech" });
    expect(db.listFacts(user, neon.id)).toEqual([expect.objectContaining({
      field: "Launch plan price", value: "$19/month", sourceUrl: "https://neon.tech/pricing", chatId: chat, checkedAt: "2026-11-11T09:00:00.000Z",
    })]);
    expect(db.listThingsInChat(user, chat).map((t) => t.name)).toEqual(["Neon", "Supabase"]);
    expect(log).toEqual(["memory: saved 2 things (2 new), 3 facts"]);

    // The model got the question, the answer and the numbered sources.
    const sent = m.inputs[0].contents[0].parts![0].text!;
    expect(m.inputs[0].system).toBe("SYSTEM");
    expect(sent).toContain(question);
    expect(sent).toContain("[1] Neon pricing (https://neon.tech/pricing)");
  });

  it("a second answer about the same thing reuses it and keeps both facts with their dates", async () => {
    await remember(modelSaying(JSON.stringify(good)).model, [], "2026-11-03T09:00:00.000Z");
    const later = await remember(modelSaying(JSON.stringify(good)).model, [], "2026-11-11T09:00:00.000Z");
    expect(later).toEqual({ things: 2, newThings: 0, facts: 3 });
    const neon = db.findThingsByName(user, "Neon")[0];
    expect(db.listFacts(user, neon.id).map((f) => f.checkedAt)).toEqual(["2026-11-03T09:00:00.000Z", "2026-11-11T09:00:00.000Z"]);
    expect(db.listThings(user)).toHaveLength(2);
  });

  it("logs what it dropped and saves the rest", async () => {
    const withBad = { things: [{ name: "Neon", facts: [{ field: "Scale", value: "$69", source: 1 }, { field: "Launch plan price", value: "$19/month", source: 1 }] }] };
    const log: string[] = [];
    await remember(modelSaying(JSON.stringify(withBad)).model, log);
    expect(log).toEqual(["memory: dropped Neon: Scale = $69 (value is not in the answer)", "memory: saved 1 things (1 new), 1 facts"]);
  });

  it("an unreadable reply or a broken model saves nothing and never throws", async () => {
    const log: string[] = [];
    expect(await remember(modelSaying("sorry, I can't").model, log)).toBeUndefined();
    expect(await remember(createFakeModel([], "lite", new Error("503 UNAVAILABLE")).model, log)).toBeUndefined();
    expect(db.listThings(user)).toEqual([]);
    expect(log).toEqual([
      "memory: the card writer's reply was not readable; nothing saved",
      "memory: card writer failed (503 UNAVAILABLE); nothing saved",
    ]);
  });
});
