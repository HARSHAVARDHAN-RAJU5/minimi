import { existsSync } from "node:fs";

export interface Config {
  geminiApiKey?: string;
  geminiModel: string;
  tavilyApiKey?: string;
  port: number;
}

export const DEFAULT_MODEL = "gemini-2.5-flash";
export const DEFAULT_PORT = 3000;

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
    tavilyApiKey: read(env, "TAVILY_API_KEY"),
    port,
  };
}

// The server can start without a key (so the page loads), but chatting needs one.
export function requireGeminiKey(config: Config): string {
  if (!config.geminiApiKey) {
    throw new Error("Add GEMINI_API_KEY to .env (copy .env.example to .env first).");
  }
  return config.geminiApiKey;
}

// Load .env into process.env if the file exists (built into Node, no extra library).
export function loadEnvFile(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
