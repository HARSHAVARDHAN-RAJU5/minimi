// The database: one SQLite file on the user's computer (Node's built-in SQLite, nothing to install).
// Every read is filtered by user, so one user never sees another user's chats.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatNote } from "./context.js";
import type { Source } from "./llm.js";

import { DEFAULT_DB_PATH } from "./config.js";
const SCHEMA_VERSION = 5;

export interface User { id: number; name: string; createdAt: string }
export interface Chat { id: number; userId: number; title: string; note?: ChatNote; seed?: boolean; createdAt: string; updatedAt: string }
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
// --- Memory map ---------------------------------------------------------------
// A thing the user talks about (a product or company).
export interface Thing { id: number; userId: number; name: string; type?: string; website?: string; aliases: string[]; createdAt: string }
export interface NewThing { name: string; type?: string; website?: string; aliases?: string[] }
// A link: this chat (and message) talked about this thing, at this time.
export interface Mention { id: number; thingId: number; chatId: number; messageId?: number; createdAt: string }
// A fact about a thing, with where and when it was checked. Old facts are kept, never overwritten.
export interface Fact {
  id: number; thingId: number; field: string; value: string;
  sourceUrl?: string; chatId?: number; messageId?: number; checkedAt: string;
}
export interface NewFact { thingId: number; field: string; value: string; sourceUrl?: string; chatId?: number; messageId?: number; checkedAt?: string }

// An open loop: something the user started but hasn't finished, e.g. "pick one of these 5 CRMs".
export interface Loop {
  id: number; chatId: number; text: string; things: string[];
  status: "open" | "closed"; choice?: string; openedAt: string; closedAt?: string; closedInChatId?: number;
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
  seed       INTEGER NOT NULL DEFAULT 0,  -- 1 = a pretend chat for testing (npm run seed); removable in one go
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
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,         -- small app settings kept across restarts,
  value TEXT NOT NULL             -- e.g. "writer_skip_until" when a model's daily quota is used up
);
-- Fast lookups: a user's chats newest first; a chat's messages in order; a user's messages by date.
CREATE INDEX IF NOT EXISTS chats_by_user_time    ON chats(user_id, updated_at);
CREATE INDEX IF NOT EXISTS messages_by_chat      ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS messages_by_user_time ON messages(user_id, created_at);

