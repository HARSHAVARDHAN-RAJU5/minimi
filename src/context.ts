// "What we're talking about" note + a code-only search builder.
// The writer adds a hidden <note> at the end of its answer; code uses it to build
// the next question's searches without asking an AI. (Being tested; not used by the agent yet.)

export interface ChatNote {
  things: string[]; // products/companies being discussed, most recent first
  topic: string; // what the user wants to know about them, e.g. "pricing"
}

// Added to the writer's prompt (test version).
export const NOTE_INSTRUCTION = `After your answer, add one last line in exactly this form (it is hidden from the user):
<note>{"things": ["Product A", "Product B"], "topic": "pricing"}</note>
- things: the products or companies this conversation is about, most recent first.
- topic: in 1-4 words, what the user wants to know about them (e.g. "pricing", "new features", "CEO", "SSO support").`;

const NOTE_RE = /<note>\s*([\s\S]*?)\s*<\/note>/i;

// Splits the writer's text into the visible answer and the note (if valid).
export function splitNote(text: string): { answer: string; note?: ChatNote } {
  const m = NOTE_RE.exec(text);
  if (!m) return { answer: text.trim() };
  const answer = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  try {
    const raw = JSON.parse(m[1]) as { things?: unknown; topic?: unknown };
    const things = Array.isArray(raw.things) ? raw.things.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim()) : [];
    const topic = typeof raw.topic === "string" ? raw.topic.trim() : "";
    if (things.length === 0 || !topic) return { answer };
    return { answer, note: { things, topic } };
  } catch {
    return { answer };
  }
}

// --- Word lists -------------------------------------------------------------

const PRICE_WORDS = ["cost", "costs", "price", "prices", "pricing", "priced", "fee", "fees", "plan", "plans", "cheap", "cheaper", "cheapest", "expensive", "$"];
const NEWS_WORDS = ["new", "latest", "launch", "launched", "release", "released", "ship", "shipped", "announce", "announced", "update", "updates", "news", "changed", "change", "changes"];
const NOW_WORDS = ["now", "today", "current", "currently", "still", "this week", "this month", "latest", "changed", "since"];
// Words that compare, so the old topic still applies ("is it cheaper?" → still about pricing).
const COMPARE_WORDS = ["cheaper", "cheapest", "better", "best", "worse", "faster", "bigger", "more", "less", "expensive", "compare", "vs", "versus"];
const SINGLE_PRONOUNS = ["it", "its", "it's", "that", "this"];
const PLURAL_PRONOUNS = ["they", "them", "their", "these", "those", "which one", "which", "any of them", "each", "all of them", "both"];
const STOP = new Set([
  "a", "an", "the", "and", "or", "but", "is", "are", "was", "were", "be", "been", "do", "does", "did", "what", "whats", "what's",
  "who", "whom", "which", "how", "much", "many", "about", "of", "for", "to", "in", "on", "at", "by", "with", "from", "than", "then",
  "it", "its", "it's", "that", "this", "they", "them", "their", "these", "those", "one", "any", "all", "each", "both",
  "i", "we", "you", "me", "us", "my", "our", "your", "can", "could", "should", "would", "will", "tell", "please", "there",
  "have", "has", "had", "get", "give", "now", "today", "right", "still", "currently", "current", "just", "also", "so", "if",
]);

const hasAny = (text: string, words: string[]) => words.some((w) => (w === "$" ? text.includes("$") : new RegExp(`\\b${escape(w)}\\b`, "i").test(text)));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- Finding names ----------------------------------------------------------

