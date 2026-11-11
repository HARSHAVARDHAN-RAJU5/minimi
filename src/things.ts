// "Same thing or not?" Plain code rules that decide whether a name on a new memory card
// is a thing we already know. When unsure, things are kept apart: two copies of one thing
// is a small mess we can join later; a wrong join gives wrong answers.
import type { Db, Thing } from "./db.js";

export interface SeenThing { name: string; type?: string; website?: string; aliases?: string[] }
export interface Resolved {
  thing: Thing;
  decision: "same" | "new" | "kept-apart"; // kept-apart = a new thing because we could not tell
  reason: string;
}

// "Next.js", "NextJS", "next js" → "nextjs"
export function normalName(name: string): string {
  return name.toLowerCase().replace(/[\s.\-_'’]/g, "");
}

// "https://www.Neon.tech/pricing" → "neon.tech"
export function normalWebsite(site?: string): string | undefined {
  if (!site) return undefined;
  const host = site.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return host.includes(".") ? host : undefined;
}

// Words that say nothing about what kind of thing it is.
const TYPE_FILLER = new Set(["tool", "tools", "platform", "software", "service", "services", "company", "app", "product", "a", "an", "the", "for", "and", "of"]);
const typeWords = (type?: string) => new Set((type ?? "").toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !TYPE_FILLER.has(w)) ?? []);

// Do two type descriptions agree? "sales CRM" + "CRM" → agree; "sales tool" + "coding tool" → differ.
export function compareTypes(a?: string, b?: string): "agree" | "differ" | "unknown" {
  const wa = typeWords(a);
  const wb = typeWords(b);
  if (wa.size === 0 || wb.size === 0) return "unknown";
  return [...wa].some((w) => wb.has(w)) ? "agree" : "differ";
}

function compareSites(a?: string, b?: string): "same" | "differ" | "unknown" {
  const sa = normalWebsite(a);
  const sb = normalWebsite(b);
  if (!sa || !sb) return "unknown";
  return sa === sb ? "same" : "differ";
}

type Verdict = "same" | "different" | "possible";

// One existing thing with a matching name vs the new card.
function judge(existing: Thing, seen: SeenThing): Verdict {
  const site = compareSites(existing.website, seen.website);
  const type = compareTypes(existing.type, seen.type);
  if (site === "same") return "same";
  if (type === "agree") return "same"; // same name + same kind (a company can change its website)
  if (site === "differ" || type === "differ") return "different";
  return "possible"; // nothing to compare
}

// Finds the thing this card is about, or creates one. Fills in missing details and other names.
export function resolveThing(db: Db, userId: number, seen: SeenThing): Resolved {
  const name = seen.name.trim();
  const names = [name, ...(seen.aliases ?? [])].map(normalName).filter(Boolean);
  const all = db.listThings(userId);
  const sameName = all.filter((t) => [t.name, ...t.aliases].some((n) => names.includes(normalName(n))));

  let match: Thing | undefined;
  let reason = "";

  if (sameName.length === 0) {
    // No thing has this name. Same website + related name or same kind → the same thing under another name
    // ("PostgreSQL" joins "Postgres"). Same website alone is not enough (AWS RDS vs AWS S3).
    const site = normalWebsite(seen.website);
    const sameSite = site ? all.filter((t) => normalWebsite(t.website) === site) : [];
    const related = sameSite.filter((t) => {
      const a = normalName(t.name);
      const b = normalName(name);
      return a.includes(b) || b.includes(a) || compareTypes(t.type, seen.type) === "agree";
    });
    if (related.length === 1) {
      match = related[0];
      reason = "same website and related name or kind";
    }
  } else {
    const verdicts = sameName.map((t) => ({ t, v: judge(t, seen) }));
    const same = verdicts.filter((x) => x.v === "same");
    const possible = verdicts.filter((x) => x.v === "possible");
    if (same.length >= 1) {
      match = same[0].t; // oldest first
      reason = "same name, and website or kind agrees";
    } else if (possible.length === 1 && sameName.length === 1) {
      match = possible[0].t;
      reason = "same name, nothing disagrees";
    } else if (possible.length >= 1) {
      // Several things share this name and we can't tell which one: keep it apart.
      return { thing: create(db, userId, seen), decision: "kept-apart", reason: "several things have this name; could not tell which" };
    }
  }

  if (!match) {
    const why = sameName.length ? "same name but different website or kind" : "new name";
    return { thing: create(db, userId, seen), decision: "new", reason: why };
  }

  // Same thing: learn its other names and any missing details.
  for (const n of [name, ...(seen.aliases ?? [])]) db.addAlias(userId, match.id, n);
  db.fillThing(userId, match.id, { type: seen.type, website: normalWebsite(seen.website) });
  const joined = joinCopies(db, userId, match.id);
  return { thing: db.getThing(userId, joined)!, decision: "same", reason };
}

function create(db: Db, userId: number, seen: SeenThing): Thing {
  return db.createThing(userId, {
    name: seen.name.trim(),
    type: seen.type?.trim() || undefined,
    website: normalWebsite(seen.website),
    aliases: (seen.aliases ?? []).map((a) => a.trim()).filter(Boolean),
  });
}

// Join later, once it's safe: other things with the same name that now also share this thing's
// website are the same thing. Their links and facts move to the oldest one. Returns the id kept.
export function joinCopies(db: Db, userId: number, thingId: number): number {
  const thing = db.getThing(userId, thingId);
  const site = normalWebsite(thing?.website);
  if (!thing || !site) return thingId;
  const names = [thing.name, ...thing.aliases].map(normalName);
  const copies = db.listThings(userId).filter((t) =>
    t.id !== thing.id && normalWebsite(t.website) === site && [t.name, ...t.aliases].some((n) => names.includes(normalName(n))));
  if (copies.length === 0) return thingId;
  const keep = Math.min(thing.id, ...copies.map((c) => c.id));
  for (const t of [thing, ...copies]) if (t.id !== keep) db.mergeThings(userId, t.id, keep);
  return keep;
}
