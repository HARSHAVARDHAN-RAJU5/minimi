// Chat routes: asking (with saving), the chat list, and opening one chat.
// Every question is saved BEFORE answering, every answer AFTER, so nothing asked is lost.
import type { Express, Request, Response } from "express";
import type { ChatFn, ChatTurn } from "./agent.js";
import type { ChatNote } from "./context.js";
import type { Chat, Db, Message, User } from "./db.js";
import type { Source } from "./llm.js";
import { requireUser } from "./users.js";

// A finished answer, handed to the memory writer (runs in the background).
export interface RememberJob {
  userId: number; chatId: number; messageId: number; at: string;
  question: string; answer: string; sources: Source[];
}
export type RememberFn = (job: RememberJob) => void;

export const MAX_QUESTION_CHARS = 4000;
export const MAX_HISTORY_TURNS = 20;
export const MAX_TITLE_CHARS = 60;

export interface ChatRequest { question: string; chatId?: number; timezone?: string }

// Checks the request body; returns a clear error instead of crashing on bad input.
export function parseChatRequest(body: unknown): ChatRequest | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const question = typeof b.question === "string" ? b.question.trim() : "";
  if (!question) return { error: "Please type a question." };
  if (question.length > MAX_QUESTION_CHARS) return { error: `Question is too long (max ${MAX_QUESTION_CHARS} characters).` };
  let chatId: number | undefined;
  if (b.chatId !== undefined && b.chatId !== null) {
    chatId = Number(b.chatId);
    if (!Number.isInteger(chatId) || chatId <= 0) return { error: "chatId must be a chat number." };
  }
  const timezone = typeof b.timezone === "string" ? b.timezone.slice(0, 64) : undefined;
  return { question, ...(chatId ? { chatId } : {}), ...(timezone ? { timezone } : {}) };
}

// Chat title: the first question, cut at a word boundary. Plain code, no AI.
export function makeTitle(question: string): string {
  const q = question.replace(/\s+/g, " ").trim();
  if (q.length <= MAX_TITLE_CHARS) return q;
  const cut = q.slice(0, MAX_TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

// Saved messages → earlier turns for the agent (a stopped answer says so).
export function toTurns(messages: Message[]): ChatTurn[] {
  return messages
    .filter((m) => m.text.trim())
    .map((m) => ({ role: m.role, text: m.stopped ? `${m.text}\n\n(stopped early)` : m.text }))
    .slice(-MAX_HISTORY_TURNS);
}

const chatSummary = (c: Chat) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt });

export function registerChatRoutes(app: Express, { db, chat, remember }: { db: Db; chat?: ChatFn; remember?: RememberFn }) {
  const guard = requireUser(db);

  // Your chats, newest first.
  app.get("/api/chats", guard, (_req, res) => {
    const user = res.locals.user as User;
    res.json({ chats: db.listChats(user.id).map(chatSummary) });
  });

  // What I remember: your things, the latest value of each fact, and the chats that talked about them.
  app.get("/api/memory", guard, (_req, res) => {
    const user = res.locals.user as User;
    res.json({ things: memoryView(db, user.id) });
  });

  // One of your chats, with all its messages.
  app.get("/api/chats/:id", guard, (req, res) => {
    const user = res.locals.user as User;
    const found = db.getChat(user.id, Number(req.params.id));
    if (!found) {
      res.status(404).json({ error: "Chat not found." });
      return;
    }
    res.json({
      chat: chatSummary(found),
      messages: db.listMessages(user.id, found.id).map(({ id, role, text, sources, searches, stopped, createdAt }) => ({
        id, role, text, sources, searches, stopped, createdAt,
      })),
    });
  });

  // Ask a question: saves it, answers (streamed), saves the answer.
  app.post("/api/chat", guard, async (req: Request, res: Response) => {
    const user = res.locals.user as User;
    const input = parseChatRequest(req.body);
    if ("error" in input) {
      res.status(400).json({ error: input.error });
      return;
    }

    let current: Chat | undefined;
    if (input.chatId) {
      current = db.getChat(user.id, input.chatId); // only finds YOUR chat
      if (!current) {
        res.status(404).json({ error: "Chat not found." });
        return;
      }
    }
    // Earlier turns and the note come from the database (read before saving the new question).
    const history = current ? toTurns(db.listMessages(user.id, current.id)) : [];
    const note = current?.note;
    current ??= db.createChat(user.id, makeTitle(input.question));

    // 1) Save the question first, so it's kept even if the answer fails.
    const asked = db.addMessage(user.id, current.id, { role: "user", text: input.question, timezone: input.timezone });

    // SSE: a live one-way stream of small updates to the page.
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event: string, data: unknown = {}) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("chat", { id: current.id, title: current.title });

    // If the page is closed mid-answer, stop working on it (saves quota).
    let closed = false;
    res.on("close", () => { closed = true; });

    let text = "";
    let sources: Source[] = [];
    const searches: string[] = [];
    let newNote: ChatNote | undefined;
    let finished = false;

    try {
      if (!chat) throw new Error("Chat is not set up.");
      for await (const event of chat({ question: input.question, history, timezone: input.timezone, userId: user.id, messageId: asked.id, ...(note ? { note } : {}) })) {
        if (closed) break; // ends the agent's work too
        if (event.type === "text") text += event.text;
        else if (event.type === "search") searches.push(event.query);
        else if (event.type === "sources") sources = event.sources;
        else if (event.type === "note") newNote = event.note;
        else if (event.type === "done") finished = true;
        const { type, ...data } = event;
        send(type, data);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`answer failed (chat ${current.id}): ${message.slice(0, 200)}`);
      if (!closed) send("error", { message });
    } finally {
      // 2) Save the answer (even a partial one, marked stopped) and the new note.
      if (text.trim()) {
        const saved = db.addMessage(user.id, current.id, { role: "assistant", text, sources, searches, timezone: input.timezone, stopped: !finished });
        // 3) In the background, write memory cards. Only for complete answers that used web search
        //    (stopped answers, errors and small talk have no facts worth keeping).
        if (remember && finished && searches.length > 0) {
          remember({ userId: user.id, chatId: current.id, messageId: saved.id, at: saved.createdAt, question: input.question, answer: text, sources });
        }
      }
      if (newNote) db.setChatNote(user.id, current.id, newNote);
      res.end();
    }
  });
}

// Builds the "What I remember" list: most recently talked-about things first.
export function memoryView(db: Db, userId: number) {
  const titles = new Map<number, string>();
  const title = (chatId: number) => {
    if (!titles.has(chatId)) titles.set(chatId, db.getChat(userId, chatId)?.title ?? "");
    return titles.get(chatId)!;
  };
  return db.listThings(userId)
    .map((t) => {
      const mentions = db.listMentions(userId, t.id);
      const chats = new Map<number, string>(); // chat → last time it talked about this thing
      for (const m of mentions) chats.set(m.chatId, m.createdAt);
      return {
        id: t.id, name: t.name, type: t.type, website: t.website, aliases: t.aliases,
        lastSeen: mentions.at(-1)?.createdAt ?? t.createdAt,
        facts: db.latestFacts(userId, t.id).map((f) => ({ field: f.field, value: f.value, sourceUrl: f.sourceUrl, checkedAt: f.checkedAt })),
        chats: [...chats].map(([id, at]) => ({ id, title: title(id), at })).reverse(),
      };
    })
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}
