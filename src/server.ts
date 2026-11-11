import { createAgent } from "./agent.js";
import { createApp } from "./app.js";
import { loadConfig, loadEnvFile, missingKeys } from "./config.js";
import { Db } from "./db.js";

loadEnvFile();
const config = loadConfig();
const db = new Db(config.dbPath); // data/minimi.db by default, created on first run

createApp({ chat: createAgent(config, console.log, db), db }).listen(config.port, () => {
  console.log(`minimi agent running at http://localhost:${config.port}`);
  const missing = missingKeys(config);
  if (missing.length) {
    console.warn(`Warning: ${missing.join(" and ")} not set. Copy .env.example to .env and add your keys to chat.`);
  }
});
