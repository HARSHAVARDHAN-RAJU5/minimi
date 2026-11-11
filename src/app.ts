import express from "express";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

// Builds the web app without starting it, so tests can run it on any free port.
export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(express.static(publicDir));
  return app;
}
