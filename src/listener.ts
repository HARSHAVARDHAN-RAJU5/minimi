// The "listener": the fast AI reads the latest message (plus the last few chat messages) and fills
// a short form. It only understands; code checks the form and does the work. If the form is broken,
// missing or too slow, the agent falls back to the old code rules, so it never gets stuck.
import type { ChatTurn } from "./agent.js";
import type { ChatModel } from "./llm.js";
import { LISTENER_PROMPT, todayText } from "./prompts.js";

export type MessageType = "new" | "follow_up" | "memory" | "small_talk";
export type LookingFor = "date" | "topic" | "last_question" | "decision" | "user_fact" | "";

export interface Understanding {
  type: MessageType;
  products: string[];
  when: string; // the user's own time words, copied ("last Tuesday"); code turns them into days
  lookingFor: LookingFor;
  topic: string;
  searches: string[];
}

export const LISTENER_TIMEOUT_MS = 5000;
const MAX_SEARCHES = 6;
const MAX_TURNS = 6;
const TYPES: MessageType[] = ["new", "follow_up", "memory", "small_talk"];
const LOOKING: LookingFor[] = ["date", "topic", "last_question", "decision", "user_fact", ""];

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown, max: number, len: number) =>
  (Array.isArray(v) ? v : []).map((x) => text(x, len)).filter(Boolean).slice(0, max);

// Code checks the listener's form. Returns undefined if it can't be trusted (→ old way).
export function checkUnderstanding(raw: unknown): Understanding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const type = TYPES.find((t) => t === r.type);
  if (!type) return undefined;
  const lookingFor = LOOKING.find((l) => l === (typeof r.looking_for === "string" ? r.looking_for : "")) ?? "";
  const u: Understanding = {
    type,
    products: list(r.products, 8, 60),
    when: type === "memory" ? text(r.when, 40) : "",
    lookingFor: type === "memory" ? lookingFor : "",
    topic: type === "memory" ? text(r.topic, 60) : "",
    searches: type === "new" || type === "follow_up" ? [...new Set(list(r.searches, MAX_SEARCHES, 150))] : [],
  };
  // A question that needs the web but came with no searches can't be acted on.
  if ((u.type === "new" || u.type === "follow_up") && u.searches.length === 0) return undefined;
  return u;
}

// Reads the model's JSON even with ```json fences or stray words around it.
function parseJson(s: string): unknown {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return undefined; }
}

// What the listener reads: today's date, the last few messages (shortened), the latest message.
export function listenerInput(question: string, history: ChatTurn[] = [], timezone?: string, now = new Date()): string {
  const { date, timezone: tz } = todayText(timezone, now);
  const recent = history.slice(-MAX_TURNS).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text.replace(/\s+/g, " ").slice(0, 400)}`);
  return [`Today: ${date} (${tz})`, "", "Recent chat:", recent.length ? recent.join("\n") : "(none: this is a new chat)", "", `Latest message: ${question}`].join("\n");
}

// Asks the listener. Undefined if it fails, is too slow, or its form doesn't pass the check.
export async function understand(
  model: ChatModel,
  input: { question: string; history?: ChatTurn[]; timezone?: string; now?: Date },
  timeoutMs = LISTENER_TIMEOUT_MS,
): Promise<{ understanding?: Understanding; ms: number; problem?: string }> {
  const start = performance.now();
  const it = model.stream({ system: LISTENER_PROMPT, contents: [{ role: "user", parts: [{ text: listenerInput(input.question, input.history, input.timezone, input.now) }] }], tools: false })[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), timeoutMs); });
  let out = "";
  try {
    for (;;) {
      const next = await Promise.race([it.next(), timeout]);
      if (next === "timeout") {
        void it.return?.();
        return { ms: performance.now() - start, problem: `no reply in ${Math.round(timeoutMs / 1000)} s` };
      }
      if (next.done) break;
      for (const p of next.value) if (p.text && !p.thought) out += p.text;
    }
  } catch (err) {
    return { ms: performance.now() - start, problem: err instanceof Error ? err.message.slice(0, 120) : String(err) };
  } finally {
    clearTimeout(timer);
  }
  const understanding = checkUnderstanding(parseJson(out));
  return understanding ? { understanding, ms: performance.now() - start } : { ms: performance.now() - start, problem: "form didn't pass the check" };
}
