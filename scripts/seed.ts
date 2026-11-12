// Pretend past chats for testing memory questions. Every seeded chat is marked "seed" and can be
// removed in one go; real chats are never touched. Dates are relative to today, so "on Monday" and
// "last Tuesday" match whenever this is run.
// Run: npm run seed                    (user "demo", in DB_PATH or data/minimi.db)
//      npm run seed -- --user=Asha     (another user)
//      npm run seed:clear [-- --user=Asha]
import { loadConfig, loadEnvFile } from "../src/config.js";
import { findDateRange } from "../src/dates.js";
import { Db } from "../src/db.js";
import { saveCards, type ThingCard } from "../src/extract.js";
import { updateLoops } from "../src/loops.js";
import type { Source } from "../src/llm.js";
import { findOrCreateUser } from "../src/users.js";

loadEnvFile();
const config = loadConfig();
const args = process.argv.slice(2);
const userName = args.find((a) => a.startsWith("--user="))?.slice(7) || "demo";
const clearOnly = args.includes("--clear");
const timezone = args.find((a) => a.startsWith("--tz="))?.slice(5) || Intl.DateTimeFormat().resolvedOptions().timeZone;

const db = new Db(config.dbPath);
const user = findOrCreateUser(db, userName).user;
const removed = db.clearSeed(user.id);
if (removed) console.log(`Removed ${removed} old seed chats for "${user.name}".`);
if (clearOnly) {
  db.close();
  process.exit(0);
}

// A time on a day described in words ("on Monday", "on 3 November"), in the user's time zone.
const now = new Date();
function at(dayWords: string, hours: number, minutes = 0): string {
  const day = findDateRange(dayWords, now, timezone);
  if (!day) throw new Error(`can't read "${dayWords}"`);
  const t = Math.min(Date.parse(day.from) + (hours * 60 + minutes) * 60_000, now.getTime() - 60 * 60_000); // never in the future
  return new Date(t).toISOString();
}

interface SeedChat { at: string; question: string; answer: string; sources: Source[]; cards: ThingCard[]; topic: string }

const src = (n: number, title: string, url: string): Source => ({ n, title, url });
const fact = (field: string, value: string, sourceUrl: string) => ({ field, value, sourceUrl });

