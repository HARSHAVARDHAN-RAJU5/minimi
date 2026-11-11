import { existsSync } from "node:fs";
import type { SearchMode } from "./context.js";

export interface Config {
  geminiApiKey?: string;
  geminiModel: string; // answers (smart)
  geminiFastModel: string; // background chores (fast)
  exaApiKey?: string; // main web search
  tavilyApiKey?: string; // backup web search
  searchMode: SearchMode; // who builds the searches: code first (AI planner as backup), or always the AI planner
  port: number;
  dbPath: string; // where chats are saved
}

export const DEFAULT_MODEL = "gemini-3.8-flash";
export const DEFAULT_FAST_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_PORT = 3000;
export const DEFAULT_DB_PATH = "data/minimi.db";

// Empty strings in .env count as "not set".
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portText = read(env, "PORT");
  const port = portText ? Number(portText) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a number between 1 and 65535, got "${portText}"`);
  }
  return {
    geminiApiKey: read(env, "GEMINI_API_KEY"),
    geminiModel: read(env, "GEMINI_MODEL") ?? DEFAULT_MODEL,
    geminiFastModel: read(env, "GEMINI_FAST_MODEL") ?? DEFAULT_FAST_MODEL,
    exaApiKey: read(env, "EXA_API_KEY"),
    tavilyApiKey: read(env, "TAVILY_API_KEY"),
    searchMode: readSearchMode(read(env, "SEARCH_MODE")),
    port,
    dbPath: read(env, "DB_PATH") ?? DEFAULT_DB_PATH,
  };
}

function readSearchMode(value?: string): SearchMode {
  if (!value || value === "code-first") return "code-first";
  if (value === "planner") return "planner";
  throw new Error(`SEARCH_MODE must be "code-first" or "planner", got "${value}"`);
}

// The server can start without keys (so the page loads), but chatting needs them.
export function requireGeminiKey(config: Config): string {
  if (!config.geminiApiKey) {
    throw new Error("Add GEMINI_API_KEY to .env (copy .env.example to .env first).");
  }
  return config.geminiApiKey;
}

// Keys that are missing for chat to work. Search needs Exa or Tavily (Exa preferred).
export function missingKeys(config: Config): string[] {
  const missing: string[] = [];
  if (!config.geminiApiKey) missing.push("GEMINI_API_KEY");
  if (!config.exaApiKey && !config.tavilyApiKey) missing.push("EXA_API_KEY");
  return missing;
}

// Load .env into process.env if the file exists (built into Node, no extra library).
export function loadEnvFile(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
