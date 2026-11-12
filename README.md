# minimi chat agent

A chat agent with one tool, **web search**, that **remembers what you asked and when**. Ask *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"* and it finds that chat, checks every product again on the web, and shows **then vs now** with sources.

How it's built and why: **[DESIGN.md](DESIGN.md)**.

## Setup (3 steps)

Needs **Node.js 22.13 or newer**.

```bash
npm install
cp .env.example .env      # then add your 2 keys (below)
npm run dev               # open http://localhost:3000
```

Keys for `.env` (both free, no card):
- `GEMINI_API_KEY`: https://aistudio.google.com/apikey
- `EXA_API_KEY`: https://dashboard.exa.ai
- Optional backup search, `TAVILY_API_KEY`: https://app.tavily.com

The page opens even without keys and tells you which one is missing.

## Try it in 1 minute

```bash
npm run seed              # adds pretend past chats for the user "demo"
```

Open the page, sign in as **demo**, and ask:

1. `On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?`
2. `What did I ask you on 3 November? Is your answer still correct today?`
3. `Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?`

`npm run seed:clear` removes only the pretend chats.

## What to look at

- **Then vs now:** memory answers show what was said then, what's true now, and what changed, with sources.
- **Still open:** shortlists you haven't decided on show on the New chat screen. Say "we went with X" or press Done to close one.
- **What I remember:** the page listing the products, facts and decisions the agent has saved.
- Follow-ups like *"and Supabase?"* or *"which one is cheaper?"* just work.

## Good to know

`gemini-3.8-flash` writes the answers, but its free tier allows only 20 requests a day. When it's used up or busy, the fast model (`gemini-3.5-flash-lite`) writes instead, automatically. To always use the fast model, set `GEMINI_MODEL=gemini-3.5-flash-lite` in `.env`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app (restarts on code changes) |
| `npm test` | Quick tests (fake AI, no keys needed) |
| `npm run typecheck` | Check the TypeScript |
| `npm run test:live` | Tests with the real AI (uses your quota) |
| `npm run eval:memory` / `eval:context` / `eval:recall` / `eval:speed` / `eval:planner` | Real-AI test scripts behind the scores in DESIGN.md |
| `npm run seed` / `seed:clear` | Add / remove the pretend past chats |

Chats are saved in `data/minimi.db` on your computer (change with `DB_PATH`).
