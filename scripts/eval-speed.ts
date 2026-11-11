// Eval: which speed ideas make answers faster without making them wrong?
// Runs the same questions through each version and measures each part + correctness.
// Run: npm run eval:speed                    (writer = fast model)
//      npm run eval:speed -- gemini-x-model  (writer = that model)
//      add --runs=3 for more runs, --only=baseline,early to pick versions
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, loadEnvFile, requireGeminiKey } from "../src/config.js";
import { answer, createGeminiModel, isDailyQuota, type AnswerOptions, type Timings } from "../src/llm.js";
import { plannerPrompt, writerPrompt } from "../src/prompts.js";
import { webSearchFromConfig } from "../src/search.js";

loadEnvFile();
const config = loadConfig();
const key = requireGeminiKey(config);

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const writerModel = args.find((a) => !a.startsWith("--")) ?? config.geminiFastModel;
const RUNS = Number(flag("runs") ?? 2);
const TIMEZONE = "Asia/Kolkata";

const VERSIONS: Record<string, AnswerOptions> = {
  baseline: {},
  early: { earlySearch: true },
  short: { maxResults: 3, maxChars: 800 },
  noPlanner: { skipPlanner: true },
  "early+short": { earlySearch: true, maxResults: 3, maxChars: 800 },
};
const only = flag("only")?.split(",");
const versions = Object.entries(VERSIONS).filter(([name]) => !only || only.includes(name));

// Each question lists what a correct answer must contain (checked against live facts on 11 Nov 2026).
const QUESTIONS = [
  { name: "supabase", question: "What does Supabase Pro cost per month right now?", must: [/\$25\b/] },
  { name: "neon", question: "What is Neon's Launch plan compute price per CU-hour?", must: [/0\.106/] },
  {
    name: "crm",
    question: "Compare HubSpot, Pipedrive and Salesforce starter pricing for a small team.",
    must: [/hubspot/i, /pipedrive/i, /salesforce/i, /\$\s?\d/],
  },
];

const planner = createGeminiModel(key, config.geminiFastModel);
const writer = createGeminiModel(key, writerModel);
const search = webSearchFromConfig(config);

mkdirSync("evals", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const rowsFile = `evals/speed-${stamp}.jsonl`;

interface Row {
  version: string; question: string; run: number;
  firstTextMs?: number; planMs: number; searchMs: number; totalMs: number;
  searches: string[]; correct: boolean; missing: string[]; cited: boolean; answer: string;
}
const rows: Row[] = [];

console.log(`writer=${writerModel} planner=${config.geminiFastModel} runs=${RUNS} versions=${versions.map(([n]) => n).join(",")}\n`);

outer: for (let run = 1; run <= RUNS; run++) {
  for (const q of QUESTIONS) {
    // Rotate the order each run so no version always goes first (warm-up effects).
    const order = versions.map((_, i) => versions[(i + run - 1) % versions.length]);
    for (const [version, options] of order) {
      let timings: Timings | undefined;
      let text = "";
      const searches: string[] = [];
      try {
        for await (const e of answer({
          planner, writer, search, question: q.question, options,
          plannerSystem: plannerPrompt(TIMEZONE), writerSystem: writerPrompt(TIMEZONE),
          onTimings: (t) => { timings = t; },
        })) {
          if (e.type === "text") text += e.text;
          if (e.type === "search") searches.push(e.query);
        }
      } catch (err) {
        if (isDailyQuota(err)) { console.log(`STOP: daily quota used up (${writerModel} or planner). Results so far are saved.`); break outer; }
        console.log(`${version} ${q.name}: ERROR ${err instanceof Error ? err.message.slice(0, 150) : err}`);
        continue;
      }
      const t = timings!;
      const missing = q.must.filter((re) => !re.test(text)).map(String);
      const row: Row = {
        version, question: q.name, run,
        firstTextMs: t.firstTextMs, planMs: sum(t.planMs), searchMs: sum(t.searchMs), totalMs: t.totalMs,
        searches, correct: missing.length === 0, missing, cited: /\[(?:n:)?\d/.test(text), answer: text,
      };
      rows.push(row);
      appendFileSync(rowsFile, JSON.stringify(row) + "\n");
      console.log(
        `${version.padEnd(12)} ${q.name.padEnd(9)} run ${run}  first word ${sec(row.firstTextMs)}  plan ${sec(row.planMs)}  search ${sec(row.searchMs)}  total ${sec(row.totalMs)}  ` +
        `${row.correct ? "correct" : `WRONG (missing ${missing.join(", ")})`}${row.cited ? "" : " NO CITATIONS"}  [${searches.length} searches]`,
      );
    }
  }
}

function sum(xs: number[]) { return xs.reduce((a, b) => a + b, 0); }
function sec(ms?: number) { return ms === undefined ? "  -  " : `${(ms / 1000).toFixed(1)}s`; }
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);

console.log("\nversion       avg first word   avg plan   avg search   avg total   correct   cited");
const summary = versions.map(([version]) => {
  const rs = rows.filter((r) => r.version === version);
  const s = {
    version, runs: rs.length,
    firstTextMs: avg(rs.map((r) => r.firstTextMs ?? NaN)), planMs: avg(rs.map((r) => r.planMs)),
    searchMs: avg(rs.map((r) => r.searchMs)), totalMs: avg(rs.map((r) => r.totalMs)),
    correct: `${rs.filter((r) => r.correct).length}/${rs.length}`, cited: `${rs.filter((r) => r.cited).length}/${rs.length}`,
  };
  console.log(`${version.padEnd(13)} ${sec(s.firstTextMs).padStart(14)}   ${sec(s.planMs).padStart(8)}   ${sec(s.searchMs).padStart(10)}   ${sec(s.totalMs).padStart(9)}   ${s.correct.padStart(7)}   ${s.cited.padStart(5)}`);
  return s;
});

const file = `evals/speed-${stamp}.json`;
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), writer: writerModel, planner: config.geminiFastModel, runs: RUNS, summary, rows }, null, 2));
console.log(`\nSaved ${file} (rows also in ${rowsFile})`);
