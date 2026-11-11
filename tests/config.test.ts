import { describe, it, expect } from "vitest";
import { loadConfig, requireGeminiKey, missingKeys, DEFAULT_MODEL, DEFAULT_FAST_MODEL, DEFAULT_PORT } from "../src/config.js";

describe("config", () => {
  it("uses defaults when nothing is set", () => {
    const config = loadConfig({});
    expect(config.geminiModel).toBe(DEFAULT_MODEL);
    expect(config.geminiFastModel).toBe(DEFAULT_FAST_MODEL);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.geminiApiKey).toBeUndefined();
    expect(config.exaApiKey).toBeUndefined();
    expect(config.tavilyApiKey).toBeUndefined();
  });

  it("treats empty values as not set", () => {
    const config = loadConfig({ GEMINI_API_KEY: "  ", GEMINI_MODEL: "", EXA_API_KEY: "", PORT: "" });
    expect(config.geminiApiKey).toBeUndefined();
    expect(config.exaApiKey).toBeUndefined();
    expect(config.geminiModel).toBe(DEFAULT_MODEL);
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it("reads values that are set", () => {
    const config = loadConfig({
      GEMINI_API_KEY: "g", GEMINI_MODEL: "m1", GEMINI_FAST_MODEL: "m2",
      EXA_API_KEY: "e", TAVILY_API_KEY: "t", PORT: "4000",
    });
    expect(config).toEqual({
      geminiApiKey: "g", geminiModel: "m1", geminiFastModel: "m2",
      exaApiKey: "e", tavilyApiKey: "t", searchMode: "code-first", port: 4000,
    });
  });

  it("reads SEARCH_MODE and rejects unknown values", () => {
    expect(loadConfig({}).searchMode).toBe("code-first");
    expect(loadConfig({ SEARCH_MODE: "planner" }).searchMode).toBe("planner");
    expect(() => loadConfig({ SEARCH_MODE: "magic" })).toThrow('SEARCH_MODE must be "code-first" or "planner"');
  });

  it("rejects a bad port", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT must be a number/);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(/PORT must be a number/);
  });

  it("gives a clear message when the Gemini key is missing", () => {
    expect(() => requireGeminiKey(loadConfig({}))).toThrow("Add GEMINI_API_KEY to .env");
    expect(requireGeminiKey(loadConfig({ GEMINI_API_KEY: "abc" }))).toBe("abc");
  });

  it("lists missing keys; Tavily alone is enough for search", () => {
    expect(missingKeys(loadConfig({}))).toEqual(["GEMINI_API_KEY", "EXA_API_KEY"]);
    expect(missingKeys(loadConfig({ GEMINI_API_KEY: "g", EXA_API_KEY: "e" }))).toEqual([]);
    expect(missingKeys(loadConfig({ GEMINI_API_KEY: "g", TAVILY_API_KEY: "t" }))).toEqual([]);
  });
});
