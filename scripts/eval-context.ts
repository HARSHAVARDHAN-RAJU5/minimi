// Eval: can code build follow-up searches from a "what we're talking about" note,
// as well as the AI planner does, and faster?
// For each 2-question chat:
//   turn 1: real answer (lite plans, searches, lite writes + a hidden <note>)
//   turn 2: code builds searches from the note  vs  AI planner with the chat history
// Run: npm run eval:context
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Content } from "@google/genai";
import { loadConfig, loadEnvFile, requireGeminiKey } from "../src/config.js";
import { buildSearches, noteFromSearches, splitNote, type ChatNote } from "../src/context.js";
import { answer, createGeminiModel, isDailyQuota, isQuotaOrBusy, type ChatModel } from "../src/llm.js";
import { plannerPrompt, writerPrompt } from "../src/prompts.js";
import { webSearchFromConfig } from "../src/search.js";

loadEnvFile();
const config = loadConfig();
const key = requireGeminiKey(config);
const TZ = "Asia/Kolkata";
const lite = createGeminiModel(key, config.geminiFastModel);
const search = webSearchFromConfig(config);

interface Case { name: string; first: string; second: string; must: string[][] }
const CASES: Case[] = [
  { name: "neon→supabase", first: "What does Neon cost?", second: "and Supabase?", must: [["supabase"], ["pric", "cost"]] },
  { name: "crm→salesforce", first: "Compare HubSpot and Pipedrive pricing for 20 users", second: "what about Salesforce?", must: [["salesforce"], ["pric", "cost"]] },
  { name: "topic-change", first: "What does Neon cost?", second: "Who is Neon's CEO?", must: [["neon"], ["ceo", "founder"]] },
  { name: "linear-sso", first: "What's Linear's Business plan price?", second: "does it include SSO?", must: [["linear"], ["sso", "single sign"]] },
  { name: "vercel→netlify", first: "Did Vercel ship anything big this week?", second: "and Netlify?", must: [["netlify"], ["new", "launch", "release", "ship", "announce", "update", "news", "feature"]] },
  { name: "stripe→razorpay", first: "Is Stripe's standard card fee in India still 2%?", second: "what about Razorpay?", must: [["razorpay"], ["fee", "pric", "charge"]] },
  { name: "crm-which-one", first: "Compare HubSpot, Pipedrive and Salesforce for a small sales team", second: "Which one is cheapest for 20 users?", must: [["hubspot"], ["pipedrive"], ["salesforce"], ["pric", "cost", "cheap"]] },
  { name: "it-cheaper", first: "What does Supabase Pro cost?", second: "is it cheaper than Neon?", must: [["supabase"], ["neon"], ["pric", "cost", "cheap"]] },
  { name: "lowercase", first: "what does supabase cost", second: "and railway?", must: [["railway"], ["pric", "cost"]] },
  { name: "nextjs→remix", first: "What's new in Next.js 16?", second: "and in Remix?", must: [["remix"], ["new", "release", "feature", "update"]] },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Retries short limits/overload (429 per minute, 503) so they don't spoil results.
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (err) {
      if (isDailyQuota(err) || attempt >= 4 || !isQuotaOrBusy(err)) throw err;
      await sleep(20_000);
    }
  }
}

function coverage(must: string[][], queries: string[]): number {
  const all = queries.join(" ").toLowerCase();
  return must.filter((g) => g.some((w) => all.includes(w))).length / must.length;
}

// AI planner on turn 2: one planning call with the chat history; returns its searches.
async function aiPlanner(planner: ChatModel, history: Content[], question: string) {
  const start = performance.now();
  const parts = [];
  for await (const p of planner.stream({ system: plannerPrompt(TZ), contents: [...history, { role: "user", parts: [{ text: question }] }], tools: true })) parts.push(...p);
  const queries = parts.filter((p) => p.functionCall?.name === "web_search").map((p) => String(p.functionCall!.args?.query ?? ""));
  return { queries, ms: performance.now() - start };
}

