import { describe, it, expect } from "vitest";
import { loadConfig, requireGeminiKey, DEFAULT_MODEL, DEFAULT_PORT } from "../src/config.js";

describe("config", () => {
  it("uses defaults when nothing is set", () => {
    const config = loadConfig({});
    expect(config.geminiModel).toBe(DEFAULT_MODEL);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.geminiApiKey).toBeUndefined();
    expect(config.tavilyApiKey).toBeUndefined();
  });

  it("treats empty values as not set", () => {
    const config = loadConfig({ GEMINI_API_KEY: "  ", GEMINI_MODEL: "", PORT: "" });
    expect(config.geminiApiKey).toBeUndefined();
    expect(config.geminiModel).toBe(DEFAULT_MODEL);
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it("reads values that are set", () => {
    const config = loadConfig({ GEMINI_API_KEY: "abc", GEMINI_MODEL: "gemini-x", TAVILY_API_KEY: "t", PORT: "4000" });
    expect(config).toEqual({ geminiApiKey: "abc", geminiModel: "gemini-x", tavilyApiKey: "t", port: 4000 });
  });

  it("rejects a bad port", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT must be a number/);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(/PORT must be a number/);
  });

  it("gives a clear message when the Gemini key is missing", () => {
    expect(() => requireGeminiKey(loadConfig({}))).toThrow("Add GEMINI_API_KEY to .env");
    expect(requireGeminiKey(loadConfig({ GEMINI_API_KEY: "abc" }))).toBe("abc");
  });
});
