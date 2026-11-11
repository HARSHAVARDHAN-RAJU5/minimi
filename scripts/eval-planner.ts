// Eval: which model should plan the web searches (round 1)?
// Compares models on speed and on whether their searches cover what the question needs.
// Only plans searches, never runs them, so it uses no search credits.
// Run: npm run eval:planner                     (both models)
//      npm run eval:planner -- gemini-x-model   (only the models named)
import { GoogleGenAI, type FunctionCall } from "@google/genai";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, loadEnvFile, requireGeminiKey } from "../src/config.js";
import { WEB_SEARCH_TOOL } from "../src/llm.js";

loadEnvFile();
const config = loadConfig();
const ai = new GoogleGenAI({ apiKey: requireGeminiKey(config) });

const cliModels = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const MODELS = cliModels.length ? cliModels : [config.geminiModel, config.geminiFastModel];
const RUNS = 3;
const TODAY = "Wednesday, 11 November 2026";

// Each case: question, optional memory context (as Phase 4 will give it),
// and groups of words. A group counts as covered if any of its words appears in the searches.
interface Case { name: string; question: string; context?: string; mustCover: string[][] }

const CASES: Case[] = [
  {
    name: "crm-monday",
    context: "Earlier chat (Mon 9 Nov 2026): for a 20-person sales team we shortlisted HubSpot, Pipedrive, Salesforce, Zoho CRM and Close.",
    question: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    mustCover: [["hubspot"], ["pipedrive"], ["salesforce"], ["zoho"], ["close"], ["pricing", "price"], ["launch", "release", "announce", "new", "update", "news", "feature"]],
  },
  {
    name: "3-november",
    context: "Earlier chat (Tue 3 Nov 2026): user asked \"What's the cheapest managed Postgres for a small startup?\". Answer: Neon Launch $19/mo, Supabase Pro $25/mo, Render Postgres Basic $6/mo.",
    question: "What did I ask you on 3 November? Is your answer still correct today?",
    mustCover: [["neon"], ["supabase"], ["render"], ["pricing", "price", "cost"]],
  },
  {
    name: "postgres-tuesday",
    context: "Earlier chat (Tue 3 Nov 2026): Postgres hosting, compared Neon, Supabase, AWS RDS and Railway.",
    question: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    mustCover: [["neon"], ["supabase"], ["rds", "aws"], ["railway"], ["pricing", "price", "cost"]],
  },
  {
    name: "crm-compare",
    question: "Compare HubSpot, Pipedrive and Salesforce pricing for 20 users.",
    mustCover: [["hubspot"], ["pipedrive"], ["salesforce"], ["pricing", "price", "cost"]],
  },
  {
    name: "vercel-news",
    question: "Did Vercel ship anything big this week?",
    mustCover: [["vercel"], ["launch", "release", "announce", "new", "ship", "news", "changelog", "update"], ["2026", "november", "nov", "week"]],
  },
  {
    name: "linear-price",
    question: "What's the current price of Linear's Business plan?",
    mustCover: [["linear"], ["business"], ["pricing", "price", "cost"]],
  },
  {
    name: "stripe-india",
    question: "Is Stripe's standard card fee in India still 2%?",
    mustCover: [["stripe"], ["india"], ["fee", "pricing", "price"]],
  },
  {
    name: "node-version",
    question: "What's the latest stable version of Node.js?",
    mustCover: [["node"], ["version", "release", "latest", "lts"]],
  },
];

