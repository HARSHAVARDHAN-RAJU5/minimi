import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db } from "../src/db.js";

let db: Db;
beforeEach(() => { db = new Db(":memory:", () => new Date("2026-11-03T09:15:00.000Z")); });
afterEach(() => db.close());

describe("memory map: things", () => {
  it("saves things and finds them by name or other name, any case", () => {
    const u = db.createUser("a");
    const neon = db.createThing(u.id, { name: "Neon", type: "Postgres hosting", website: "neon.tech" });
    const pg = db.createThing(u.id, { name: "Postgres", aliases: ["PostgreSQL"] });

    expect(db.getThing(u.id, neon.id)).toEqual(neon);
    expect(db.findThingsByName(u.id, "neon")).toEqual([neon]);
    expect(db.findThingsByName(u.id, "POSTGRESQL")).toEqual([pg]);
    expect(db.findThingsByName(u.id, "nothing")).toEqual([]);
    expect(db.listThings(u.id).map((t) => t.name)).toEqual(["Neon", "Postgres"]);
  });

  it("keeps two things with the same name apart", () => {
    const u = db.createUser("a");
    db.createThing(u.id, { name: "Apollo", type: "sales tool", website: "apollo.io" });
    db.createThing(u.id, { name: "Apollo", type: "coding tool", website: "apollographql.com" });
    expect(db.findThingsByName(u.id, "apollo").map((t) => t.type)).toEqual(["sales tool", "coding tool"]);
  });

  it("adds other names without repeats, and fills in missing details only", () => {
    const u = db.createUser("a");
    const pg = db.createThing(u.id, { name: "Postgres", type: "database" });
    db.addAlias(u.id, pg.id, "PostgreSQL");
    db.addAlias(u.id, pg.id, "postgresql");
    db.addAlias(u.id, pg.id, "POSTGRES"); // same as the name
    db.fillThing(u.id, pg.id, { type: "something else", website: "postgresql.org" });
    expect(db.getThing(u.id, pg.id)).toMatchObject({ aliases: ["PostgreSQL"], type: "database", website: "postgresql.org" });
  });
});

describe("memory map: mentions", () => {
  it("links chats to things with dates, and can filter by date range", () => {
    const u = db.createUser("a");
    const neon = db.createThing(u.id, { name: "Neon" });
    const supa = db.createThing(u.id, { name: "Supabase" });
    const tuesday = db.createChat(u.id, "Postgres hosting");
    db.addMention(u.id, { thingId: neon.id, chatId: tuesday.id, createdAt: "2026-11-03T09:00:00.000Z" });
    db.addMention(u.id, { thingId: supa.id, chatId: tuesday.id, createdAt: "2026-11-03T09:00:00.000Z" });
    const monday = db.createChat(u.id, "Neon again");
    db.addMention(u.id, { thingId: neon.id, chatId: monday.id, createdAt: "2026-11-09T10:00:00.000Z" });

    expect(db.listMentions(u.id, neon.id).map((m) => m.chatId)).toEqual([tuesday.id, monday.id]);
    expect(
      db.listMentions(u.id, neon.id, { from: "2026-11-03T00:00:00.000Z", to: "2026-11-04T00:00:00.000Z" }).map((m) => m.chatId),
    ).toEqual([tuesday.id]);
    expect(db.listThingsInChat(u.id, tuesday.id).map((t) => t.name)).toEqual(["Neon", "Supabase"]);
  });
});

describe("memory map: facts", () => {
  it("keeps old and new facts, each with its date and source; latest wins per field", () => {
    const u = db.createUser("a");
    const neon = db.createThing(u.id, { name: "Neon" });
    const chat = db.createChat(u.id, "t");
    db.addFact(u.id, {
      thingId: neon.id, field: "Launch plan price", value: "$19/month",
      sourceUrl: "https://neon.tech/pricing", chatId: chat.id, checkedAt: "2026-11-03T09:00:00.000Z",
    });
    db.addFact(u.id, { thingId: neon.id, field: "Free plan storage", value: "0.5 GB", checkedAt: "2026-11-03T09:00:00.000Z" });
    db.addFact(u.id, { thingId: neon.id, field: "launch plan price", value: "$25/month", checkedAt: "2026-11-11T09:00:00.000Z" });

    expect(db.listFacts(u.id, neon.id).map((f) => f.value)).toEqual(["$19/month", "0.5 GB", "$25/month"]);
    expect(db.listFacts(u.id, neon.id)[0]).toMatchObject({
      sourceUrl: "https://neon.tech/pricing", chatId: chat.id, checkedAt: "2026-11-03T09:00:00.000Z",
    });
    expect(db.latestFacts(u.id, neon.id).map((f) => [f.field, f.value])).toEqual([
      ["launch plan price", "$25/month"],
      ["Free plan storage", "0.5 GB"],
    ]);
  });
});

describe("memory map: users are kept apart", () => {
  it("user B can't see or add to user A's things, mentions or facts", () => {
    const a = db.createUser("a");
    const b = db.createUser("b");
    const neon = db.createThing(a.id, { name: "Neon" });
    const chatA = db.createChat(a.id, "A");
    const chatB = db.createChat(b.id, "B");
    db.addMention(a.id, { thingId: neon.id, chatId: chatA.id });
    db.addFact(a.id, { thingId: neon.id, field: "price", value: "$19" });

    expect(db.listThings(b.id)).toEqual([]);
    expect(db.findThingsByName(b.id, "Neon")).toEqual([]);
    expect(db.getThing(b.id, neon.id)).toBeUndefined();
    expect(db.listMentions(b.id, neon.id)).toEqual([]);
    expect(db.listFacts(b.id, neon.id)).toEqual([]);
    expect(() => db.addFact(b.id, { thingId: neon.id, field: "price", value: "fake" })).toThrow("not found for this user");
    expect(() => db.addMention(b.id, { thingId: neon.id, chatId: chatB.id })).toThrow("not found for this user");
    expect(() => db.addMention(a.id, { thingId: neon.id, chatId: chatB.id })).toThrow("not found for this user");
    db.addAlias(b.id, neon.id, "hacked");
    expect(db.getThing(a.id, neon.id)?.aliases).toEqual([]);
  });
});
