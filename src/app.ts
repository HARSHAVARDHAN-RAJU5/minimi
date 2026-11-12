import express from "express";
import { fileURLToPath } from "node:url";
import type { ChatFn } from "./agent.js";
import { registerChatRoutes, type RememberFn } from "./chats.js";
import type { Db, User } from "./db.js";
import { checkName, findOrCreateUser, requireUser } from "./users.js";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
// Browser copies of two small libraries the page uses (installed by npm install, no CDN needed).
const vendorFiles: Record<string, string> = {
  "marked.js": fileURLToPath(new URL("../node_modules/marked/lib/marked.umd.js", import.meta.url)),
  "purify.js": fileURLToPath(new URL("../node_modules/dompurify/dist/purify.js", import.meta.url)),
};

export interface AppDeps { chat?: ChatFn; db?: Db; remember?: RememberFn }

// Builds the web app without starting it, so tests can run it on any free port
// and plug in a fake chat and a temporary database.
export function createApp({ chat, db, remember }: AppDeps = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (db) {
    // "Who are you?": find or create the user by name.
    app.post("/api/users", (req, res) => {
      const checked = checkName(req.body?.name);
      if ("error" in checked) {
        res.status(400).json({ error: checked.error });
        return;
      }
      const { user, created } = findOrCreateUser(db, checked.name);
      res.status(created ? 201 : 200).json({ user: { id: user.id, name: user.name } });
    });

    // The page checks its remembered user is still valid.
    app.get("/api/me", requireUser(db), (_req, res) => {
      const user = res.locals.user as User;
      res.json({ user: { id: user.id, name: user.name } });
    });

    // Asking (with saving), the chat list, opening a chat.
    registerChatRoutes(app, { db, chat, remember });
  }

  app.get("/vendor/:file", (req, res) => {
    const file = vendorFiles[req.params.file];
    if (file) res.type("application/javascript").sendFile(file);
    else res.status(404).end();
  });

  app.use(express.static(publicDir));
  return app;
}
