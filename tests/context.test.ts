import { describe, it, expect } from "vitest";
import { buildSearches, chooseSearchPath, namesIn, noteFromSearches, parseNote, splitNote } from "../src/context.js";

const q = (question: string, note?: { things: string[]; topic: string }) => buildSearches(question, note, 2026).queries;

describe("splitNote", () => {
  it("separates the hidden note from the answer", () => {
    expect(splitNote('Neon is $19 [1].\n<note>{"things": ["Neon"], "topic": "pricing"}</note>')).toEqual({
      answer: "Neon is $19 [1].",
      note: { things: ["Neon"], topic: "pricing" },
    });
  });

  it("drops a broken or empty note but keeps the answer", () => {
    expect(splitNote("Answer.\n<note>{not json}</note>")).toEqual({ answer: "Answer." });
    expect(splitNote('Answer.\n<note>{"things": [], "topic": "pricing"}</note>')).toEqual({ answer: "Answer." });
    expect(splitNote("Answer with no note.")).toEqual({ answer: "Answer with no note." });
  });
});

describe("namesIn", () => {
  it("finds product names, not plan names, acronyms or the first word", () => {
    expect(namesIn("Compare HubSpot, Pipedrive and Salesforce starter pricing")).toEqual(["HubSpot", "Pipedrive", "Salesforce"]);
    expect(namesIn("What's Linear's Business plan price?")).toEqual(["Linear"]);
    expect(namesIn("Who is Neon's CEO?")).toEqual(["Neon"]);
    expect(namesIn("Does Linear include SSO?")).toEqual(["Linear"]);
  });

  it("finds known names in any case, and 'and X?' follow-ups", () => {
    expect(namesIn("is supabase cheaper?", ["Supabase"])).toEqual(["Supabase"]);
    expect(namesIn("and railway?")).toEqual(["railway"]);
    expect(namesIn("and in Remix?")).toEqual(["Remix"]);
  });
});

describe("buildSearches", () => {
  it("follow-up with a new name: keeps the note's topic", () => {
    expect(q("and Supabase?", { things: ["Neon"], topic: "pricing" })).toEqual(["Supabase pricing 2026"]);
    expect(q("and Netlify?", { things: ["Vercel"], topic: "new features" })).toEqual(["Netlify new features 2026"]);
  });

  it("new topic replaces the old one", () => {
    expect(q("Who is Neon's CEO?", { things: ["Neon"], topic: "pricing" })).toEqual(["Neon CEO"]);
  });

  it("'it' means the last thing; 'which one' means all of them", () => {
    expect(q("does it include SSO?", { things: ["Linear"], topic: "pricing" })).toEqual(["Linear include SSO"]);
    expect(q("Which one is cheapest for 20 users?", { things: ["HubSpot", "Pipedrive"], topic: "pricing" })).toEqual([
      "HubSpot cheapest 20 users 2026", "Pipedrive cheapest 20 users 2026",
    ]);
  });

  it("comparisons keep the old topic and include both things", () => {
    expect(q("is it cheaper than Neon?", { things: ["Supabase"], topic: "pricing" })).toEqual([
      "Supabase cheaper pricing 2026", "Neon cheaper pricing 2026",
    ]);
  });

  it("one search per product named", () => {
    expect(q("Compare HubSpot, Pipedrive and Salesforce starter pricing for a small team.")).toHaveLength(3);
  });

  it("nothing to go on: searches the question as-is (with the year when it's about prices or news)", () => {
    expect(q("what does supabase cost")).toEqual(["what does supabase cost 2026"]);
    expect(q("tell me a joke")).toEqual(["tell me a joke"]);
  });
});

describe("noteFromSearches (backup note)", () => {
  it("builds things and topic from the searches we ran", () => {
    expect(noteFromSearches("What does Supabase Pro cost?", ["Supabase Pro pricing 2026"])).toEqual({ things: ["Supabase Pro"], topic: "pricing" });
    expect(noteFromSearches("hello", [])).toBeUndefined();
  });
});

describe("chooseSearchPath", () => {
  const note = { things: ["Neon"], topic: "pricing" };

  it("code builds the searches when it finds a product name", () => {
    expect(chooseSearchPath("What does Supabase Pro cost?", undefined, "code-first", 2026)).toEqual({
      path: "code", queries: ["Supabase Pro cost 2026"], reason: "names in question",
    });
    expect(chooseSearchPath("and Supabase?", note, "code-first", 2026)).toMatchObject({ path: "code", queries: ["Supabase pricing 2026"] });
    expect(chooseSearchPath("is it cheaper?", note, "code-first", 2026)).toMatchObject({ path: "code", reason: "names from note" });
  });

  it("the AI planner is the backup when code finds nothing", () => {
    expect(chooseSearchPath("what does supabase cost", undefined, "code-first")).toEqual({ path: "planner", reason: "code found no product name" });
    expect(chooseSearchPath("thanks!", note, "code-first")).toEqual({ path: "planner", reason: "code found no product name" });
  });

  it("SEARCH_MODE=planner always uses the AI planner", () => {
    expect(chooseSearchPath("What does Supabase Pro cost?", note, "planner")).toEqual({ path: "planner", reason: "SEARCH_MODE=planner" });
  });
});

describe("parseNote (from the page)", () => {
  it("accepts a clean object, trims it, and ignores junk", () => {
    expect(parseNote({ things: ["Neon", 5, " Supabase "], topic: "pricing" })).toEqual({ things: ["Neon", "Supabase"], topic: "pricing" });
    expect(parseNote({ things: [], topic: "x" })).toBeUndefined();
    expect(parseNote("nope")).toBeUndefined();
    expect(parseNote({ things: Array.from({ length: 30 }, (_, i) => `T${i}`), topic: "t" })?.things).toHaveLength(10);
  });
});
