// Live tests: real searches, need keys in .env. Run with `npm run test:live`.
// Each test is skipped if its key is missing.
import { describe, it, expect } from "vitest";
import { loadConfig, loadEnvFile } from "../../src/config.js";
import { createExa, createTavily } from "../../src/search.js";

loadEnvFile();
const config = loadConfig();

describe("live search", () => {
  it.skipIf(!config.exaApiKey)("Exa returns real results with links", async () => {
    const results = await createExa(config.exaApiKey!)("Neon Postgres pricing");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).toMatch(/^https?:\/\//);
    expect(results[0].content.length).toBeGreaterThan(0);
  });

  it.skipIf(!config.tavilyApiKey)("Tavily returns real results with links", async () => {
    const results = await createTavily(config.tavilyApiKey!)("Neon Postgres pricing");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).toMatch(/^https?:\/\//);
  });
});
