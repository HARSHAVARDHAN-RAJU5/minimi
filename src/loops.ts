// Open loops: things the user started but hasn't finished, e.g. "pick one of these 5 CRMs".
// Plain code rules, no AI:
//   open  → the user asks to compare / shortlist / choose between 2+ things, and no choice is made yet
//   close → later the user says "we picked / went with / chose / signed up for X" (X is one of the options),
//           or presses Done on the page
// Reminders live on the New chat screen only: quiet everywhere else, never in the middle of an answer.
import type { Db, Loop } from "./db.js";
import { normalName } from "./things.js";

const CHOOSE = /\b(shortlist\w*|short-list\w*|compar\w*|vs\.?|versus|which (?:one|should|is (?:the )?best|to (?:pick|choose|use|go with))|help me (?:choose|pick|decide)|options? for|alternatives? (?:to|for)|best \w+ for|recommend\w*|consider\w*|evaluat\w*|cheapest|(?:pick|choose|decide) between)\b/i;
const DECIDED = /\b(?:(?:we|i)(?:'ve|'re|'ll| have| are| will)?\s+(?:finally\s+)?(?:picked|chose|chosen|went with|go with|going with|decided (?:on|to go with|to use)|settled on|signed up (?:for|with)|bought|subscribed to|switched to|are using|'re using|use)|let'?s go with|going with|we'll take|decision:?)\s+(.+)/i;
const NOT_DECIDED = /\b(?:not|didn'?t|don'?t|haven'?t|won'?t|never|if|should|could|would|whether|or)\b/i;

const MAX_THINGS = 8;
const same = (a: string, b: string) => {
  const x = normalName(a);
  const y = normalName(b);
  return x === y || (x.length > 3 && y.length > 3 && (x.includes(y) || y.includes(x))); // "Supabase Pro" ~ "Supabase"
};

// Does this question start a choice between these things?
export function opensLoop(question: string, things: string[]): boolean {
  return things.length >= 2 && CHOOSE.test(question);
}

// Did the user say they picked one of this loop's options? Returns the option, or undefined.
export function choiceIn(question: string, loop: Loop): string | undefined {
  const m = DECIDED.exec(question);
  if (!m) return undefined;
  const before = question.slice(0, m.index);
  const decidedPart = m[1].split(/[.!?;]/)[0];
  if (NOT_DECIDED.test(before.split(/[.!?;]/).at(-1) ?? "")) return undefined; // "we didn't pick…", "should we go with…"
  const named = normalName(decidedPart);
  return loop.things.find((t) => named.includes(normalName(t)));
}

const loopText = (things: string[]) => `Pick one: ${things.join(", ")}`;

export interface LoopUpdate { opened?: Loop; updated?: Loop; closed: Array<{ loop: Loop; choice?: string }> }

// After each question: close loops the user decided, or open/extend one for a new choice.
export function updateLoops(db: Db, userId: number, turn: { chatId: number; question: string; things: string[]; at?: string }): LoopUpdate {
  const result: LoopUpdate = { closed: [] };
  const open = db.listLoops(userId, "open");

  // 1) A decision closes every open loop that has the picked option.
  for (const loop of open) {
    const choice = choiceIn(turn.question, loop);
    if (choice && db.closeLoop(userId, loop.id, { choice, chatId: turn.chatId, at: turn.at })) {
      result.closed.push({ loop, choice });
    }
  }
  if (result.closed.length) return result;

  // 2) A new choice: extend an open loop about mostly the same options, otherwise open one.
  const things = dedupe(turn.things).slice(0, MAX_THINGS);
  if (!opensLoop(turn.question, things)) return result;
  const overlap = (l: Loop) => things.filter((t) => l.things.some((x) => same(x, t))).length;
  const match = open.find((l) => l.chatId === turn.chatId || overlap(l) >= 2);
  if (match) {
    const merged = dedupe([...match.things, ...things]).slice(0, MAX_THINGS);
    if (merged.length !== match.things.length) {
      db.updateLoop(userId, match.id, { text: loopText(merged), things: merged });
      result.updated = { ...match, things: merged, text: loopText(merged) };
    }
    return result;
  }
  result.opened = db.addLoop(userId, { chatId: turn.chatId, text: loopText(things), things, openedAt: turn.at });
  return result;
}

function dedupe(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names.map((x) => x.trim()).filter(Boolean)) {
    // Keep the shorter, main name: "Supabase" rather than "Supabase Pro".
    const i = out.findIndex((x) => same(x, n));
    if (i === -1) out.push(n);
    else if (n.length < out[i].length) out[i] = n;
  }
  return out;
}