// Capitalised words not at the start of the question, plus any known thing (any case),
// plus "and X?" / "what about X?" patterns. Possessive "'s" is dropped.
export function namesIn(question: string, known: string[] = []): string[] {
  const found: string[] = [];
  const add = (n: string) => {
    const clean = n.replace(/['’]s$/i, "").replace(/[?.!,]+$/, "").trim();
    if (clean && !found.some((f) => f.toLowerCase() === clean.toLowerCase())) found.push(clean);
  };

  for (const k of known) if (new RegExp(`\\b${escape(k)}\\b`, "i").test(question)) add(k);

  const follow = /^(?:and|what about|how about|and what about)\s+(?:in|for|on|with|the)?\s*(.+?)\s*\??$/i.exec(question.trim());
  if (follow && follow[1].split(/\s+/).length <= 3) add(follow[1]);

  // Join runs of capitalised words separated by a single space ("Sales Hub"), but not across
  // commas, possessives ("Neon's CEO") or acronyms (SSO, CEO are topics, not products).
  const tokens = [...question.matchAll(/[A-Za-z][\w.+-]*(?:['’]s)?/g)];
  let run: string[] = [];
  const flush = () => { if (run.length) add(run.join(" ")); run = []; };
  tokens.forEach((t, i) => {
    const w = t[0].replace(/\.$/, "");
    const acronym = /^[A-Z]{2,5}$/.test(w);
    const capital = /^[A-Z]/.test(w) && i > 0 && !STOP.has(w.toLowerCase()) && w !== "I" && !acronym;
    const prev = tokens[i - 1];
    // "Linear's Business plan": Business is a detail. ("What's", "it's" are contractions, not possessives.)
    const afterPossessive = prev && /['’]s$/i.test(prev[0]) && !STOP.has(prev[0].replace(/['’]s$/i, "").toLowerCase()) && !STOP.has(prev[0].toLowerCase().replace("’", "'"));
    const joined = prev && question.slice(prev.index! + prev[0].length, t.index) === " " && !afterPossessive;
    if (!capital || !joined) flush();
    if (capital && !afterPossessive) run.push(w);
  });
  flush();
  return found.filter((n) => !/^[A-Z]{2,5}$/.test(n));
}

// Content words of the question, minus names, pronouns and filler.
function topicWordsIn(question: string, names: string[]): string[] {
  let rest = ` ${question.toLowerCase()} `;
  for (const n of names) rest = rest.replace(new RegExp(`\\b${escape(n.toLowerCase())}(['’]s)?\\b`, "g"), " ");
  return (rest.match(/[a-z0-9$][\w.+$'’-]*/g) ?? [])
    .map((w) => w.replace(/[.]+$/, ""))
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w === "sso" || w === "ceo" || w === "api" ? w.toUpperCase() : w));
}

// --- Building searches ------------------------------------------------------

export interface BuiltSearches { queries: string[]; reason: string }

// Code-only: builds the searches for a question from its words and the chat's note.
export function buildSearches(question: string, note?: ChatNote, year = new Date().getFullYear()): BuiltSearches {
  const q = question.trim();
  const lower = q.toLowerCase();
  let names = namesIn(q, note?.things ?? []);
  const words = topicWordsIn(q, names);
  let reason = "names in question";

  // No names: use the note (pronouns tell us one thing or all of them).
  if (names.length === 0 && note) {
    names = hasAny(lower, PLURAL_PRONOUNS) ? note.things : note.things.slice(0, 1);
    reason = "names from note";
  } else if (note && hasAny(lower, SINGLE_PRONOUNS) && !names.some((n) => n.toLowerCase() === note.things[0]?.toLowerCase())) {
    names = [note.things[0], ...names]; // "is it cheaper than Neon?" → it = the last thing
    reason = "names in question + note";
  }

  // Nothing to go on: search the question as-is.
  if (names.length === 0) return { queries: [withYear(q, lower, year)], reason: "question as-is" };

  // Topic: the question's own words; the note's topic when the question has none or only compares.
  const ownTopic = words.filter((w) => !COMPARE_WORDS.includes(w));
  const topicParts = ownTopic.length ? words : [...words, note?.topic ?? ""];
  const topic = topicParts.filter(Boolean).join(" ");
  const needsYear = hasAny(lower, [...PRICE_WORDS, ...NEWS_WORDS, ...NOW_WORDS]) || hasAny(topic, [...PRICE_WORDS, ...NEWS_WORDS]);

  const queries = names.map((n) => [n, topic, needsYear ? String(year) : ""].filter(Boolean).join(" ").replace(/\s+/g, " ").trim());
  return { queries, reason };
}

function withYear(q: string, lower: string, year: number): string {
  return hasAny(lower, [...PRICE_WORDS, ...NEWS_WORDS, ...NOW_WORDS]) && !lower.includes(String(year)) ? `${q.replace(/\?+$/, "")} ${year}` : q;
}

// Backup note when the writer's note is missing or broken: built from the searches we ran.
export function noteFromSearches(question: string, queries: string[]): ChatNote | undefined {
  const things: string[] = [];
  for (const query of [question, ...queries]) {
    for (const n of namesIn(query)) {
      // Skip repeats and parts of a longer name ("Pro" inside "Supabase Pro").
      if (!things.some((t) => t.toLowerCase() === n.toLowerCase() || t.toLowerCase().includes(n.toLowerCase()))) things.push(n);
    }
  }
  if (things.length === 0) return undefined;
  const text = [question, ...queries].join(" ").toLowerCase();
  const topic = hasAny(text, PRICE_WORDS) ? "pricing" : hasAny(text, NEWS_WORDS) ? "new features" : topicWordsIn(question, things).slice(0, 3).join(" ") || "general";
  return { things, topic };
}