mkdirSync("evals", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const rowsFile = `evals/context-${stamp}.jsonl`;
const rows: Array<Record<string, unknown>> = [];

for (const c of CASES) {
  try {
    // Turn 1: a real answer, with the note instruction added to the writer prompt.
    let text = "";
    const searches: string[] = [];
    await retry(async () => {
      text = ""; searches.length = 0;
      for await (const e of answer({
        planner: lite, writer: lite, search, question: c.first,
        plannerSystem: plannerPrompt(TZ), writerSystem: writerPrompt(TZ), // includes the note instruction
      })) {
        if (e.type === "text") text += e.text;
        if (e.type === "search") searches.push(e.query);
      }
    });
    const { answer: visible, note: writerNote } = splitNote(text);
    const backupNote = noteFromSearches(c.first, searches);
    const note: ChatNote | undefined = writerNote ?? backupNote;

    // Turn 2a: code builds the searches from the note.
    const codeStart = performance.now();
    const built = buildSearches(c.second, note);
    const codeMs = performance.now() - codeStart;

    // Turn 2b: AI planner with the chat history.
    const history: Content[] = [{ role: "user", parts: [{ text: c.first }] }, { role: "model", parts: [{ text: visible }] }];
    const ai = await retry(() => aiPlanner(lite, history, c.second));

    const row = {
      case: c.name, first: c.first, second: c.second, turn1Searches: searches,
      writerNoteValid: Boolean(writerNote), writerNote, backupNote, noteUsed: writerNote ? "writer" : backupNote ? "backup" : "none",
      noteLeakedToAnswer: /<note>/i.test(visible),
      code: { queries: built.queries, reason: built.reason, ms: Math.round(codeMs * 1000) / 1000, coverage: coverage(c.must, built.queries) },
      ai: { queries: ai.queries, ms: Math.round(ai.ms), coverage: coverage(c.must, ai.queries) },
    };
    rows.push(row);
    appendFileSync(rowsFile, JSON.stringify(row) + "\n");
    console.log(`\n${c.name}: "${c.first}" → "${c.second}"`);
    console.log(`  note: ${writerNote ? `writer ✓ ${JSON.stringify(writerNote)}` : `writer ✗, backup ${JSON.stringify(backupNote)}`}`);
    console.log(`  code (${row.code.ms} ms, cover ${(row.code.coverage * 100).toFixed(0)}%): ${built.queries.join(" | ")}`);
    console.log(`  AI   (${(ai.ms / 1000).toFixed(1)} s, cover ${(row.ai.coverage * 100).toFixed(0)}%): ${ai.queries.join(" | ") || "(no search)"}`);
  } catch (err) {
    console.log(`\n${c.name}: ERROR ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    if (isDailyQuota(err)) break;
  }
  await sleep(4_000); // stay under per-minute limits
}

type R = { code: { coverage: number; ms: number }; ai: { coverage: number; ms: number }; writerNoteValid: boolean; noteLeakedToAnswer: boolean };
const rs = rows as unknown as R[];
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
console.log(`\n=== ${rs.length} chats ===`);
console.log(`writer note valid:        ${rs.filter((r) => r.writerNoteValid).length}/${rs.length}`);
console.log(`note leaked into answer:  ${rs.filter((r) => r.noteLeakedToAnswer).length}/${rs.length}`);
console.log(`code searches:  full coverage ${rs.filter((r) => r.code.coverage === 1).length}/${rs.length}, avg ${(avg(rs.map((r) => r.code.coverage)) * 100).toFixed(0)}%, avg time ${avg(rs.map((r) => r.code.ms)).toFixed(2)} ms`);
console.log(`AI planner:     full coverage ${rs.filter((r) => r.ai.coverage === 1).length}/${rs.length}, avg ${(avg(rs.map((r) => r.ai.coverage)) * 100).toFixed(0)}%, avg time ${(avg(rs.map((r) => r.ai.ms)) / 1000).toFixed(1)} s`);

const file = `evals/context-${stamp}.json`;
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), model: config.geminiFastModel, rows }, null, 2));
console.log(`\nSaved ${file}`);