-- Memory map: things the user talks about, which chats mention them, and dated facts.
CREATE TABLE IF NOT EXISTS things (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT,                         -- e.g. "CRM", "Postgres hosting"
  website    TEXT,                         -- e.g. "neon.tech"
  aliases    TEXT NOT NULL DEFAULT '[]',   -- JSON list of other names, e.g. ["PostgreSQL"]
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mentions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thing_id   INTEGER NOT NULL REFERENCES things(id) ON DELETE CASCADE,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thing_id   INTEGER NOT NULL REFERENCES things(id) ON DELETE CASCADE,
  field      TEXT NOT NULL,                -- e.g. "Launch plan price"
  value      TEXT NOT NULL,                -- e.g. "$19/month"
  source_url TEXT,
  chat_id    INTEGER REFERENCES chats(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS things_by_user_name   ON things(user_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS mentions_by_thing     ON mentions(user_id, thing_id, created_at);
CREATE INDEX IF NOT EXISTS mentions_by_chat      ON mentions(chat_id);
CREATE INDEX IF NOT EXISTS facts_by_thing_time   ON facts(user_id, thing_id, checked_at);

-- Search index on message text (words like "pricing" also find "prices"). Kept in step by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Open loops: started but not finished ("pick one of these 5 CRMs"). Closed when the user decides.
CREATE TABLE IF NOT EXISTS loops (
  id                 INTEGER PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id            INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  text               TEXT NOT NULL,                 -- e.g. "Pick one: HubSpot, Pipedrive, Salesforce"
  things             TEXT NOT NULL DEFAULT '[]',    -- JSON list of the options
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  choice             TEXT,                          -- what was picked, if anything
  opened_at          TEXT NOT NULL,
  closed_at          TEXT,
  closed_in_chat_id  INTEGER REFERENCES chats(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS loops_by_user_status ON loops(user_id, status, opened_at);
`;

type Row = Record<string, unknown>;

export class Db {
  private db: DatabaseSync;

  // ":memory:" = a temporary database for tests (no file).
  constructor(path: string = DEFAULT_DB_PATH, private now: () => Date = () => new Date()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    const before = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    // Older database: add columns that came later, before the rest of the schema uses them.
    if (before > 0 && before < 4) {
      const columns = (this.db.prepare("PRAGMA table_info(chats)").all() as Row[]).map((c) => String(c.name));
      if (!columns.includes("seed")) this.db.exec("ALTER TABLE chats ADD COLUMN seed INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec(SCHEMA);
    // Older database: fill the new search index with the messages saved before it existed.
    if (before > 0 && before < 3) this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close() { this.db.close(); }

  private stamp(): string { return this.now().toISOString(); }

  // --- App state (not per user) ------------------------------------------------

  getState(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  setState(key: string, value: string): void {
    this.db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // --- Open loops ---------------------------------------------------------------

  addLoop(userId: number, l: { chatId: number; text: string; things: string[]; openedAt?: string }): Loop {
    if (!this.getChat(userId, l.chatId)) throw new Error(`Chat ${l.chatId} not found for this user.`);
    const openedAt = l.openedAt ?? this.stamp();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO loops (user_id, chat_id, text, things, opened_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, l.chatId, l.text, JSON.stringify(l.things), openedAt);
    return { id: Number(lastInsertRowid), chatId: l.chatId, text: l.text, things: l.things, status: "open", openedAt };
  }

  // Updates an open loop's options (e.g. a 6th CRM added to the shortlist in the same chat).
  updateLoop(userId: number, loopId: number, l: { text: string; things: string[] }): void {
    this.db.prepare("UPDATE loops SET text = ?, things = ? WHERE id = ? AND user_id = ? AND status = 'open'")
      .run(l.text, JSON.stringify(l.things), loopId, userId);
  }

  getLoop(userId: number, loopId: number): Loop | undefined {
    const row = this.db.prepare("SELECT * FROM loops WHERE id = ? AND user_id = ?").get(loopId, userId) as Row | undefined;
    return row ? toLoop(row) : undefined;
  }

  // A user's loops, newest first. status: "open" (default), "closed" or "all".
  listLoops(userId: number, status: "open" | "closed" | "all" = "open"): Loop[] {
    const rows = status === "all"
      ? this.db.prepare("SELECT * FROM loops WHERE user_id = ? ORDER BY opened_at DESC, id DESC").all(userId)
      : this.db.prepare("SELECT * FROM loops WHERE user_id = ? AND status = ? ORDER BY opened_at DESC, id DESC").all(userId, status);
    return (rows as Row[]).map(toLoop);
  }

  // Closes a loop: with what was picked (if anything) and where it was decided.
  closeLoop(userId: number, loopId: number, close: { choice?: string; chatId?: number; at?: string } = {}): boolean {
    const { changes } = this.db
      .prepare("UPDATE loops SET status = 'closed', choice = ?, closed_at = ?, closed_in_chat_id = ? WHERE id = ? AND user_id = ? AND status = 'open'")
      .run(close.choice ?? null, close.at ?? this.stamp(), close.chatId ?? null, loopId, userId);
    return Number(changes) > 0;
  }

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

  // opts.seed marks a pretend chat (testing); opts.createdAt backdates it.
  createChat(userId: number, title: string, opts: { seed?: boolean; createdAt?: string } = {}): Chat {
    const t = opts.createdAt ?? this.stamp();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO chats (user_id, title, seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, title, opts.seed ? 1 : 0, t, t);
    return { id: Number(lastInsertRowid), userId, title, ...(opts.seed ? { seed: true } : {}), createdAt: t, updatedAt: t };
  }

  // Removes this user's pretend (seed) chats with their messages, links and facts, and any things
  // left with nothing pointing to them. Real chats are never touched. Returns how many chats went.
  clearSeed(userId: number): number {
    const ids = (this.db.prepare("SELECT id FROM chats WHERE user_id = ? AND seed = 1").all(userId) as Row[]).map((r) => Number(r.id));
    if (ids.length === 0) return 0;
    const list = ids.join(",");
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM facts WHERE user_id = ? AND chat_id IN (${list})`).run(userId);
      this.db.prepare(`DELETE FROM chats WHERE user_id = ? AND id IN (${list})`).run(userId); // messages + mentions go with them
      this.db.prepare(`DELETE FROM things WHERE user_id = ?
        AND id NOT IN (SELECT thing_id FROM mentions WHERE user_id = ?)
        AND id NOT IN (SELECT thing_id FROM facts WHERE user_id = ?)`).run(userId, userId, userId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return ids.length;
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

  // A user's messages in a time range [from, to), in order. beforeId: only messages saved before this one.
  listMessagesInRange(userId: number, range: { from?: string; to?: string; beforeId?: number }): Message[] {
    return (this.db
      .prepare("SELECT * FROM messages WHERE user_id = ? AND created_at >= ? AND created_at < ? AND id < ? ORDER BY id")
      .all(userId, range.from ?? "", range.to ?? "9999", range.beforeId ?? Number.MAX_SAFE_INTEGER) as Row[]).map(toMessage);
  }

  // A user's messages containing any of these words (search index), best matches first.
  searchMessages(userId: number, words: string[], range: { from?: string; to?: string; beforeId?: number; limit?: number } = {}): Message[] {
    const terms = words.map((w) => w.replace(/"/g, "").trim()).filter(Boolean).map((w) => `"${w}"`);
    if (terms.length === 0) return [];
    return (this.db
      .prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
                WHERE messages_fts MATCH ? AND m.user_id = ? AND m.created_at >= ? AND m.created_at < ? AND m.id < ?
                ORDER BY bm25(messages_fts) LIMIT ?`)
      .all(terms.join(" OR "), userId, range.from ?? "", range.to ?? "9999", range.beforeId ?? Number.MAX_SAFE_INTEGER, range.limit ?? 50) as Row[])
      .map(toMessage);
  }

  // A chat's messages in order (only if the chat belongs to this user).
  listMessages(userId: number, chatId: number): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE chat_id = ? AND user_id = ? ORDER BY id").all(chatId, userId) as Row[]).map(toMessage);
  }

  // --- Memory map: things ------------------------------------------------------

  createThing(userId: number, t: NewThing): Thing {
    const createdAt = this.stamp();
    const aliases = t.aliases ?? [];
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO things (user_id, name, type, website, aliases, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, t.name, t.type ?? null, t.website ?? null, JSON.stringify(aliases), createdAt);
    return {
      id: Number(lastInsertRowid), userId, name: t.name,
      ...(t.type ? { type: t.type } : {}), ...(t.website ? { website: t.website } : {}), aliases, createdAt,
    };
  }

  getThing(userId: number, thingId: number): Thing | undefined {
    const row = this.db.prepare("SELECT * FROM things WHERE id = ? AND user_id = ?").get(thingId, userId) as Row | undefined;
    return row ? toThing(row) : undefined;
  }

  listThings(userId: number): Thing[] {
    return (this.db.prepare("SELECT * FROM things WHERE user_id = ? ORDER BY name COLLATE NOCASE, id").all(userId) as Row[]).map(toThing);
  }

  // This user's things whose name or other names match (any upper/lower case).
  // Can return several: "Apollo" the sales tool and "Apollo" the coding tool.
  findThingsByName(userId: number, name: string): Thing[] {
    const wanted = name.trim().toLowerCase();
    return this.listThings(userId).filter((t) => t.name.toLowerCase() === wanted || t.aliases.some((a) => a.toLowerCase() === wanted));
  }

  // Joins two things that turned out to be the same: `from`'s links, facts and names move to `into`,
  // then `from` is removed. Both must belong to this user.
  mergeThings(userId: number, fromId: number, intoId: number): void {
    const from = this.getThing(userId, fromId);
    const into = this.getThing(userId, intoId);
    if (!from || !into || fromId === intoId) return;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE mentions SET thing_id = ? WHERE thing_id = ? AND user_id = ?").run(intoId, fromId, userId);
      this.db.prepare("UPDATE facts SET thing_id = ? WHERE thing_id = ? AND user_id = ?").run(intoId, fromId, userId);
      this.db.prepare("DELETE FROM things WHERE id = ? AND user_id = ?").run(fromId, userId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    for (const name of [from.name, ...from.aliases]) this.addAlias(userId, intoId, name);
    this.fillThing(userId, intoId, { type: from.type, website: from.website });
  }

  // Adds another name for a thing (e.g. "PostgreSQL" for "Postgres"). Ignores repeats.
  addAlias(userId: number, thingId: number, alias: string): void {
    const thing = this.getThing(userId, thingId);
    const clean = alias.trim();
    if (!thing || !clean) return;
    const known = [thing.name, ...thing.aliases].some((n) => n.toLowerCase() === clean.toLowerCase());
    if (known) return;
    this.db.prepare("UPDATE things SET aliases = ? WHERE id = ? AND user_id = ?").run(JSON.stringify([...thing.aliases, clean]), thingId, userId);
  }

  // Fills in a missing type or website (never replaces one that is already set).
  fillThing(userId: number, thingId: number, extra: { type?: string; website?: string }): void {
    this.db.prepare("UPDATE things SET type = COALESCE(type, ?), website = COALESCE(website, ?) WHERE id = ? AND user_id = ?")
      .run(extra.type ?? null, extra.website ?? null, thingId, userId);
  }

  // --- Memory map: mentions (chat → thing) ---------------------------------------

  addMention(userId: number, m: { thingId: number; chatId: number; messageId?: number; createdAt?: string }): Mention {
    if (!this.getThing(userId, m.thingId)) throw new Error(`Thing ${m.thingId} not found for this user.`);
    if (!this.getChat(userId, m.chatId)) throw new Error(`Chat ${m.chatId} not found for this user.`);
    const createdAt = m.createdAt ?? this.stamp();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO mentions (user_id, thing_id, chat_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, m.thingId, m.chatId, m.messageId ?? null, createdAt);
    return { id: Number(lastInsertRowid), thingId: m.thingId, chatId: m.chatId, ...(m.messageId ? { messageId: m.messageId } : {}), createdAt };
  }

  // Where a thing was talked about, oldest first. Optional date range (ISO times, from <= t < to).
  listMentions(userId: number, thingId: number, range: { from?: string; to?: string } = {}): Mention[] {
    return (this.db
      .prepare("SELECT * FROM mentions WHERE user_id = ? AND thing_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at, id")
      .all(userId, thingId, range.from ?? "", range.to ?? "9999") as Row[]).map(toMention);
  }

  // The things a chat talked about.
  listThingsInChat(userId: number, chatId: number): Thing[] {
    return (this.db
      .prepare("SELECT DISTINCT t.* FROM things t JOIN mentions m ON m.thing_id = t.id WHERE m.user_id = ? AND m.chat_id = ? ORDER BY t.id")
      .all(userId, chatId) as Row[]).map(toThing);
  }

  // --- Memory map: facts ---------------------------------------------------------

  // Saves a fact. Never replaces an older one: both stay, each with its date.
  addFact(userId: number, f: NewFact): Fact {
    if (!this.getThing(userId, f.thingId)) throw new Error(`Thing ${f.thingId} not found for this user.`);
    if (f.chatId && !this.getChat(userId, f.chatId)) throw new Error(`Chat ${f.chatId} not found for this user.`);
    const checkedAt = f.checkedAt ?? this.stamp();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO facts (user_id, thing_id, field, value, source_url, chat_id, message_id, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(userId, f.thingId, f.field, f.value, f.sourceUrl ?? null, f.chatId ?? null, f.messageId ?? null, checkedAt);
    return {
      id: Number(lastInsertRowid), thingId: f.thingId, field: f.field, value: f.value,
      ...(f.sourceUrl ? { sourceUrl: f.sourceUrl } : {}), ...(f.chatId ? { chatId: f.chatId } : {}),
      ...(f.messageId ? { messageId: f.messageId } : {}), checkedAt,
    };
  }

  // The facts saved from one chat (what was said then), oldest first.
  listFactsInChat(userId: number, chatId: number): Fact[] {
    return (this.db.prepare("SELECT * FROM facts WHERE user_id = ? AND chat_id = ? ORDER BY checked_at, id").all(userId, chatId) as Row[]).map(toFact);
  }

  // Every fact about a thing, oldest first (the full history).
  listFacts(userId: number, thingId: number): Fact[] {
    return (this.db.prepare("SELECT * FROM facts WHERE user_id = ? AND thing_id = ? ORDER BY checked_at, id").all(userId, thingId) as Row[]).map(toFact);
  }

  // The newest fact for each field of a thing (field names ignore upper/lower case).
  latestFacts(userId: number, thingId: number): Fact[] {
    const latest = new Map<string, Fact>();
    for (const f of this.listFacts(userId, thingId)) latest.set(f.field.toLowerCase(), f); // later ones win
    return [...latest.values()];
  }
}

function toThing(r: Row): Thing {
  return {
    id: Number(r.id), userId: Number(r.user_id), name: String(r.name),
    ...(r.type ? { type: String(r.type) } : {}), ...(r.website ? { website: String(r.website) } : {}),
    aliases: safeJson<string[]>(String(r.aliases)) ?? [], createdAt: String(r.created_at),
  };
}

function toMention(r: Row): Mention {
  return {
    id: Number(r.id), thingId: Number(r.thing_id), chatId: Number(r.chat_id),
    ...(r.message_id ? { messageId: Number(r.message_id) } : {}), createdAt: String(r.created_at),
  };
}

function toFact(r: Row): Fact {
  return {
    id: Number(r.id), thingId: Number(r.thing_id), field: String(r.field), value: String(r.value),
    ...(r.source_url ? { sourceUrl: String(r.source_url) } : {}), ...(r.chat_id ? { chatId: Number(r.chat_id) } : {}),
    ...(r.message_id ? { messageId: Number(r.message_id) } : {}), checkedAt: String(r.checked_at),
  };
}

function toLoop(r: Row): Loop {
  return {
    id: Number(r.id), chatId: Number(r.chat_id), text: String(r.text), things: safeJson<string[]>(String(r.things)) ?? [],
    status: r.status === "closed" ? "closed" : "open", ...(r.choice ? { choice: String(r.choice) } : {}),
    openedAt: String(r.opened_at), ...(r.closed_at ? { closedAt: String(r.closed_at) } : {}),
    ...(r.closed_in_chat_id ? { closedInChatId: Number(r.closed_in_chat_id) } : {}),
  };
}

function toUser(r: Row): User {
  return { id: Number(r.id), name: String(r.name), createdAt: String(r.created_at) };
}

function toChat(r: Row): Chat {
  const note = r.note ? safeJson<ChatNote>(String(r.note)) : undefined;
  return {
    id: Number(r.id), userId: Number(r.user_id), title: String(r.title),
    ...(note ? { note } : {}), ...(Number(r.seed) === 1 ? { seed: true } : {}),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
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
