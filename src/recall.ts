// Finding the right old chat for a memory question. Plain code, no AI.
//   1. Is it a memory question? (a date word, or "I asked", "still correct", …)
//   2. Dates are a strict filter: only chats from that day/week.
//   3. On those days, pick the chats about the topic: things in the memory map
//      (names, other names, kinds like "Postgres hosting") + the search index on messages.
//   4. Nothing on the topic that day + a weekday word → look one week earlier, and say so.
//   5. Nothing found → say so. Never guess.
import type { Chat, Db, Fact, Message, Thing } from "./db.js";
import { findDateRange, type DateRange } from "./dates.js";
import { normalName, typeWords } from "./things.js";

export interface RecalledChat {
  chat: Chat;
  when: string; // when it was talked about, e.g. "Tue 10 Nov, 14:05"
  messages: Message[]; // the real saved messages (question + answer) from that time
  things: Thing[]; // what that chat talked about (memory map)
  facts: Array<Fact & { thing: string }>; // what was said then, with dates and sources
}

export interface Recall {
  status: "found" | "none";
  range?: DateRange; // the dates searched
  usedWeekEarlier: boolean; // "last Tuesday" → no chat that day → found one a week earlier
  topic: string[]; // topic words from the question
  matchedThings: Thing[]; // remembered things the question is about
  chats: RecalledChat[]; // best first
  // false = there was a date, nothing that day matched the topic words, so these are simply
  // all the chats from that day ("you didn't ask about X then; you asked about …").
  topicMatched: boolean;
  reason: string; // for the log
}

const MEMORY_PHRASES = new RegExp([
  "\\b(i|we)\\s+(asked|said|talked|discussed|shortlisted|compared|looked|chose|picked|decided|mentioned|checked)\\b",
  "\\byou\\s+(said|told|answered|recommended|suggested|gave|found)\\b",
  "\\b(last time|earlier|previously|before|our (chat|conversation)|remember|still (correct|true|right|valid|accurate))\\b",
  "\\b(changed|change)\\s+since\\b",
  "\\bsince\\s+(then|last|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b",
].join("|"), "i");

// Words that say nothing about the topic (memory, dates, question words, filler).
const NOT_TOPIC = new Set([
  // memory and questions
  "what", "which", "who", "when", "where", "why", "how", "did", "do", "does", "is", "are", "was", "were", "has", "have", "had", "be", "been",
  "i", "we", "you", "me", "us", "my", "our", "your", "it", "its", "they", "them", "their", "these", "those", "this", "that", "any", "all", "of",
  "ask", "asked", "asking", "said", "say", "told", "tell", "talk", "talked", "discuss", "discussed", "shortlist", "shortlisted", "compare", "compared",
  "look", "looked", "chose", "choose", "picked", "pick", "decided", "decide", "mention", "mentioned", "check", "checked", "remember",
  "answer", "answers", "answered", "correct", "true", "right", "valid", "accurate", "still", "change", "changed", "changes", "since", "then",
  "earlier", "previous", "previously", "before", "last", "time", "chat", "conversation", "anything", "something", "big", "ship", "shipped",
  "about", "for", "to", "in", "on", "at", "a", "an", "the", "and", "or", "but", "with", "from", "of", "if", "so", "can", "could", "would", "will",
  "today", "yesterday", "ago", "day", "days", "week", "weeks", "morning", "afternoon", "evening", "tonight", "now", "this", "past",
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sun", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "st", "nd", "rd", "th",
  "please", "again", "also", "just", "really", "some", "one", "ones", "tool", "tools", "thing", "things",
  // everyday words about the chat itself, not its topic
  "hey", "hi", "hello", "question", "questions", "query", "queries", "response", "responses", "reply", "replies", "info", "information",
  "submit", "submitted", "gave", "give", "given", "got", "get", "see", "back", "good", "ok", "okay", "hold", "holds", "up", "work", "works",
  "whether", "remain", "remains", "applicable", "relevant", "trying", "recall", "recap", "remind", "half", "few", "couple", "u", "ur", "pls",
  "same", "different", "new", "update", "updates", "updated", "current", "currently", "latest",
]);

export function isMemoryQuestion(question: string, now?: Date, timezone?: string): boolean {
  return MEMORY_PHRASES.test(question) || findDateRange(question, now, timezone) !== undefined;
}

// Topic words: what the question is about, minus memory/date/filler words and plain numbers.
export function topicWords(question: string): string[] {
  const words = question.toLowerCase().replace(/[’']s\b/g, "").match(/[a-z][a-z0-9.+-]*/g) ?? [];
  return [...new Set(words.map((w) => w.replace(/[.-]+$/, "")).filter((w) => w.length > 1 && !NOT_TOPIC.has(w)))];
}

// Remembered things the question is about: by name / other name, or by kind ("Postgres hosting", "CRM").
export function thingsInQuestion(db: Db, userId: number, question: string): Thing[] {
  const q = normalName(question);
  const topic = new Set(topicWords(question));
  return db.listThings(userId).filter((t) => {
    if ([t.name, ...t.aliases].some((n) => normalName(n).length > 1 && q.includes(normalName(n)))) return true;
    const kind = [...typeWords(t.type)];
    return kind.length > 0 && kind.some((w) => topic.has(w) || topic.has(`${w}s`));
  });
}

function timeLabel(iso: string, timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  try { return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: timezone }).format(new Date(iso)); } catch { return new Intl.DateTimeFormat("en-GB", opts).format(new Date(iso)); }
}

