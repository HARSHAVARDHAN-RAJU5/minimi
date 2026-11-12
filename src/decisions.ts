// Decision log: what the user picked (a loop closed with "we went with X"), over which other options,
// when and why. When a new question is about those options (by name or kind, e.g. "Which CRM
// should we use?"), the writer is told, so it builds on the choice and doesn't re-suggest what
// was ruled out. Plain code; no AI call.
import type { Db, Loop } from "./db.js";
import { thingsInQuestion } from "./recall.js";
import { normalName } from "./things.js";

export interface Decision { choice: string; ruledOut: string[]; reason?: string; decidedAt: string; chatId?: number }

export const toDecision = (l: Loop): Decision => ({
  choice: l.choice!,
  ruledOut: l.things.filter((t) => normalName(t) !== normalName(l.choice!)),
  ...(l.reason ? { reason: l.reason } : {}),
  decidedAt: l.closedAt ?? l.openedAt,
  ...(l.closedInChatId ? { chatId: l.closedInChatId } : {}),
});

// Decisions about things this question is about (named, other names, or the same kind).
export function decisionsFor(db: Db, userId: number, question: string): Decision[] {
  const decisions = db.listDecisions(userId);
  if (decisions.length === 0) return [];
  const asked = thingsInQuestion(db, userId, question).flatMap((t) => [t.name, ...t.aliases]).map(normalName);
  const q = normalName(question);
  const about = (name: string) => asked.includes(normalName(name)) || (normalName(name).length > 2 && q.includes(normalName(name)));
  return decisions.filter((l) => l.things.some(about)).map(toDecision);
}

// The block for the writer: data only (how to use it is in the writer's prompt).
export function decisionsBlock(decisions: Decision[], timezone?: string): string | undefined {
  if (decisions.length === 0) return undefined;
  const day = (iso: string) => {
    try { return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: timezone }).format(new Date(iso)); }
    catch { return new Date(iso).toDateString(); }
  };
  return [
    "--- Memory: decisions this user made ---",
    ...decisions.map((d) => `- Chose ${d.choice} on ${day(d.decidedAt)}${d.ruledOut.length ? ` over ${d.ruledOut.join(", ")}` : ""}${d.reason ? ` (because ${d.reason})` : ""}.`),
  ].join("\n");
}
