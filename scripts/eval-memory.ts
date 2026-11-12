// Eval: does memory work for DIFFERENT kinds of memory questions (not just the 3 assignment ones)?
// A richer pretend history (10 chats over 3 weeks) + 10 kinds of question. For each kind the fast AI
// writes 3 questions about a given old chat (saved, so the same set can be re-run). Each question goes
// through recall(); the score per kind shows what works and what doesn't.
// Run: npm run eval:memory            (uses saved questions if they exist)
//      npm run eval:memory -- --new   (asks the AI for a fresh set)
//      npm run eval:memory -- --listener   (the new way: listener form → code, like the agent does)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, loadEnvFile, requireGeminiKey } from "../src/config.js";
import { Db } from "../src/db.js";
import { saveCards } from "../src/extract.js";
import { chooseSearchPath, isSmallTalk } from "../src/context.js";
import { understand } from "../src/listener.js";
import { createGeminiModel, isQuotaOrBusy } from "../src/llm.js";
import { updateLoops } from "../src/loops.js";
import { lookupMemory } from "../src/memoryroute.js";
import { namedThings, oldFactsFor } from "../src/stilltrue.js";
import { isMemoryQuestion, recall, type Recall } from "../src/recall.js";

const FILE = "evals/memory-questions.json";
const now = new Date("2026-11-12T03:00:00.000Z"); // Thursday 12 Nov 2026, 08:30 in India
const timezone = "Asia/Kolkata";
const at = (day: string, time: string) => new Date(`${day}T${time}:00+05:30`).toISOString();

// The pretend history.
const HISTORY = [
  { key: "stripe", at: at("2026-10-21", "11:00"), q: "What are Stripe's card fees in India?", a: "Stripe charges 2% for domestic cards in India and 3% for international cards.", things: [{ name: "Stripe", type: "payments", facts: [["India domestic card fee", "2%"]] }] },
  { key: "budget", at: at("2026-10-27", "15:00"), q: "Our tooling budget is $500/month for a 20-person team. What should we prioritise?", a: "With $500/month for 20 people, prioritise a CRM first, then analytics.", things: [] },
  { key: "vercel", at: at("2026-10-29", "10:00"), q: "How much does Vercel Pro cost per member?", a: "Vercel Pro is $20 per member per month.", things: [{ name: "Vercel", type: "web hosting", facts: [["Pro price", "$20/member/month"]] }] },
  { key: "postgres3", at: at("2026-11-03", "14:05"), q: "What's the cheapest managed Postgres for a small startup?", a: "Render $6/month, Neon $19/month, Supabase $25/month.", things: [{ name: "Render", type: "Postgres hosting", facts: [["Basic price", "$6/month"]] }, { name: "Neon", type: "Postgres hosting", facts: [["Launch price", "$19/month"]] }, { name: "Supabase", type: "Postgres hosting", facts: [["Pro price", "$25/month"]] }] },
  { key: "linear", at: at("2026-11-05", "09:30"), q: "Does Linear's Business plan include SSO?", a: "Yes, Linear Business includes SAML SSO.", things: [{ name: "Linear", type: "issue tracker" }] },
  { key: "crm", at: at("2026-11-09", "10:00"), q: "Shortlist CRM tools for a 20-person sales team", a: "HubSpot $20/seat, Pipedrive $14, Salesforce $25, Zoho CRM $14, Close $35.", things: [{ name: "HubSpot", type: "CRM", facts: [["Starter price", "$20/seat/month"]] }, { name: "Pipedrive", type: "CRM" }, { name: "Salesforce", type: "CRM" }, { name: "Zoho CRM", type: "CRM" }, { name: "Close", type: "CRM" }] },
  { key: "nextjs", at: at("2026-11-10", "11:00"), q: "What's new in Next.js 16?", a: "Next.js 16 adds faster builds and clearer caching.", things: [{ name: "Next.js", type: "web framework" }] },
  { key: "postgres10", at: at("2026-11-10", "16:00"), q: "Compare Postgres hosting prices: Neon vs Supabase vs Railway", a: "Railway $5, Neon $19, Supabase $25.", things: [{ name: "Neon", type: "Postgres hosting" }, { name: "Supabase", type: "Postgres hosting" }, { name: "Railway", type: "Postgres hosting", facts: [["Hobby price", "$5/month"]] }] },
  { key: "decision", at: at("2026-11-11", "12:00"), q: "We went with Pipedrive because it's cheaper. How do I import contacts?", a: "Use Pipedrive's CSV importer.", things: [{ name: "Pipedrive", type: "CRM" }] },
  { key: "team", at: at("2026-11-11", "18:00"), q: "We're hiring 5 more reps next month, so we'll be 25. Does Pipedrive get cheaper at 25 seats?", a: "Pipedrive has no volume discount at 25 seats.", things: [{ name: "Pipedrive", type: "CRM" }] },
];

