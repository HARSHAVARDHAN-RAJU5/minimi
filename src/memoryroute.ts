// The clerk's side of a memory question: the listener said what is being looked for;
// code finds it (exact dates, database, decision log) and says what to search now.
import { findDateRange } from "./dates.js";
import type { Db } from "./db.js";
import { decisionsFor, toDecision, type Decision } from "./decisions.js";
import type { Understanding } from "./listener.js";
import { memorySearches, recall, recallLastQuestion, recallUserFact, thingsInQuestion, type Recall } from "./recall.js";

export interface MemoryLookup {
  recall?: Recall; // the old chat(s), if any
  decisions: Decision[]; // decisions to tell the writer about
  searches: string[]; // what to look up on the web now (empty = no search)
  reason: string; // for the log
}

// "is it still correct?", "has it changed?", "now"…: then the old values get checked on the web.
const WANTS_NOW = /\b(still|changed?|chang\w+|now|today|currently|correct|true|accurate|valid|same|update\w*|since)\b/i;

export function lookupMemory(
  db: Db, userId: number, question: string, u: Understanding,
  opts: { now?: Date; timezone?: string; beforeMessageId?: number } = {},
): MemoryLookup {
  const { now = new Date(), timezone, beforeMessageId } = opts;
  const about = [...u.products, u.topic].filter(Boolean).join(" ");

  if (u.lookingFor === "last_question") {
    const rec = recallLastQuestion(db, userId, { beforeMessageId, timezone });
    return { recall: rec, decisions: [], searches: WANTS_NOW.test(question) ? memorySearches(rec, question) : [], reason: rec.reason };
  }

  if (u.lookingFor === "decision") {
    const all = db.listDecisions(userId).map(toDecision);
    const matching = about ? decisionsFor(db, userId, `${about} ${question}`) : [];
    // A product we never talked about ("did we decide on a Figma plan?"), or a time ("…last week?")
    // → look for the chat below instead (it adds matching decisions), so the answer can honestly say
    // "not found" rather than show some other decision.
    const unknown = u.products.length > 0 && matching.length === 0 && thingsInQuestion(db, userId, u.products.join(" ")).length === 0;
    if (!unknown && !u.when) {
      const decisions = matching.length ? matching : all;
      return { decisions, searches: [], reason: decisions.length ? `${decisions.length} decision(s)` : "no decisions saved" };
    }
  }

  if (u.lookingFor === "user_fact") {
    const rec = recallUserFact(db, userId, u.topic || question, { beforeMessageId, timezone });
    return { recall: rec, decisions: [], searches: [], reason: rec.reason };
  }

  // An earlier chat by date and/or topic. Code turns the time words into days (never the AI).
  const range = (u.when && findDateRange(u.when, now, timezone)) || findDateRange(question, now, timezone) || null;
  const topicText = u.topic || (u.lookingFor === "date" || u.products.length ? "" : question);
  const rec = recall(db, userId, question, { force: true, range, topicText, names: u.products, now, timezone, beforeMessageId })!;
  const decisions = decisionsFor(db, userId, `${about} ${question}`);
  return { recall: rec, decisions, searches: memorySearches(rec, question), reason: rec.reason };
}