const chats: SeedChat[] = [
  {
    at: at("on 3 November", 14, 5),
    question: "What's the cheapest managed Postgres for a small startup?",
    answer: "For a small startup, Render is cheapest to start, Neon is best value as you grow:\n\n| Host | Plan | Price |\n|---|---|---|\n| Render | Basic | $6/month [3] |\n| Neon | Launch | $19/month [1] |\n| Supabase | Pro | $25/month [2] |",
    sources: [src(1, "Neon pricing", "https://neon.tech/pricing"), src(2, "Supabase pricing", "https://supabase.com/pricing"), src(3, "Render pricing", "https://render.com/pricing")],
    cards: [
      { name: "Neon", type: "Postgres hosting", website: "neon.tech", aliases: [], facts: [fact("Launch plan price", "$19/month", "https://neon.tech/pricing")] },
      { name: "Supabase", type: "Postgres hosting", website: "supabase.com", aliases: [], facts: [fact("Pro plan price", "$25/month", "https://supabase.com/pricing")] },
      { name: "Render", type: "Postgres hosting", website: "render.com", aliases: [], facts: [fact("Basic Postgres price", "$6/month", "https://render.com/pricing")] },
    ],
    topic: "pricing",
  },
  {
    at: at("on Monday", 10, 0),
    question: "Shortlist CRM tools for a 20-person sales team",
    answer: "Here's a shortlist of 5 CRMs for a 20-person sales team:\n\n| CRM | Entry plan | Price per user |\n|---|---|---|\n| HubSpot | Sales Hub Starter | $20/seat/month [1] |\n| Pipedrive | Lite | $14/user/month [2] |\n| Salesforce | Starter Suite | $25/user/month [3] |\n| Zoho CRM | Standard | $14/user/month [4] |\n| Close | Essentials | $35/user/month [5] |",
    sources: [
      src(1, "HubSpot pricing", "https://www.hubspot.com/pricing/sales"), src(2, "Pipedrive pricing", "https://www.pipedrive.com/en/pricing"),
      src(3, "Salesforce pricing", "https://www.salesforce.com/sales/pricing/"), src(4, "Zoho CRM pricing", "https://www.zoho.com/crm/zohocrm-pricing.html"),
      src(5, "Close pricing", "https://www.close.com/pricing"),
    ],
    cards: [
      { name: "HubSpot", type: "CRM", website: "hubspot.com", aliases: [], facts: [fact("Sales Hub Starter price", "$20/seat/month", "https://www.hubspot.com/pricing/sales")] },
      { name: "Pipedrive", type: "CRM", website: "pipedrive.com", aliases: [], facts: [fact("Lite plan price", "$14/user/month", "https://www.pipedrive.com/en/pricing")] },
      { name: "Salesforce", type: "CRM", website: "salesforce.com", aliases: [], facts: [fact("Starter Suite price", "$25/user/month", "https://www.salesforce.com/sales/pricing/")] },
      { name: "Zoho CRM", type: "CRM", website: "zoho.com", aliases: [], facts: [fact("Standard plan price", "$14/user/month", "https://www.zoho.com/crm/zohocrm-pricing.html")] },
      { name: "Close", type: "CRM", website: "close.com", aliases: [], facts: [fact("Essentials plan price", "$35/user/month", "https://www.close.com/pricing")] },
    ],
    topic: "pricing",
  },
  {
    at: at("last Tuesday", 11, 0),
    question: "What's new in Next.js 16?",
    answer: "Next.js 16 focuses on faster builds and clearer caching [1].",
    sources: [src(1, "Next.js blog", "https://nextjs.org/blog")],
    cards: [{ name: "Next.js", type: "web framework", website: "nextjs.org", aliases: [], facts: [] }],
    topic: "new features",
  },
  {
    at: at("last Tuesday", 16, 0),
    question: "Compare Postgres hosting prices: Neon vs Supabase vs Railway",
    answer: "Railway is cheapest for hobby use, Neon and Supabase for production:\n\n| Host | Plan | Price |\n|---|---|---|\n| Railway | Hobby | $5/month [3] |\n| Neon | Launch | $19/month [1] |\n| Supabase | Pro | $25/month [2] |",
    sources: [src(1, "Neon pricing", "https://neon.tech/pricing"), src(2, "Supabase pricing", "https://supabase.com/pricing"), src(3, "Railway pricing", "https://railway.com/pricing")],
    cards: [
      { name: "Neon", type: "Postgres hosting", website: "neon.tech", aliases: [], facts: [fact("Launch plan price", "$19/month", "https://neon.tech/pricing")] },
      { name: "Supabase", type: "Postgres hosting", website: "supabase.com", aliases: [], facts: [fact("Pro plan price", "$25/month", "https://supabase.com/pricing")] },
      { name: "Railway", type: "Postgres hosting", website: "railway.com", aliases: [], facts: [fact("Hobby plan price", "$5/month", "https://railway.com/pricing")] },
    ],
    topic: "pricing",
  },
];

// Saved through the same steps as real chats: chat → question → answer → memory cards.
for (const c of chats.sort((a, b) => a.at.localeCompare(b.at))) {
  const chat = db.createChat(user.id, c.question, { seed: true, createdAt: c.at });
  db.addMessage(user.id, chat.id, { role: "user", text: c.question, timezone, createdAt: c.at });
  const reply = db.addMessage(user.id, chat.id, {
    role: "assistant", text: c.answer, sources: c.sources, searches: c.cards.map((t) => `${t.name} ${c.topic}`), timezone, createdAt: c.at,
  });
  const saved = saveCards(db, user.id, { chatId: chat.id, messageId: reply.id, at: c.at }, c.cards);
  db.setChatNote(user.id, chat.id, { things: c.cards.map((t) => t.name), topic: c.topic });
  const loop = updateLoops(db, user.id, { chatId: chat.id, question: c.question, things: c.cards.map((t) => t.name), at: c.at });
  const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(c.at));
  const loopNote = loop.opened ? `, loop opened` : loop.updated ? `, loop extended` : "";
  console.log(`seeded  ${when.padEnd(18)} "${c.question}"  (${saved.things} things, ${saved.facts} facts${loopNote})`);
}
console.log(`\nDone: ${chats.length} seed chats for user "${user.name}" (time zone ${timezone}) in ${config.dbPath}.`);
console.log(`Remove them with: npm run seed:clear${userName !== "demo" ? ` -- --user=${userName}` : ""}`);
db.close();
