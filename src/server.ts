import { createApp } from "./app.js";
import { loadConfig, loadEnvFile } from "./config.js";

loadEnvFile();
const config = loadConfig();

createApp().listen(config.port, () => {
  console.log(`minimi agent running at http://localhost:${config.port}`);
  if (!config.geminiApiKey) {
    console.warn("Warning: GEMINI_API_KEY is not set. Copy .env.example to .env and add your key to chat.");
  }
});
