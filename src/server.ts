import { createApp } from "./app.js";
import { loadConfig, loadEnvFile, missingKeys } from "./config.js";

loadEnvFile();
const config = loadConfig();

createApp().listen(config.port, () => {
  console.log(`minimi agent running at http://localhost:${config.port}`);
  const missing = missingKeys(config);
  if (missing.length) {
    console.warn(`Warning: ${missing.join(" and ")} not set. Copy .env.example to .env and add your keys to chat.`);
  }
});
