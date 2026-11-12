// Eval: does "find the right old chat" work when people word the question differently?
// 1. The fast AI writes 10 new wordings of each of the 3 assignment questions (saved, so the
//    same set can be re-run after changes). 2. Each wording goes through recall() against a
//    fixed pretend history. 3. Score + every miss is printed.
// Run: npm run eval:recall            (uses the saved wordings if they exist)
//      npm run eval:recall -- --new   (asks the AI for a fresh set)
//      add --file=evals/other.json to use / save a separate set
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, loadEnvFile, requireGeminiKey } from "../src/config.js";
import { Db } from "../src/db.js";
import { createGeminiModel, isQuotaOrBusy } from "../src/llm.js";
import { recall } from "../src/recall.js";

const WORDINGS_FILE = process.argv.find((a) => a.startsWith("--file="))?.slice(7) ?? "evals/recall-wordings.json";
const now = new Date("2026-11-12T03:00:00.000Z"); // Thursday 12 Nov 2026, 08:30 in India
const timezone = "Asia/Kolkata";

// The 3 assignment questions and which pretend chat each should find.
const QUESTIONS = [
  { key: "crm", expect: ["crm"], question: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?" },
  { key: "nov3", expect: ["postgres3"], question: "What did I ask you on 3 November? Is your answer still correct today?" },
  { key: "postgres", expect: ["postgres10", "postgres3"], question: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" },
];

interface Wordings { createdAt: string; model: string; sets: Record<string, string[]> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newWordings(): Promise<Wordings> {
  loadEnvFile();
  const config = loadConfig();
  const model = createGeminiModel(requireGeminiKey(config), config.geminiFastModel);
  const sets: Record<string, string[]> = {};
  for (const q of QUESTIONS) {
    const prompt = `Rewrite this chat question in 10 different ways a real person might type it to a chat assistant.
Keep the same meaning and the same point in time (today is Thursday 12 November 2026, so "Monday" = 9 November, "last Tuesday" = 10 November).
Vary them a lot: casual and formal, short and long, different words, some with small typos, some naming the date differently (weekday, date, "the 9th", "a few days ago"), some leaving details out.
Reply with JSON only: {"wordings": ["...", "..."]}

Question: ${q.question}`;
    for (let attempt = 0; ; attempt++) {
      try {
        let text = "";
        for await (const parts of model.stream({ system: "You write test data.", contents: [{ role: "user", parts: [{ text: prompt }] }], tools: false })) {
          for (const p of parts) if (p.text && !p.thought) text += p.text;
        }
        const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { wordings: string[] };
        sets[q.key] = json.wordings.filter((w) => typeof w === "string" && w.trim()).slice(0, 10);
        break;
      } catch (err) {
        if (attempt >= 4 || !(isQuotaOrBusy(err) || err instanceof SyntaxError)) throw err;
        await sleep(15_000);
      }
    }
  }
  return { createdAt: new Date().toISOString(), model: config.geminiFastModel, sets };
}

// The same pretend history as the recall tests.
function pretendHistory() {
  const db = new Db(":memory:");
  const user = db.createUser("asha").id;
  const ids: Record<string, number> = {};
  const past = (key: string, at: string, q: string, a: string, things: Array<[string, string]>) => {
    const c = db.createChat(user, q);
    ids[key] = c.id;
    db.addMessage(user, c.id, { role: "user", text: q, createdAt: at });
    const r = db.addMessage(user, c.id, { role: "assistant", text: a, createdAt: at });
    for (const [name, type] of things) {
      const t = db.findThingsByName(user, name)[0] ?? db.createThing(user, { name, type });
      db.addMention(user, { thingId: t.id, chatId: c.id, messageId: r.id, createdAt: at });
    }
  };
  past("postgres3", "2026-11-03T08:35:00.000Z", "What's the cheapest managed Postgres for a small startup?", "Neon Launch is $19/month; Supabase Pro is $25/month.", [["Neon", "Postgres hosting"], ["Supabase", "Postgres hosting"]]);
  past("crm", "2026-11-09T04:30:00.000Z", "Shortlist CRM tools for a 20-person sales team", "Shortlist: HubSpot, Pipedrive, Salesforce, Zoho CRM and Close.", [["HubSpot", "CRM"], ["Pipedrive", "CRM"], ["Salesforce", "CRM"], ["Zoho CRM", "CRM"], ["Close", "sales CRM"]]);
  past("nextjs", "2026-11-10T05:30:00.000Z", "What's new in Next.js 16?", "Next.js 16 adds caching changes.", [["Next.js", "web framework"]]);
  past("postgres10", "2026-11-10T10:30:00.000Z", "Which Postgres hosts support branching?", "Neon supports branching.", [["Neon", "Postgres hosting"]]);
  return { db, user, ids };
}

const fresh = process.argv.includes("--new");
let wordings: Wordings;
if (!fresh && existsSync(WORDINGS_FILE)) {
  wordings = JSON.parse(readFileSync(WORDINGS_FILE, "utf8")) as Wordings;
  console.log(`Using saved wordings from ${WORDINGS_FILE} (${wordings.createdAt}, ${wordings.model})\n`);
} else {
  wordings = await newWordings();
  mkdirSync("evals", { recursive: true });
  writeFileSync(WORDINGS_FILE, JSON.stringify(wordings, null, 2));
  console.log(`Saved new wordings to ${WORDINGS_FILE}\n`);
}

const { db, user, ids } = pretendHistory();
const name = (id: number) => Object.keys(ids).find((k) => ids[k] === id) ?? `chat ${id}`;
let total = 0;
let passed = 0;
const misses: string[] = [];

for (const q of QUESTIONS) {
  const set = wordings.sets[q.key] ?? [];
  let ok = 0;
  console.log(`=== ${q.question}`);
  for (const w of set) {
    const r = recall(db, user, w, { now, timezone });
    const first = r?.status === "found" ? name(r.chats[0].chat.id) : undefined;
    const pass = first !== undefined && q.expect.includes(first);
    const got = !r ? "not seen as a memory question" : r.status === "none" ? `nothing found (${r.reason})` : r.chats.map((c) => name(c.chat.id)).join(", ");
    console.log(`${pass ? "✅" : "❌"} ${w}\n     → ${got}${r?.range ? `   [dates: ${r.range.label}]` : ""}`);
    if (pass) ok++;
    else misses.push(`${w}  →  ${got}`);
  }
  console.log(`   ${ok}/${set.length}\n`);
  total += set.length;
  passed += ok;
}
console.log(`TOTAL: ${passed}/${total} found the right chat`);
db.close();