// Kinds of memory question. target: the chat that should be found ("none" = nothing should be).
const KINDS = [
  { kind: "date only", target: "linear", how: "ask what they asked on that day, giving only the date (no topic)" },
  { kind: "name, no date", target: "vercel", how: "ask whether what you said about the product is still true, naming the product but no date" },
  { kind: "kind + relative date", target: "postgres3", how: "refer to the topic by its kind (e.g. 'database hosting options') plus a relative date like 'last week' or 'about 9 days ago'" },
  { kind: "this month / in October", target: "stripe", how: "refer to the time as 'in October' or 'last month', plus the topic" },
  { kind: "my last question", target: "team", how: "ask about 'my last question' or 'what I asked most recently', without a date or topic" },
  { kind: "facts about me", target: "budget", how: "ask what their own budget was, as if they forgot (no date)" },
  { kind: "what did we decide", target: "decision", how: "ask which option they picked or decided on, without a date" },
  { kind: "still correct?", target: "stripe", how: "ask if what you told them about the fees is still correct, naming the product" },
  { kind: "synonyms", target: "crm", how: "refer to it with different words (e.g. 'sales software', 'customer tools') and the day 'Monday'" },
  { kind: "never discussed", target: "none", how: "ask about something they NEVER discussed (e.g. Kubernetes or Figma) as if they had, with a date like 'last Thursday'" },
] as const;

interface Saved { createdAt: string; model: string; sets: Record<string, string[]> }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function writeQuestions(): Promise<Saved> {
  loadEnvFile();
  const config = loadConfig();
  const model = createGeminiModel(requireGeminiKey(config), config.geminiFastModel);
  const sets: Record<string, string[]> = {};
  const history = HISTORY.map((h) => `- ${new Date(h.at).toLocaleString("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}: user asked "${h.q}"`).join("\n");
  for (const k of KINDS) {
    const target = HISTORY.find((h) => h.key === k.target);
    const prompt = `Today is Thursday 12 November 2026. A user chatted with an assistant earlier:\n${history}\n\n` +
      (target ? `Write 3 different questions the user might ask now about the chat on ${new Date(target.at).toLocaleDateString("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" })} ("${target.q}"). ` : "Write 3 different questions. ") +
      `Style: ${k.how}. Vary the wording; keep each one natural and short.\nReply with JSON only: {"questions": ["...", "...", "..."]}`;
    for (let attempt = 0; ; attempt++) {
      try {
        let text = "";
        for await (const parts of model.stream({ system: "You write test data.", contents: [{ role: "user", parts: [{ text: prompt }] }], tools: false })) {
          for (const p of parts) if (p.text && !p.thought) text += p.text;
        }
        sets[k.kind] = (JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { questions: string[] }).questions.slice(0, 3);
        break;
      } catch (err) {
        if (attempt >= 4 || !(isQuotaOrBusy(err) || err instanceof SyntaxError)) throw err;
        await sleep(15_000);
      }
    }
  }
  return { createdAt: new Date().toISOString(), model: config.geminiFastModel, sets };
}

let saved: Saved;
if (!process.argv.includes("--new") && existsSync(FILE)) {
  saved = JSON.parse(readFileSync(FILE, "utf8")) as Saved;
  console.log(`Using saved questions from ${FILE}\n`);
} else {
  saved = await writeQuestions();
  mkdirSync("evals", { recursive: true });
  writeFileSync(FILE, JSON.stringify(saved, null, 2));
  console.log(`Saved new questions to ${FILE}\n`);
}

// Build the history the same way the app saves chats.
const db = new Db(":memory:");
const user = db.createUser("asha").id;
const ids: Record<string, number> = {};
for (const h of HISTORY) {
  const chat = db.createChat(user, h.q, { createdAt: h.at });
  ids[h.key] = chat.id;
  db.addMessage(user, chat.id, { role: "user", text: h.q, createdAt: h.at, timezone });
  const reply = db.addMessage(user, chat.id, { role: "assistant", text: h.a, createdAt: h.at, timezone });
  saveCards(db, user, { chatId: chat.id, messageId: reply.id, at: h.at }, h.things.map((t) => ({
    name: t.name, type: t.type, aliases: [], facts: (t.facts ?? []).map(([field, value]) => ({ field, value, sourceUrl: "https://example.com" })),
  })));
  updateLoops(db, user, { chatId: chat.id, question: h.q, things: h.things.map((t) => t.name), at: h.at });
}
const keyOf = (id: number) => Object.keys(ids).find((k) => ids[k] === id) ?? `chat ${id}`;

