import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.js";

let clock = new Date("2026-11-03T09:15:00.000Z");
let db: Db;
beforeEach(() => { clock = new Date("2026-11-03T09:15:00.000Z"); db = new Db(":memory:", () => clock); });
afterEach(() => db.close());

const later = (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000); };

describe("users", () => {
  it("creates and finds users; names ignore upper/lower case", () => {
    const u = db.createUser("Harsha");
    expect(u).toEqual({ id: 1, name: "Harsha", createdAt: "2026-11-03T09:15:00.000Z" });
    expect(db.findUserByName("harsha")).toEqual(u);
    expect(db.getUser(u.id)).toEqual(u);
    expect(db.findUserByName("nobody")).toBeUndefined();
  });

  it("refuses a duplicate name", () => {
    db.createUser("Harsha");
    expect(() => db.createUser("HARSHA")).toThrow(/UNIQUE/);
  });
});

describe("chats and messages", () => {
  it("saves messages with their dates, sources, searches and time zone, in order", () => {
    const u = db.createUser("a");
    const chat = db.createChat(u.id, "Postgres hosting");
    db.addMessage(u.id, chat.id, { role: "user", text: "Cheapest managed Postgres?", timezone: "Asia/Kolkata" });
    later(1);
    db.addMessage(u.id, chat.id, {
      role: "assistant", text: "Neon Launch $19/mo [1].",
      sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" }], searches: ["Neon pricing 2026"],
    });

    const msgs = db.listMessages(u.id, chat.id);
    expect(msgs.map((m) => [m.role, m.text, m.createdAt])).toEqual([
      ["user", "Cheapest managed Postgres?", "2026-11-03T09:15:00.000Z"],
      ["assistant", "Neon Launch $19/mo [1].", "2026-11-03T09:16:00.000Z"],
    ]);
    expect(msgs[0].timezone).toBe("Asia/Kolkata");
    expect(msgs[1].sources).toEqual([{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing" }]);
    expect(msgs[1].searches).toEqual(["Neon pricing 2026"]);
    expect(msgs[1].stopped).toBe(false);
  });

  it("can save a message with a past date (for seeding tests)", () => {
    const u = db.createUser("a");
    const chat = db.createChat(u.id, "t");
    const m = db.addMessage(u.id, chat.id, { role: "user", text: "old", createdAt: "2026-11-01T10:00:00.000Z" });
    expect(m.createdAt).toBe("2026-11-01T10:00:00.000Z");
  });

  it("marks a stopped answer", () => {
    const u = db.createUser("a");
    const chat = db.createChat(u.id, "t");
    db.addMessage(u.id, chat.id, { role: "assistant", text: "half", stopped: true });
    expect(db.listMessages(u.id, chat.id)[0].stopped).toBe(true);
  });

  it("lists a user's chats with the most recently used first", () => {
    const u = db.createUser("a");
    const first = db.createChat(u.id, "first");
    later(5);
    const second = db.createChat(u.id, "second");
    later(5);
    db.addMessage(u.id, first.id, { role: "user", text: "back to the first chat" });
    expect(db.listChats(u.id).map((c) => c.title)).toEqual(["first", "second"]);
    expect(db.listChats(u.id)[0].updatedAt).toBe("2026-11-03T09:25:00.000Z");
    expect(second.id).toBeGreaterThan(first.id);
  });

  it("saves and reads the chat note", () => {
    const u = db.createUser("a");
    const chat = db.createChat(u.id, "t");
    expect(db.getChat(u.id, chat.id)?.note).toBeUndefined();
    db.setChatNote(u.id, chat.id, { things: ["Neon", "Supabase"], topic: "pricing" });
    expect(db.getChat(u.id, chat.id)?.note).toEqual({ things: ["Neon", "Supabase"], topic: "pricing" });
  });
});

describe("users are kept apart", () => {
  it("user B can't see, read, change or add to user A's chat", () => {
    const a = db.createUser("a");
    const b = db.createUser("b");
    const chatA = db.createChat(a.id, "A's secret chat");
    db.addMessage(a.id, chatA.id, { role: "user", text: "private" });

    expect(db.listChats(b.id)).toEqual([]);
    expect(db.getChat(b.id, chatA.id)).toBeUndefined();
    expect(db.listMessages(b.id, chatA.id)).toEqual([]);
    expect(() => db.addMessage(b.id, chatA.id, { role: "user", text: "sneaky" })).toThrow("not found for this user");
    db.setChatNote(b.id, chatA.id, { things: ["X"], topic: "y" });
    expect(db.getChat(a.id, chatA.id)?.note).toBeUndefined(); // B's change did nothing
  });
});

describe("database file", () => {
  it("creates its folder and file, and keeps data after reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "minimi-db-"));
    const path = join(dir, "nested", "test.db");
    try {
      const first = new Db(path);
      const u = first.createUser("keep");
      first.createChat(u.id, "saved");
      first.close();
      expect(existsSync(path)).toBe(true);

      const again = new Db(path);
      expect(again.listChats(again.findUserByName("keep")!.id).map((c) => c.title)).toEqual(["saved"]);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
