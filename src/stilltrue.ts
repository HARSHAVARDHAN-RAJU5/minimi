// "Still true?" check: a normal question names something the agent already told this user about
// (e.g. "What does Neon cost?" after "Neon Launch is $19/month" on 3 Nov). The old facts go to the
// writer with today's results; the writer adds one short line only if a value changed. Plain code
// picks the facts; no extra AI call and no extra search (the normal search already covers it).
import type { Db, Fact, Thing } from "./db.js";
import { normalName } from "./things.js";

export const STILL_TRUE_MIN_AGE_MS = 24 * 60 * 60 * 1000; // facts checked in the last day are fresh enough
const MAX_FACTS = 10;

// Remembered things named in the question (by name or other name, not by kind).
export function namedThings(db: Db, userId: number, question: string): Thing[] {
  const q = normalName(question);
  return db.listThings(userId).filter((t) => [t.name, ...t.aliases].some((n) => normalName(n).length > 2 && q.includes(normalName(n))));
}

export interface OldFact extends Fact { thing: string }

// The latest saved value of each fact about those things, if it was checked more than a day ago.
export function oldFactsFor(db: Db, userId: number, question: string, now = new Date()): OldFact[] {
  const facts: OldFact[] = [];
  for (const t of namedThings(db, userId, question)) {
    for (const f of db.latestFacts(userId, t.id)) {
      if (now.getTime() - Date.parse(f.checkedAt) >= STILL_TRUE_MIN_AGE_MS) facts.push({ ...f, thing: t.name });
    }
  }
  return facts.slice(0, MAX_FACTS);
}

// The block for the writer: data only (how to use it is in the writer's prompt).
export function stillTrueBlock(facts: OldFact[], timezone?: string): string | undefined {
  if (facts.length === 0) return undefined;
  const day = (iso: string) => {
    try { return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: timezone }).format(new Date(iso)); }
    catch { return new Date(iso).toDateString(); }
  };
  return ["--- Memory: facts you told this user before ---", ...facts.map((f) => `- ${f.thing} · ${f.field}: ${f.value} (said ${day(f.checkedAt)})`)].join("\n");
}