const useListener = process.argv.includes("--listener");
loadEnvFile();
const cfg = loadConfig();
const listener = useListener ? createGeminiModel(requireGeminiKey(cfg), cfg.geminiFastModel) : undefined;
const recallPass = (target: string, r: Recall | undefined) => target === "none"
  ? !r || r.status === "none" || (r.hasTopic && !r.topicMatched)
  : r?.status === "found" && keyOf(r.chats[0].chat.id) === target;
const recallText = (r: Recall | undefined) => (!r ? "not a memory question" : r.status === "none" ? "nothing found" : r.chats.map((c) => keyOf(c.chat.id)).join(", "))
  + (r?.range ? `   [dates: ${r.range.label}]` : "") + (r && !r.topicMatched && r.hasTopic ? "  (topic not matched)" : "");

// One question, the way the agent handles it. Returns pass + what happened.
async function check(target: string, q: string): Promise<{ pass: boolean; got: string }> {
  if (!listener) {
    const r = recall(db, user, q, { now, timezone });
    return { pass: recallPass(target, r), got: recallText(r) };
  }
  const obvious = isSmallTalk(q) || (!isMemoryQuestion(q, undefined, timezone) && chooseSearchPath(q, undefined, "code-first").path === "code" && namedThings(db, user, q).length === 0);
  let heard: Awaited<ReturnType<typeof understand>> = { ms: 0 };
  for (let attempt = 0; !obvious; attempt++) {
    heard = await understand(listener, { question: q, timezone, now }, 15_000);
    if (heard.understanding || attempt >= 3 || !/busy|quota|429|503|overload|reply in/i.test(heard.problem ?? "")) break;
    await sleep(10_000);
  }
  const u = heard.understanding;
  if (!u || u.type !== "memory") {
    // Old way (listener skipped, failed, or said "not memory"): the agent only recalls if the old rule sees memory.
    const why = obvious ? "skipped (obvious)" : u ? `listener said ${u.type}` : `listener failed (${heard.problem})`;
    // A new/follow-up form: the agent still adds the "still true?" check (old values of named products).
    if (u) {
      const facts = oldFactsFor(db, user, `${q} ${u.products.join(" ")}`, now);
      const targetThings = (HISTORY.find((h) => h.key === target)?.things ?? []).map((t) => t.name);
      const pass = facts.some((f) => targetThings.includes(f.thing));
      return { pass, got: `${why} → still-true check: ${facts.map((f) => `${f.thing} ${f.field} ${f.value}`).join("; ") || "no old facts"}` };
    }
    const r = isMemoryQuestion(q, undefined, timezone) ? recall(db, user, q, { now, timezone }) : undefined;
    return { pass: recallPass(target, r), got: `${why} → old way: ${recallText(r)}` };
  }
  const lm = lookupMemory(db, user, q, u, { now, timezone });
  const form = `[${u.lookingFor || "-"}${u.when ? ` when="${u.when}"` : ""}${u.topic ? ` topic="${u.topic}"` : ""}${u.products.length ? ` products=${u.products.join("/")}` : ""}]`;
  if (u.lookingFor === "decision" && !lm.recall) {
    const pass = target === "decision" ? lm.decisions.some((d) => d.choice === "Pipedrive") : target === "none" ? lm.decisions.length === 0 : false;
    return { pass, got: `${form} decisions: ${lm.decisions.map((d) => d.choice).join(", ") || "none"}` };
  }
  const r = lm.recall;
  // "never discussed" also passes if code honestly finds no matching chat for a named product.
  return { pass: recallPass(target, r), got: `${form} ${recallText(r)}${lm.searches.length ? `  search: ${lm.searches.join(" | ")}` : ""}` };
}

let total = 0;
let passed = 0;
const rows: string[] = [];
console.log(useListener ? "MODE: listener → code (the new way)\n" : "MODE: recall only (the old way)\n");
for (const k of KINDS) {
  const qs = saved.sets[k.kind] ?? [];
  let ok = 0;
  console.log(`=== ${k.kind} (should find: ${k.target})`);
  for (const q of qs) {
    const { pass, got } = await check(k.target, q);
    if (pass) ok++;
    console.log(`${pass ? "✅" : "❌"} ${q}
     → ${got}`);
  }
  console.log(`   ${ok}/${qs.length}\n`);
  rows.push(`${k.kind.padEnd(24)} ${ok}/${qs.length}`);
  total += qs.length;
  passed += ok;
}
console.log("SUMMARY");
for (const r of rows) console.log(`  ${r}`);
console.log(`TOTAL: ${passed}/${total}`);
db.close();
