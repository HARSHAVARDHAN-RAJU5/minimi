# Plan: "minimi" — chat agent with web search + long-term memory

> **Status:** planning done, Phases 0–3 done. Add, cut or change anything as we go.

## Context
Goal: a chat agent that feels as good as online chat apps, with **web search as its only tool**, and that **remembers past conversations by date and topic**, so it can answer:
- "On Monday we shortlisted 5 CRM tools… has any changed pricing since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked about Postgres hosting. Has pricing changed?"

Rules: JS/TS on Node · `npm install` then `npm run dev` · every key in `.env.example` · any model/framework.
Choices made: **Gemini** (free tier), **simple web UI**, **multiple users**, free search (Exa, Tavily backup).

## Main idea (plain words)
When you send a message:
1. Code works out the real dates ("last Tuesday" → 2026-11-03) and asks Gemini a quick question: "does this need old conversations? which topics?"
2. Code uses the **memory map** to find matching chats, then reads the real saved messages and facts (what you asked, what we answered, prices with sources, as-of date).
3. Gemini answers, using the web_search tool (Exa, Tavily backup) when needed, comparing "what we said then" with "what's true now", and cites its sources.
4. Search results are saved while answering. After the reply, one background AI call **rewrites** (not appends) the map, the chat summary and your profile.

Memory lives in code around the model, so web search stays the model's only tool.

## Stack
- **Models:** Gemini via `@google/genai`. `gemini-3.8-flash` for answers (`GEMINI_MODEL`), `gemini-3.5-flash-lite` for background chores (`GEMINI_FAST_MODEL`). Code picks per job.
- **Search:** one tool, `web_search`, given to Gemini. Code runs Exa (main: 2,500 free/month, no card) and switches to Tavily automatically if Exa fails or runs out. Keys: `EXA_API_KEY`, `TAVILY_API_KEY` (optional).
- **Server:** Node 24 + TypeScript + Express, run with `tsx watch`. Replies stream to the browser over SSE (Server-Sent Events, a one-way live stream from server to browser).
- **Storage:** built-in `node:sqlite` (no native build step, so `npm install` stays reliable on Windows). `engines: node >=22.13`.
- **Dates:** `chrono-node` turns "Monday", "3 November" and "last Tuesday" into real dates in the user's timezone. This is plain code, not the model guessing.
- **UI:** one plain HTML/JS page served by Express: user picker, conversation sidebar, chat pane, source links. No build step.
- **Users:** pick or create a username (no password, for local use). Every row is scoped by `user_id`.

## Memory design (3 layers)
| Layer | What | Written how |
|---|---|---|
| Messages | every message, timestamp, `user_id`, `conversation_id`, sources | appended (raw log) |
| Conversation notes | per-conversation summary, topics, **claims** (entity, fact such as price, source URL, as-of date) | **rewritten** after each turn |
| User profile | lasting facts ("sales team of 20", "evaluating CRMs", preferences) | **rewritten/merged**: one compact profile per user, edited in place, never a growing pile |

### Memory map (tables in the same SQLite file)
- **things**: `id, user_id, name, type, aliases, website` (for example `Neon | Postgres hosting | neon.tech`).
- **links**: `from → kind → to`, for example `chat #12 → mentions → Neon` or `Neon → is a → Postgres hosting`.
- **facts**: `thing, field, value, source URL, checked_at, chat_id` (for example `Neon | price | $19/mo | neon.tech/pricing | 2026-11-03`). Old facts are kept, never overwritten, so we can say what changed.
- **loops**: `id, user_id, chat_id, text, status (open/closed), opened_at, closed_at` (for example "pick a CRM from the 5 shortlisted").
- **decisions**: `id, user_id, thing, choice, reason, decided_at, chat_id` (for example "CRM | HubSpot | cheapest for 20 seats | 2026-11-12").
- Indexes: (user_id, date), thing name/aliases, FTS5 on messages.

### How a lookup works
1. Code reads the date (chrono) and matches thing names/aliases. If both are clear, there's no router AI call.
2. Date = strict filter. The map gives candidate chats; ranking uses the words in the question, the thing's type and the source chat.
3. The **real saved messages** of the chosen chats go into the prompt. The map only points; it never answers.
4. One clear match → use it. Several that agree → use all. Several that disagree → ask the user. None → say "I can't find that chat".
5. Facts checked in the last 24h are reused without a web search, except for "has it changed / still correct?" questions, which always search fresh.

### Accuracy rules (right answer first, speed second)
- Every thing has a type ("Apollo (sales tool)" ≠ "Apollo (coding tool)").
- Unsure → keep things separate. Join only when sure: same website, or the user confirms.
- Each user's profile and thing names are held in server memory; the cache is refreshed after each memory update.

### Seeding (tests only)
- `npm run seed` adds back-dated pretend chats (Mon CRM shortlist, Tue 3 Nov Postgres hosting) through the **same saving path** as real chats.
- Every seeded row is labeled `seed`; `npm run seed:clear` removes them. Real use starts empty.

### Extra features
Why: minimi's app finds open loops and nudges only when it matters; these features bring the same idea to the chat agent for the same users (busy founders and team leads).
- **Open loops:** the background step spots unfinished things and saves them as open loops. When a new chat starts, the open ones are shown ("You still haven't picked a CRM from Monday"). When the user decides, the loop is closed.
- **"Still true?" check:** when an old fact (older than 24h) comes up in a chat, it gets re-checked with a web search. The agent only mentions it if the value changed.
- **Decision log:** the background step saves decisions with a reason. They go into the prompt, so ruled-out options are not suggested again.