// Chats (and their messages in range) that match the topic. Score: matched things count most.
function chatsOnTopic(db: Db, userId: number, range: { from?: string; to?: string; beforeId?: number }, topic: string[], things: Thing[]) {
  const scores = new Map<number, number>();
  const add = (chatId: number, n: number) => scores.set(chatId, (scores.get(chatId) ?? 0) + n);

  for (const t of things) {
    for (const m of db.listMentions(userId, t.id, range)) add(m.chatId, 3);
  }
  for (const m of db.searchMessages(userId, topic, range)) add(m.chatId, 1);
  return scores;
}

export interface RecallOptions { now?: Date; timezone?: string; beforeMessageId?: number; maxChats?: number }

// Finds the old chat(s) a memory question is about. Undefined when it is not a memory question.
export function recall(db: Db, userId: number, question: string, opts: RecallOptions = {}): Recall | undefined {
  const { now = new Date(), timezone, beforeMessageId, maxChats = 3 } = opts;
  if (!isMemoryQuestion(question, now, timezone)) return undefined;

  const range = findDateRange(question, now, timezone);
  const topic = topicWords(question);
  const matchedThings = thingsInQuestion(db, userId, question);
  const hasTopic = topic.length > 0 || matchedThings.length > 0;

  // Chats in a date range: on the topic if there is one, otherwise all of them.
  const lookIn = (r: { from?: string; to?: string }) => {
    const span = { ...r, beforeId: beforeMessageId };
    const inRange = db.listMessagesInRange(userId, span);
    const chatIds = [...new Set(inRange.map((m) => m.chatId))];
    if (!hasTopic) return { picked: chatIds.map((id) => ({ id, score: 1 })), inRange, chatIds };
    const scores = chatsOnTopic(db, userId, span, topic, matchedThings);
    const picked = [...scores].filter(([id]) => chatIds.includes(id)).map(([id, score]) => ({ id, score }));
    return { picked, inRange, chatIds };
  };

  let usedWeekEarlier = false;
  let found = lookIn(range ?? {});
  if (range && found.picked.length === 0 && range.weekEarlier) {
    const earlier = lookIn(range.weekEarlier);
    if (earlier.picked.length > 0) {
      found = earlier;
      usedWeekEarlier = true;
    }
  }

  // Safety rule: a date was given, nothing that day was about the topic words, but there were chats
  // that day → show those (marked "topic not matched") instead of "nothing found". Leftover everyday
  // words ("what was that thing I asked on the 3rd?") then can't hide the chat.
  let topicMatched = hasTopic;
  if (range && found.picked.length === 0) {
    const sameDay = lookIn(range);
    if (sameDay.chatIds.length > 0) {
      found = { ...sameDay, picked: sameDay.chatIds.map((id) => ({ id, score: 1 })) };
      usedWeekEarlier = false;
      topicMatched = false;
    }
  }

  const base = { range, usedWeekEarlier, topic, matchedThings, topicMatched };
  if (found.picked.length === 0) {
    const where = range ? `on ${range.label}` : "in your saved chats";
    const about = hasTopic ? ` about ${[...matchedThings.map((t) => t.name), ...topic].slice(0, 4).join(", ")}` : "";
    return { status: "none", ...base, chats: [], reason: `no chat ${where}${about}` };
  }

  // Best score first; on a tie, the most recent chat first.
  const lastTime = (id: number) => found.inRange.filter((m) => m.chatId === id).at(-1)?.createdAt ?? "";
  const best = found.picked
    .sort((a, b) => b.score - a.score || lastTime(b.id).localeCompare(lastTime(a.id)))
    .slice(0, maxChats);

  const searched = usedWeekEarlier ? range!.weekEarlier! : range;
  const chats: RecalledChat[] = best.map(({ id }) => {
    const chat = db.getChat(userId, id)!;
    // The messages from the searched days (or the whole chat when there is no date), up to the current question.
    const messages = db.listMessagesInRange(userId, { from: searched?.from, to: searched?.to, beforeId: beforeMessageId })
      .filter((m) => m.chatId === id)
      .slice(-8);
    const things = db.listThingsInChat(userId, id);
    const names = new Map(things.map((t) => [t.id, t.name]));
    const facts = db.listFactsInChat(userId, id).map((f) => ({ ...f, thing: names.get(f.thingId) ?? db.getThing(userId, f.thingId)?.name ?? "" }));
    return { chat, when: timeLabel(messages[0]?.createdAt ?? chat.createdAt, timezone), messages, things, facts };
  });

  const reason = `found ${chats.length} chat${chats.length > 1 ? "s" : ""}${searched ? ` on ${searched.label}` : ""}`
    + `${usedWeekEarlier ? " (a week earlier)" : ""}${hasTopic && !topicMatched ? " (none about the topic; showing that day's chats)" : ""}`;
  return { status: "found", ...base, chats, reason };
}
