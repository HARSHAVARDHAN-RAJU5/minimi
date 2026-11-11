import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import type { ChatFn, ChatInput, ChatTurn } from "./agent.js";
import { parseNote } from "./context.js";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
// Browser copies of two small libraries the page uses (installed by npm install, no CDN needed).
const vendorFiles: Record<string, string> = {
  "marked.js": fileURLToPath(new URL("../node_modules/marked/lib/marked.umd.js", import.meta.url)),
  "purify.js": fileURLToPath(new URL("../node_modules/dompurify/dist/purify.js", import.meta.url)),
};

const MAX_QUESTION_CHARS = 4000;
const MAX_HISTORY_TURNS = 20;

export interface AppDeps { chat?: ChatFn }

// Builds the web app without starting it, so tests can run it on any free port
// and plug in a fake chat.
export function createApp({ chat }: AppDeps = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/chat", async (req: Request, res: Response) => {
    const input = parseChatInput(req.body);
    if ("error" in input) {
      res.status(400).json({ error: input.error });
      return;
    }

    // SSE: a live one-way stream of small updates to the page.
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event: string, data: unknown = {}) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // If the page is closed mid-answer, stop working on it (saves quota).
    let closed = false;
    res.on("close", () => { closed = true; });

    try {
      if (!chat) throw new Error("Chat is not set up.");
      for await (const event of chat(input)) {
        if (closed) break; // ends the agent's work too
        const { type, ...data } = event;
        send(type, data);
      }
    } catch (err) {
      if (!closed) send("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
  });

  app.get("/vendor/:file", (req, res) => {
    const file = vendorFiles[req.params.file];
    if (file) res.type("application/javascript").sendFile(file);
    else res.status(404).end();
  });

  app.use(express.static(publicDir));
  return app;
}

// Checks the request body; returns a clear error instead of crashing on bad input.
export function parseChatInput(body: unknown): ChatInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const question = typeof b.question === "string" ? b.question.trim() : "";
  if (!question) return { error: "Please type a question." };
  if (question.length > MAX_QUESTION_CHARS) return { error: `Question is too long (max ${MAX_QUESTION_CHARS} characters).` };

  let history: ChatTurn[] = [];
  if (b.history !== undefined) {
    if (!Array.isArray(b.history)) return { error: "history must be a list." };
    history = b.history
      .filter((t): t is ChatTurn => (t?.role === "user" || t?.role === "assistant") && typeof t?.text === "string" && t.text.trim() !== "")
      .slice(-MAX_HISTORY_TURNS);
  }
  const timezone = typeof b.timezone === "string" ? b.timezone : undefined;
  const note = b.note === undefined ? undefined : parseNote(b.note); // a bad note is ignored, not an error
  return { question, history, timezone, ...(note ? { note } : {}) };
}
