// The card writer: after an answer, the fast AI lists the things and facts in it,
// code checks every card, and only checked cards are saved to the memory map.
// The AI can miss a fact (the full chat is still saved), but it cannot put a
// made-up fact into memory: a value that is not in the answer text is dropped.
import type { Db } from "./db.js";
import type { ChatModel, Source } from "./llm.js";
import { normalName, resolveThing } from "./things.js";

export interface FactCard { field: string; value: string; sourceUrl: string }
export interface ThingCard { name: string; type?: string; website?: string; aliases: string[]; facts: FactCard[] }
export interface Dropped { what: string; why: string }

const MAX_THINGS = 10;
const MAX_FACTS_PER_THING = 8;
const MAX_TEXT = 80;

// Asks the model for cards. Returns its raw text (JSON, we hope).
export async function askForCards(model: ChatModel, system: string, input: { question: string; answer: string; sources: Source[] }): Promise<string> {
  const sourceList = input.sources.map((s) => `[${s.n}] ${s.title} (${s.url})`).join("\n") || "(none)";
  const text = `QUESTION:\n${input.question}\n\nANSWER:\n${input.answer}\n\nSOURCES:\n${sourceList}`;
  let out = "";
  for await (const parts of model.stream({ system, contents: [{ role: "user", parts: [{ text }] }], tools: false })) {
    for (const p of parts) if (p.text && !p.thought) out += p.text;
  }
  return out;
}

// Reads the model's JSON even with ```json fences or stray words around it.
export function parseCardsJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "");
// Text for comparing: lower case, no markdown stars, no thousands commas, single spaces.
const plain = (s: string) => s.toLowerCase().replace(/\*+/g, "").replace(/(\d),(?=\d{3})/g, "$1").replace(/\s+/g, " ");
const numbersIn = (s: string) => plain(s).match(/\d+(?:\.\d+)?/g) ?? [];

// Is this value really in the answer? Every number in it must appear in the answer as a whole number
// ("19" does not match "190"); a value without numbers must appear word for word.
export function valueInAnswer(value: string, answer: string): boolean {
  // Citation marks like [2] or [1, 3] are not part of the answer's facts.
  const text = plain(answer.replace(/\[(?:n:)?\d+(?:\s*,\s*(?:n:)?\d+)*\]/g, " "));
  const numbers = numbersIn(value);
  if (numbers.length === 0) return text.includes(plain(value).trim());
  return numbers.every((n) => new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?!\\d|\\.\\d)`).test(text));
}

// Checks the model's cards. Keeps only things named in the chat and facts whose value is in the
// answer and whose source number is real. Everything dropped is listed with the reason.
export function checkCards(raw: unknown, input: { question: string; answer: string; sources: Source[] }): { cards: ThingCard[]; dropped: Dropped[] } {
  const cards: ThingCard[] = [];
  const dropped: Dropped[] = [];
  const things = Array.isArray((raw as { things?: unknown })?.things) ? ((raw as { things: unknown[] }).things) : [];
  const spoken = normalName(`${input.question} ${input.answer}`);
  const urlOf = new Map(input.sources.map((s) => [s.n, s.url]));

  for (const t of things.slice(0, MAX_THINGS) as Array<Record<string, unknown>>) {
    const name = clean(t?.name);
    if (!name) continue;
    if (!spoken.includes(normalName(name))) {
      dropped.push({ what: `thing "${name}"`, why: "not named in the question or answer" });
      continue;
    }
    const card: ThingCard = {
      name,
      ...(clean(t.type) ? { type: clean(t.type) } : {}),
      ...(clean(t.website) ? { website: clean(t.website) } : {}),
      aliases: (Array.isArray(t.also_known_as) ? t.also_known_as : []).map(clean).filter((a) => a && normalName(a) !== normalName(name)).slice(0, 5),
      facts: [],
    };
    const facts = Array.isArray(t.facts) ? (t.facts as Array<Record<string, unknown>>) : [];
    for (const f of facts.slice(0, MAX_FACTS_PER_THING)) {
      const field = clean(f?.field);
      const value = clean(f?.value);
      if (!field || !value) continue;
      const sourceUrl = urlOf.get(Number(f.source));
      if (!sourceUrl) {
        dropped.push({ what: `${name}: ${field} = ${value}`, why: "no real source number" });
      } else if (!valueInAnswer(value, input.answer)) {
        dropped.push({ what: `${name}: ${field} = ${value}`, why: "value is not in the answer" });
      } else {
        card.facts.push({ field, value, sourceUrl });
      }
    }
    cards.push(card);
  }
  return { cards, dropped };
}

export interface SavedCards { things: number; newThings: number; facts: number }

// Saves checked cards: finds or creates each thing (same-thing-or-not rules), links it to the chat,
// and adds its facts with the date and source.
export function saveCards(db: Db, userId: number, where: { chatId: number; messageId?: number; at?: string }, cards: ThingCard[]): SavedCards {
  const saved: SavedCards = { things: 0, newThings: 0, facts: 0 };
  for (const card of cards) {
    const { thing, decision } = resolveThing(db, userId, { name: card.name, type: card.type, website: card.website, aliases: card.aliases });
    saved.things++;
    if (decision !== "same") saved.newThings++;
    db.addMention(userId, { thingId: thing.id, chatId: where.chatId, messageId: where.messageId, createdAt: where.at });
    for (const f of card.facts) {
      db.addFact(userId, { thingId: thing.id, field: f.field, value: f.value, sourceUrl: f.sourceUrl, chatId: where.chatId, messageId: where.messageId, checkedAt: where.at });
      saved.facts++;
    }
  }
  return saved;
}

// The whole step: ask → check → save. Never throws: memory is a bonus, the answer is already saved.
export async function rememberAnswer(opts: {
  db: Db; model: ChatModel; system: string; userId: number; chatId: number; messageId?: number; at?: string;
  question: string; answer: string; sources: Source[]; log?: (line: string) => void;
}): Promise<SavedCards | undefined> {
  const { db, model, system, userId, chatId, messageId, at, question, answer, sources, log = () => {} } = opts;
  try {
    const raw = parseCardsJson(await askForCards(model, system, { question, answer, sources }));
    if (!raw) {
      log("memory: the card writer's reply was not readable; nothing saved");
      return undefined;
    }
    const { cards, dropped } = checkCards(raw, { question, answer, sources });
    for (const d of dropped) log(`memory: dropped ${d.what} (${d.why})`);
    const saved = saveCards(db, userId, { chatId, messageId, at }, cards);
    log(`memory: saved ${saved.things} things (${saved.newThings} new), ${saved.facts} facts`);
    return saved;
  } catch (err) {
    log(`memory: card writer failed (${err instanceof Error ? err.message.slice(0, 100) : err}); nothing saved`);
    return undefined;
  }
}