Embeddings (number-vectors for meaning search) are on the "next week" list, not v1.

## Files to create
```
package.json, tsconfig.json, .env.example (GEMINI_API_KEY, EXA_API_KEY, TAVILY_API_KEY optional, GEMINI_MODEL, GEMINI_FAST_MODEL, SEARCH_MODE, PORT, DB_PATH)
src/config.ts          settings from .env (done)
src/app.ts             Express app + routes: /api/health, /api/users, /api/me, /vendor (page libraries) (done)
src/db.ts              users, chats, messages, app_state, things, mentions, facts (done)
src/users.ts           name check + user guard (X-User-Id) (done)
src/chats.ts           /api/chat (ask + save, SSE), /api/chats, /api/chats/:id (done)
src/server.ts          starts the app (done)
src/agent.ts           per-turn flow: route → retrieve → answer → background memory update
src/search.ts          web_search: Exa main, Tavily backup, fake for tests (done)
src/context.ts         chat note, code-built searches, path choice (done)
src/llm.ts             Gemini wrapper (stream + web_search tool calls, JSON-mode calls)
src/dates.ts           chrono-node resolution with timezone + "today" injection
src/things.ts          same-thing-or-not rules, join later (done)
src/extract.ts         card writer: ask → check → save (done)
src/memory/retrieve.ts date filter + map lookup + ranking + "ask user" when unclear
src/memory/consolidate.ts  rewrite map, chat notes + user profile (join only when sure)
scripts/seed.ts        seed / clear pretend chats (label "seed")
tests/tricky.test.ts   tricky-question test list (same names, same topic different days, changed prices)
src/prompts.ts         planner + writer prompts (done); consolidation prompts later
public/index.html, public/app.js, public/style.css   chat page + What I remember page (done)
notes.md               dev notes (see below)
.claude/skills/notes/SKILL.md   /notes skill
CLAUDE.md              short: commands + architecture (after code exists)
```

## notes.md + `/notes` skill (self-learning loop)
- `notes.md` holds the running notes for the final DESIGN.md. Its fixed sections mirror DESIGN.md: **How it works · Why this way · Considered & rejected · Open problems / next week · Learnings**.
- `/notes` skill: reads the current `notes.md` plus recent changes (git diff/log and the session), then **rewrites the affected section in place**. It merges duplicates, updates stale points, removes things that are no longer true, and keeps it to about one page. It never appends a dated log entry on top.
- The agent's memory uses the same "rewrite, don't pile up" rule, which keeps the design consistent.
- At the end, DESIGN.md is drafted from `notes.md`.

## Build phases
How we work: each phase = what + why + small steps. After every step: test, then commit. In the last step of each phase: run `/notes` and include notes.md + plan.md in that step's commit (no separate commit).
Tests: Vitest. Quick tests (`npm test`, fake Gemini) in every phase; live tests (`npm run test:live`, real Gemini) now and then.

- **Phase 0 – Setup:** ✔ done. Empty project, Vitest, `npm run dev` shows a blank page.
  1. `package.json`, `tsconfig.json`, TypeScript + tsx + Vitest, one example test.
  2. `.env.example` + `src/config.ts` (clear message if the Gemini key is missing).
  3. Express server + blank page + `/api/health`.
- **Phase 1 – Basic chat:** ✔ done. Gemini + web search, streaming, source links. Code builds searches first; AI planner as backup (SEARCH_MODE switch).
  1. Web search + settings: Exa first, Tavily backup, clear error if both fail, fake search for tests.
  2. Gemini (`src/llm.ts`): streaming, web_search tool calls (several at once), fake Gemini for tests.
  3. `/api/chat`: streams progress, answer text and sources; main prompt (shown to the user first).
  4. Chat page: text box, word-by-word answer, progress lines, source links; live browser check.
- **Phase 2 – Saving chats:** ✔ done. Users, chat list, messages saved with dates; user-tested in the browser.
- **Phase 3 – Memory map:** ✔ done. Things, links and facts saved after each reply; "What I remember" page.
- **Phase 4 – Remembering:** dates, finding the right old chat, "still true?" answers.
- **Phase 5 – Extra features:** open loops, "still true?" check, decision log.
- **Phase 6 – Big check:** seed data, the 3 example questions, the tricky list, two users kept separate.
- **Phase 7 – Finish:** polish, CLAUDE.md, README, DESIGN.md.

Per your instructions, I'll show you the exact text of the prompts, the `/notes` skill and CLAUDE.md before saving them. Commits won't have a co-author line.

## Verification
- `npm install && npm run dev` from a clean clone, then open `http://localhost:PORT`.
- Seed test: a script inserts back-dated conversations (a CRM shortlist "on Monday", Postgres hosting on 2026-11-03), then asks the three example questions. Check that it finds the right past conversation, quotes the old answer, searches, and reports changes with sources.
- Tricky tests: same name with two types, same topic on two days, a changed price, a date with no chat (must say "can't find"), two matches that disagree (must ask).
- Features: a loop opens and later closes; a ruled-out option is not suggested again; an unchanged old fact is not mentioned.
- Two users: user B can't see user A's memory.
- Run `/notes` twice. `notes.md` should stay one page, with no duplicate points.

## Open points to confirm
- Free limits: Exa 2,500/month, Tavily 1,000/month. Watch usage during live tests.
- Compare SEARCH_MODE code-first vs planner on fresh questions, then pick the default.
- Node ≥22.13 is required for `node:sqlite` (you have 24.22 ✔). If the grader might use older Node, switch to `sql.js`.