function systemPrompt(context?: string): string {
  return [
    `Today is ${TODAY}.`,
    "You are a research assistant with one tool: web_search.",
    "For anything that can change (prices, releases, news, versions), search before answering.",
    "Search each product separately. You can request several searches at once.",
    context ? `Memory from earlier chats:\n${context}` : "",
  ].filter(Boolean).join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DailyLimitError extends Error {
  constructor(public model: string) { super(`${model}: free daily request limit reached`); }
}

// One planning call; retries on rate limits so free-tier limits don't spoil the timing.
async function plan(model: string, c: Case): Promise<{ ms: number; calls: FunctionCall[]; text: string }> {
  for (let attempt = 0; ; attempt++) {
    const start = performance.now();
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: c.question }] }],
        config: { systemInstruction: systemPrompt(c.context), tools: [WEB_SEARCH_TOOL] },
      });
      return { ms: performance.now() - start, calls: res.functionCalls ?? [], text: res.text ?? "" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/PerDay/.test(msg)) throw new DailyLimitError(model); // waiting won't help
      if (attempt < 5 && /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE/.test(msg)) {
        await sleep(15_000);
        continue;
      }
      throw err;
    }
  }
}

function coverage(c: Case, queries: string[]): number {
  const all = queries.join(" ").toLowerCase();
  const hit = c.mustCover.filter((group) => group.some((w) => all.includes(w))).length;
  return hit / c.mustCover.length;
}

interface Run { model: string; case: string; run: number; ms: number; queries: string[]; coverage: number; answeredWithoutSearch: boolean }

// Each result is saved the moment it arrives, so a stop (e.g. daily limit) loses nothing.
mkdirSync("evals", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const rowsFile = `evals/planner-${stamp}.jsonl`;

const runs: Run[] = [];
const stopped = new Set<string>(); // models that hit their daily limit
for (const c of CASES) {
  for (let run = 1; run <= RUNS; run++) {
    for (const model of MODELS) {
      if (stopped.has(model)) continue;
      let r;
      try {
        r = await plan(model, c);
      } catch (err) {
        if (err instanceof DailyLimitError) {
          console.log(`STOP ${err.message}; skipping it for the rest of the eval`);
          stopped.add(model);
          continue;
        }
        throw err;
      }
      const queries = r.calls.filter((f) => f.name === "web_search").map((f) => String((f.args as { query?: string })?.query ?? ""));
      const row: Run = { model, case: c.name, run, ms: Math.round(r.ms), queries, coverage: coverage(c, queries), answeredWithoutSearch: queries.length === 0 };
      runs.push(row);
      appendFileSync(rowsFile, JSON.stringify(row) + "\n");
      console.log(`${c.name.padEnd(17)} run ${run}  ${model.padEnd(22)} ${String(row.ms).padStart(5)} ms  cover ${(row.coverage * 100).toFixed(0).padStart(3)}%  ${queries.length} searches: ${queries.join(" | ")}`);
    }
  }
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

console.log("\nmodel                    avg time   median   coverage   full-coverage runs   avg searches   no-search runs");
const summary = MODELS.map((model) => {
  const rs = runs.filter((r) => r.model === model);
  if (rs.length === 0) { console.log(`${model.padEnd(24)} no runs`); return { model, runs: 0 }; }
  const s = {
    model,
    avgMs: Math.round(avg(rs.map((r) => r.ms))),
    medianMs: Math.round(median(rs.map((r) => r.ms))),
    coverage: avg(rs.map((r) => r.coverage)),
    fullCoverageRuns: `${rs.filter((r) => r.coverage === 1).length}/${rs.length}`,
    avgSearches: avg(rs.map((r) => r.queries.length)),
    noSearchRuns: rs.filter((r) => r.answeredWithoutSearch).length,
  };
  console.log(`${model.padEnd(24)} ${(s.avgMs / 1000).toFixed(2).padStart(6)} s  ${(s.medianMs / 1000).toFixed(2).padStart(6)} s   ${(s.coverage * 100).toFixed(0).padStart(5)}%   ${s.fullCoverageRuns.padStart(18)}   ${s.avgSearches.toFixed(1).padStart(12)}   ${String(s.noSearchRuns).padStart(14)}`);
  return s;
});

const file = `evals/planner-${stamp}.json`;
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), today: TODAY, models: MODELS, runsPerCase: RUNS, stopped: [...stopped], summary, runs }, null, 2));
console.log(`\nSaved ${file} (rows also in ${rowsFile})`);
