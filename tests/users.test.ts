import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { Db } from "../src/db.js";
import { checkName, findOrCreateUser } from "../src/users.js";

let db: Db;
let server: Server;
let url: string;

beforeEach(async () => {
  db = new Db(":memory:");
  server = createApp({ db }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

const join = (name: unknown) =>
  fetch(`${url}/api/users`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });

describe("POST /api/users", () => {
  it("creates a new user", async () => {
    const res = await join("Harsha");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ user: { id: 1, name: "Harsha" } });
  });

  it("the same name again (any case, extra spaces) gives back the same user", async () => {
    const first = (await (await join("Harsha")).json()).user;
    const res = await join("  harsha ");
    expect(res.status).toBe(200);
    expect((await res.json()).user).toEqual(first);
  });

  it("rejects bad names with a clear message", async () => {
    for (const [name, error] of [
      ["", "Please type a name."],
      ["   ", "Please type a name."],
      [42, "Please type a name."],
      ["x".repeat(41), "Name is too long (max 40 characters)."],
      ["<script>", "Name can only use letters, numbers, spaces, - _ ."],
    ] as const) {
      const res = await join(name);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
  });
});

describe("GET /api/me (needs a user)", () => {
  it("knows who you are from X-User-Id", async () => {
    const { user } = await (await join("Asha")).json();
    const res = await fetch(`${url}/api/me`, { headers: { "X-User-Id": String(user.id) } });
    expect(await res.json()).toEqual({ user });
  });

  it("missing, bad or unknown user id → Pick a user first", async () => {
    for (const headers of [{}, { "X-User-Id": "abc" }, { "X-User-Id": "-1" }, { "X-User-Id": "999" }] as Array<Record<string, string>>) {
      const res = await fetch(`${url}/api/me`, { headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Pick a user first." });
    }
  });
});

describe("checkName / findOrCreateUser", () => {
  it("allows names in any language and tidies spaces", () => {
    expect(checkName("  Ravi   Kumar ")).toEqual({ name: "Ravi Kumar" });
    expect(checkName("हर्ष")).toEqual({ name: "हर्ष" });
    expect(checkName("a.b_c-d")).toEqual({ name: "a.b_c-d" });
  });

  it("returns the existing user instead of failing on a duplicate", () => {
    const a = findOrCreateUser(db, "Same");
    const b = findOrCreateUser(db, "SAME");
    expect(a.created).toBe(true);
    expect(b).toEqual({ user: a.user, created: false });
  });
});
