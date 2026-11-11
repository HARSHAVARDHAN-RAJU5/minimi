// The database: one SQLite file on the user's computer (Node's built-in SQLite, nothing to install).
// Every read is filtered by user, so one user never sees another user's chats.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatNote } from "./context.js";
import type { Source } from "./llm.js";

export const DEFAULT_DB_PATH = "data/minimi.db";
const SCHEMA_VERSION = 1;

export interface User { id: number; name: string; createdAt: string }
export interface Chat { id: number; userId: number; title: string; note?: ChatNote; createdAt: string; updatedAt: string }
export interface Message {
  id: number;
  chatId: number;
  role: "user" | "assistant";
  text: string;
  sources: Source[];
  searches: string[];
  timezone?: string; // the user's time zone when it was sent, so "3 November" means 3 November for them
  stopped: boolean; // answer was cut short (Stop button / closed page)
  createdAt: string; // ISO time in UTC, e.g. 2026-11-03T09:15:00.000Z
}
export interface NewMessage {
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
  searches?: string[];
  timezone?: string;
  stopped?: boolean;
  createdAt?: string; // defaults to now
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  note       TEXT,               -- JSON: { things, topic } from the last answer
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text       TEXT NOT NULL,
  sources    TEXT NOT NULL DEFAULT '[]',   -- JSON list
  searches   TEXT NOT NULL DEFAULT '[]',   -- JSON list
  timezone   TEXT,
  stopped    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- Fast lookups: a user's chats newest first; a chat's messages in order; a user's messages by date.
CREATE INDEX IF NOT EXISTS chats_by_user_time    ON chats(user_id, updated_at);
CREATE INDEX IF NOT EXISTS messages_by_chat      ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS messages_by_user_time ON messages(user_id, created_at);
`;

type Row = Record<string, unknown>;

export class Db {
  private db: DatabaseSync;

  // ":memory:" = a temporary database for tests (no file).
  constructor(path: string = DEFAULT_DB_PATH, private now: () => Date = () => new Date()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close() { this.db.close(); }

  private stamp(): string { return this.now().toISOString(); }

  // --- Users -----------------------------------------------------------------

  createUser(name: string): User {
    const createdAt = this.stamp();
    const { lastInsertRowid } = this.db.prepare("INSERT INTO users (name, created_at) VALUES (?, ?)").run(name, createdAt);
    return { id: Number(lastInsertRowid), name, createdAt };
  }

  findUserByName(name: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE name = ?").get(name) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  getUser(id: number): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  // --- Chats -----------------------------------------------------------------

  createChat(userId: number, title: string): Chat {
    const t = this.stamp();
    const { lastInsertRowid } = this.db.prepare("INSERT INTO chats (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, title, t, t);
    return { id: Number(lastInsertRowid), userId, title, createdAt: t, updatedAt: t };
  }

  // Only finds the chat if it belongs to this user.
  getChat(userId: number, chatId: number): Chat | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId) as Row | undefined;
    return row ? toChat(row) : undefined;
  }

  // A user's chats, most recently used first.
  listChats(userId: number, limit = 100): Chat[] {
    return (this.db.prepare("SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?").all(userId, limit) as Row[]).map(toChat);
  }

  setChatNote(userId: number, chatId: number, note: ChatNote): void {
    this.db.prepare("UPDATE chats SET note = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(note), chatId, userId);
  }

  // --- Messages --------------------------------------------------------------

  // Adds a message to the user's own chat and marks the chat as just used.
  addMessage(userId: number, chatId: number, m: NewMessage): Message {
    if (!this.getChat(userId, chatId)) throw new Error(`Chat ${chatId} not found for this user.`);
    const createdAt = m.createdAt ?? this.stamp();
    const sources = m.sources ?? [];
    const searches = m.searches ?? [];
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO messages (chat_id, user_id, role, text, sources, searches, timezone, stopped, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(chatId, userId, m.role, m.text, JSON.stringify(sources), JSON.stringify(searches), m.timezone ?? null, m.stopped ? 1 : 0, createdAt);
    this.db.prepare("UPDATE chats SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(createdAt, chatId);
    return {
      id: Number(lastInsertRowid), chatId, role: m.role, text: m.text, sources, searches,
      ...(m.timezone ? { timezone: m.timezone } : {}), stopped: Boolean(m.stopped), createdAt,
    };
  }

  // A chat's messages in order (only if the chat belongs to this user).
  listMessages(userId: number, chatId: number): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE chat_id = ? AND user_id = ? ORDER BY id").all(chatId, userId) as Row[]).map(toMessage);
  }
}

function toUser(r: Row): User {
  return { id: Number(r.id), name: String(r.name), createdAt: String(r.created_at) };
}

function toChat(r: Row): Chat {
  const note = r.note ? safeJson<ChatNote>(String(r.note)) : undefined;
  return {
    id: Number(r.id), userId: Number(r.user_id), title: String(r.title),
    ...(note ? { note } : {}), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function toMessage(r: Row): Message {
  return {
    id: Number(r.id), chatId: Number(r.chat_id), role: r.role as Message["role"], text: String(r.text),
    sources: safeJson<Source[]>(String(r.sources)) ?? [], searches: safeJson<string[]>(String(r.searches)) ?? [],
    ...(r.timezone ? { timezone: String(r.timezone) } : {}), stopped: Number(r.stopped) === 1, createdAt: String(r.created_at),
  };
}

function safeJson<T>(text: string): T | undefined {
  try { return JSON.parse(text) as T; } catch { return undefined; }
}
