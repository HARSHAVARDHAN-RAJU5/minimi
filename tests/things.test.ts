import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db } from "../src/db.js";
import { compareTypes, normalName, normalWebsite, resolveThing } from "../src/things.js";

let db: Db;
let user: number;
beforeEach(() => { db = new Db(":memory:"); user = db.createUser("a").id; });
afterEach(() => db.close());

const see = (name: string, type?: string, website?: string, aliases?: string[]) => resolveThing(db, user, { name, type, website, aliases });
const count = () => db.listThings(user).length;

describe("helpers", () => {
  it("ignores case and small spelling marks in names", () => {
    expect(new Set(["Next.js", "NextJS", "next js", "next-js"].map(normalName)).size).toBe(1);
  });

  it("reduces a link to its website", () => {
    expect(normalWebsite("https://www.Neon.tech/pricing?x=1")).toBe("neon.tech");
    expect(normalWebsite("neon.tech")).toBe("neon.tech");
    expect(normalWebsite("not a site")).toBeUndefined();
  });

  it("compares kinds by their meaningful words", () => {
    expect(compareTypes("sales CRM", "CRM")).toBe("agree");
    expect(compareTypes("sales tool", "coding tool")).toBe("differ");
    expect(compareTypes("CRM", undefined)).toBe("unknown");
    expect(compareTypes("tool", "platform")).toBe("unknown"); // only filler words
  });
});

describe("same thing or not?", () => {
  it("a new name is a new thing", () => {
    expect(see("Neon", "Postgres hosting", "neon.tech").decision).toBe("new");
    expect(see("Supabase", "Postgres hosting", "supabase.com").decision).toBe("new");
    expect(count()).toBe(2);
  });

  it("same name and same website → same thing", () => {
    const first = see("Neon", "Postgres hosting", "neon.tech").thing;
    const again = see("neon", undefined, "https://neon.tech/pricing");
    expect(again.decision).toBe("same");
    expect(again.thing.id).toBe(first.id);
    expect(count()).toBe(1);
  });

  it("spelling variants are the same thing", () => {
    const first = see("Next.js", "web framework").thing;
    expect(see("NextJS", "framework").thing.id).toBe(first.id);
    expect(see("next js").thing.id).toBe(first.id);
    expect(count()).toBe(1);
  });

  it("same name, nothing disagrees, only one thing has it → same; missing details get filled in", () => {
    const first = see("Linear").thing;
    const again = see("Linear", "issue tracker", "linear.app");
    expect(again.decision).toBe("same");
    expect(again.thing).toMatchObject({ id: first.id, type: "issue tracker", website: "linear.app" });
  });

  it("the two Apollos stay apart (different website and kind)", () => {
    const sales = see("Apollo", "sales tool", "apollo.io").thing;
    const coding = see("Apollo", "coding tool", "apollographql.com");
    expect(coding.decision).toBe("new");
    expect(coding.thing.id).not.toBe(sales.id);
    // Each later card goes to the right one.
    expect(see("Apollo", "sales prospecting tool").thing.id).toBe(sales.id);
    expect(see("Apollo", undefined, "apollographql.com").thing.id).toBe(coding.thing.id);
    expect(count()).toBe(2);
  });

  it("no websites but clearly different kinds → different things", () => {
    const a = see("Mercury", "bank").thing;
    const b = see("Mercury", "planet");
    expect(b.decision).toBe("new");
    expect(b.thing.id).not.toBe(a.id);
  });

  it("two things share the name and the card gives no clue → kept apart", () => {
    see("Apollo", "sales tool", "apollo.io");
    see("Apollo", "coding tool", "apollographql.com");
    const unclear = see("Apollo");
    expect(unclear.decision).toBe("kept-apart");
    expect(count()).toBe(3);
  });

  it("same kind but the website changed → still the same thing", () => {
    const first = see("Neon", "Postgres hosting", "neon.tech").thing;
    const moved = see("Neon", "serverless Postgres", "neon.com");
    expect(moved.decision).toBe("same");
    expect(moved.thing.id).toBe(first.id);
    expect(moved.thing.website).toBe("neon.tech"); // the first website is kept
  });

  it("PostgreSQL joins Postgres through the same website, and is saved as another name", () => {
    const pg = see("Postgres", "database", "postgresql.org").thing;
    const full = see("PostgreSQL", "database", "postgresql.org");
    expect(full.decision).toBe("same");
    expect(full.thing.id).toBe(pg.id);
    expect(full.thing.aliases).toEqual(["PostgreSQL"]);
    expect(see("postgresql").thing.id).toBe(pg.id); // found by its other name from now on
  });

  it("without a shared website or a hint, Postgres and PostgreSQL stay apart", () => {
    see("Postgres");
    expect(see("PostgreSQL").decision).toBe("new");
    expect(count()).toBe(2);
  });

  it("an 'also known as' hint joins them", () => {
    const pg = see("Postgres").thing;
    expect(see("PostgreSQL", undefined, undefined, ["Postgres"]).thing.id).toBe(pg.id);
  });

  it("same website alone is not enough: AWS RDS and AWS S3 stay apart", () => {
    const rds = see("AWS RDS", "managed database", "aws.amazon.com").thing;
    const s3 = see("AWS S3", "object storage", "aws.amazon.com");
    expect(s3.decision).toBe("new");
    expect(s3.thing.id).not.toBe(rds.id);
  });

  it("joins copies later, once a website shows they are the same; links and facts move over", () => {
    see("Apollo", "sales tool", "apollo.io");
    see("Apollo", "coding tool", "apollographql.com");
    const loose = see("Apollo").thing; // kept apart
    const chat = db.createChat(user, "c");
    db.addMention(user, { thingId: loose.id, chatId: chat.id });
    db.addFact(user, { thingId: loose.id, field: "price", value: "$49" });

    // A later card for the loose copy reveals its website. Direct fill, then join.
    db.fillThing(user, loose.id, { website: "apollo.io" });
    const joined = see("Apollo", undefined, "apollo.io").thing;

    expect(count()).toBe(2);
    expect(db.getThing(user, loose.id)).toBeUndefined();
    expect(db.listFacts(user, joined.id).map((f) => f.value)).toEqual(["$49"]);
    expect(db.listMentions(user, joined.id)).toHaveLength(1);
  });

  it("never looks at another user's things", () => {
    const other = db.createUser("b").id;
    resolveThing(db, other, { name: "Neon", website: "neon.tech" });
    expect(see("Neon", undefined, "neon.tech").decision).toBe("new");
  });
});
