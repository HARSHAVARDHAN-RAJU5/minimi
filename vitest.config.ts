import { defineConfig } from "vitest/config";

// Two kinds of tests:
// - unit: quick, offline, fake Gemini/search (npm test)
// - live: real Gemini/Exa/Tavily, needs keys in .env (npm run test:live)
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/**/*.test.ts"], exclude: ["tests/live/**"] } },
      { test: { name: "live", include: ["tests/live/**/*.test.ts"], testTimeout: 60_000 } },
    ],
  },
});
