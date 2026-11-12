import { createAgent } from "./agent.js";
import { createApp } from "./app.js";
import type { RememberFn } from "./chats.js";
import { loadConfig, loadEnvFile, missingKeys } from "./config.js";
import { Db } from "./db.js";
import { rememberAnswer } from "./extract.js";
import { createGeminiModel } from "./llm.js";
import { CARD_WRITER_PROMPT } from "./prompts.js";

loadEnvFile();
const config = loadConfig();
const db = new Db(config.dbPath); // data/minimi.db by default, created on first run

// After each finished answer: the fast model writes memory cards in the background.
const cardWriter = config.geminiApiKey ? createGeminiModel(config.geminiApiKey, config.geminiFastModel) : undefined;
const remember: RememberFn | undefined = cardWriter
  ? (job) => { void rememberAnswer({ db, model: cardWriter, system: CARD_WRITER_PROMPT, ...job, log: console.log }); }
  : undefined;

createApp({ chat: createAgent(config, console.log, db), db, remember }).listen(config.port, () => {
  console.log(`minimi agent running at http://localhost:${config.port}`);
  const missing = missingKeys(config);
  if (missing.length) {
    console.warn(`Warning: ${missing.join(" and ")} not set. Copy .env.example to .env and add your keys to chat.`);
  }
});
