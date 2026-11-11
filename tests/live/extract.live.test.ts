// Live test: a real answer (real search + real Gemini), then the real card writer on it.
// Needs keys in .env. Run with `npm run test:live`.
import { describe, it, expect } from "vitest";
import { loadConfig, loadEnvFile } from "../../src/config.js";
import { Db } from "../../src/db.js";
import { askForCards, checkCards, parseCardsJson, saveCards } from "../../src/extract.js";
import { answer, createGeminiModel, type Source } from "../../src/llm.js";
import { CARD_WRITER_PROMPT, plannerPrompt, writerPrompt } from "../../src/prompts.js";
import { webSearchFromConfig } from "../../src/search.js";

loadEnvFile();
const config = loadConfig();
const hasKeys = Boolean(config.geminiApiKey && (config.exaApiKey || config.tavilyApiKey));

describe.skipIf(!hasKeys)("live card writer", () => {
  it("turns a real answer into checked cards and saves them", async () => {
    const lite = createGeminiModel(config.geminiApiKey!, config.geminiFastModel);
    const question = "Compare Neon and Supabase pricing";

    let text = "";
    let sources: Source[] = [];
    for await (const e of answer({
      planner: lite, writer: lite, search: webSearchFromConfig(config), question,
      plannerSystem: plannerPrompt("Asia/Kolkata"), writerSystem: writerPrompt("Asia/Kolkata"),
      options: { presetQueries: ["Neon pricing 2026", "Supabase pricing 2026"], withNote: true },
    })) {
      if (e.type === "text") text += e.text;
      if (e.type === "sources") sources = e.sources;
    }

    const start = performance.now();
    const rawText = await askForCards(lite, CARD_WRITER_PROMPT, { question, answer: text, sources });
    const ms = Math.round(performance.now() - start);
    const raw = parseCardsJson(rawText);
    const { cards, dropped } = checkCards(raw, { question, answer: text, sources });

    console.log(`card writer took ${ms} ms`);
    for (const c of cards) {
      console.log(`THING ${c.name} | ${c.type ?? "-"} | ${c.website ?? "-"} | aka ${c.aliases.join(", ") || "-"}`);
      for (const f of c.facts) console.log(`   FACT ${f.field} = ${f.value}  (${f.sourceUrl})`);
    }
    for (const d of dropped) console.log(`DROPPED ${d.what}: ${d.why}`);

    expect(raw).toBeDefined();
    const names = cards.map((c) => c.name.toLowerCase());
    expect(names).toContain("neon");
    expect(names).toContain("supabase");
    expect(cards.flatMap((c) => c.facts).length).toBeGreaterThan(0);

    const db = new Db(":memory:");
    const user = db.createUser("live").id;
    const chat = db.createChat(user, question).id;
    const saved = saveCards(db, user, { chatId: chat }, cards);
    console.log(`saved: ${JSON.stringify(saved)}`);
    expect(saved.things).toBeGreaterThanOrEqual(2);
    db.close();
  });
});
