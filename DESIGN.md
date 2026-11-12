# minimi chat agent: design

The challenge: *build the best chat agent you can, with one tool, web search. It should be fast,
accurate, and remember what you asked and when.*

## 0. The first decision: who is this for?

Before writing any code, I asked who would actually use this. A chat agent "for everyone" is just a
worse copy of the chat apps that already exist.

So I did a quick background check on minimi. They make a Mac app that **finds your open loops** (things
you started but never finished) and **nudges you at the right moment**, staying quiet otherwise. Their
users are **busy founders and team leads**: people juggling many jobs who shortlist tools on Monday,
get pulled into something else, and forget where they left off.

**Decision: build the agent a minimi customer would use.** It remembers your past research and tells
you what changed. The challenge's own example questions fit that person exactly:
- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

That choice shaped everything after it: memory by **date and topic**, **then vs now** answers with
sources, and three features on top of the memory that bring minimi's idea into a chat (details in §6):
- **Open loops:** a shortlist you haven't decided on yet stays open until you pick.
- **"Still true?" check:** old facts are re-checked, and mentioned **only if something changed**.
- **Decision log:** the agent remembers what you chose and why, and doesn't push options you ruled out.

---

## 1. How it works

When a message comes in:

1. **Easy questions skip the AI.** Small talk ("thanks!") gets no search. A product never mentioned before ("What does Railway cost?") gets searches built by code in under 1 ms.
2. **Otherwise the "listener" reads it.** The fast AI model fills a short form: is this new, a follow-up, a memory question or small talk; which products; the time words ("last Tuesday"); what's being looked for (a date, a topic, *my last question*, *a decision*, *a fact about me*); and the searches to run.
3. **Code checks the form and does the work.** It turns time words into real dates in the user's time zone. The AI never does date maths. Then it finds the old chat, the last question, the decision, or the user's own earlier message, and reads the **real saved messages**. If the form is broken or slow (over 5 s), the older code rules handle the question instead, so it never gets stuck.
4. **Search.** For a memory question, code searches **every** remembered product (none can be forgotten). All searches run at the same time.
5. **Answer.** The writer gets THEN (the old chat and the facts saved then) and NOW (fresh results), and writes the answer word by word with sources. If nothing was found, it says so and doesn't invent anything.
6. **Remember.** After the answer, the fast model writes "memory cards" (products, prices, sources). Code checks every card before saving it.

**Why a hybrid (AI understands, code acts):** I first built it with code rules alone. They scored 10/10 on
my own test chats but only **4/10 on chats an AI wrote**, because rules only fit the wordings they were made for.
The AI understands any wording. Code is better at exact dates, database lookups and checking facts.
So each does what it's good at, and the old rules stay as the backup.

## 2. Tech stack

The whole app needs only **4 libraries** at run time (`@google/genai`, `express`, `marked`, `dompurify`).
Fewer parts means a reliable `npm install` and less to break.

### AI models: Google Gemini, two models picked by code
- **What:** `gemini-3.8-flash` writes the answers. `gemini-3.5-flash-lite` does everything else: the listener, memory cards, the backup planner, and the backup writer. Both can be changed in `.env`.
- **Why:** the smart model is used only where the user reads the result. The fast one (about 1 s for small jobs) handles background work, so it never holds up the answer. Code, not the AI, decides which model does which job.
- **Free:** everything in this project runs on free tiers. Gemini's free models, free search keys with no card, and a local database mean anyone can run it with their own keys. Free tiers have limits, so the design plans for them:
  - `gemini-3.8-flash` allows only 20 requests a day and is often busy. If it sends nothing in **8 s**, the fast model writes the answer and 3.8 rests for 5 minutes. When the daily quota runs out, 3.8 is skipped until Google's reset time. That time is saved in the database, so a restart doesn't waste a request.
  - If the backup sends nothing in **20 s**, the user gets a clear "please try again" instead of a spinner.
  - If Google stops mid-answer ("busy"), the partial answer is saved, marked "stopped".
- **How it works:** through Google's official SDK (`@google/genai`), with streaming, so words arrive as they're written.

### Web search: Exa, with Tavily as backup
- **What:** the model gets exactly one tool, `web_search`. When it calls the tool, *our code* runs the search.
- **Why:** we see every result and every source, so we can show links, save facts with their source, and check memory cards against real pages. Exa uses its quickest search mode (about 0.5 s per search) and has the bigger monthly limit. Tavily takes over automatically if Exa fails or runs out, so one outage doesn't stop the app.
- **How it works:** the model (or code, for easy questions) asks for searches; code runs them all at the same time and numbers the results [1], [2]… so the answer can cite them.

### Runtime: Node.js 24 + TypeScript
- **Why:** required by the challenge (JS/TS on Node). TypeScript catches mistakes before running, which matters with many moving parts (the listener form, memory cards, events).
- **How it works:** **tsx** runs the TypeScript files directly, so there's no build step. `npm run dev` uses `tsx watch` (restarts on code changes).

### Server: Express 5
- **Why:** small, well known, and enough for a handful of routes (chat, chats, memory, loops, users). Express 5 handles async errors on its own.
- **How it works:** one server serves both the API and the web page. Answers stream to the browser with **SSE** (Server-Sent Events, a one-way live stream), sending small events: `recall` (old chat found), `search`, `text`, `sources`, `done`, `error`. The user sees progress and the first words in about 1–5 s instead of a blank screen.

### Database: SQLite built into Node (`node:sqlite`)
- **Why:** comes with Node, so there's nothing native to compile and `npm install` doesn't fail on Windows. One file on the user's computer, so it's private like minimi, with no server to run. It also includes **FTS5**, a built-in word-search index.
- **How it works:** tables for messages, the memory map, loops and settings (§3). The schema has a version number and upgrades itself.

### No agent framework
- **Why:** no LangChain or similar. The agent is a small loop of our own: listen → find → search → write → remember. That keeps every step visible, testable and fast, with no hidden prompts or extra AI calls.

### Web page: plain HTML + JavaScript, no build step
- **Why:** it's easy to browse past chats and the "What I remember" page, and there's nothing extra to install or compile.
- **How it works:** **marked** turns the answer into formatted text (tables, lists), and **DOMPurify** cleans it, so nothing a web page returns can run code in the browser. Both are served straight from `node_modules`.

### Settings: Node's built-in `.env` loader
- **Why:** no extra library (no dotenv). Every key is listed in `.env.example`, as the challenge requires.
- **How it works:** the page opens even without keys; chatting then shows a clear "add your key" message.

### Tests: Vitest
- **Why:** fast, and works with TypeScript as-is.
- **How it works:** most tests use a **fake Gemini and fake search**, so they're quick, use no quota, and give the same result every time. Real-AI checks are separate scripts (`npm run eval:*`), run now and then, and they save every result as it arrives.

## 3. Memory design

Memory is code around the model, so **web search stays the model's only tool**.

| Table | Holds | Why |
|---|---|---|
| `messages` | Every question and answer, with exact time, time zone, sources and searches | The source of truth. Answers always come from these, never from a summary |
| `things` | Products and companies: name, kind, website, other names | Finds chats by meaning ("database hosting" → the Neon chat) |
| `mentions` | Which chat mentioned which thing, and when | Links chats to things |
| `facts` | A value (e.g. "Launch price $19/month"), its source and when it was checked. **Old values are kept** | So it can say exactly what changed |
| `loops` | Open decisions ("pick one: HubSpot, Pipedrive…"), and how they were closed | Open loops and the decision log |
| `messages_fts` | A word-search index over every message | Finds chats by the user's own words, for questions like "what was our budget?" |

Key choices:
- **Question saved before answering**, answer saved after. A failed answer never loses the question.
- **Memory cards are checked by code.** The product must be named in the chat, every number in a fact must appear in the answer, and the source must be one we really fetched. Cards that fail are dropped and logged. This stops the AI from inventing prices.
- **Separate users.** Every database read is filtered by user.
- **Stored on the user's computer.** No cloud database: private like minimi, and nothing to set up.

## 4. Other decisions and why

| Decision | Why |
|---|---|
| Built for minimi's customers (busy founders and team leads), not "everyone" | A general chatbot copies existing apps; this user needs memory of past research and "what changed" (§0) |
| Three minimi-style features: open loops, "still true?", decision log | minimi's core idea, finding open loops and nudging only when it matters, inside a chat |
| Listener (AI) + code, old rules as backup | AI understands any wording; code is exact and checkable (4/10 → 10/10 on unseen follow-ups) |
| Code does all date maths | AI models get "last Tuesday" wrong; code gets it right every time, in the user's time zone |
| Dates are a strict filter | "On Monday" must mean Monday. If there's no match, it says so; for "last Tuesday" it also checks one week earlier and says it did |
| The memory map only *points*; answers come from real saved messages | A summary can drift; the saved message can't |
| Old facts kept, never overwritten | "Has it changed?" needs both values with dates |
| Unsure whether two things are the same → keep them apart | Two "Apollo"s (a sales tool and a coding tool) must not merge; joining later is safe, splitting is not |
| A product the user names must appear in the old chat | Stops false matches through shared words ("Figma plan" was matching a Linear "plan" chat) |
| Old answers lose their [n] citation numbers | They pointed to old sources and would confuse today's citations |
| Name only, no password | A stand-in for login in a local app; real login is on the next-week list |
| Seed script (`npm run seed`) | Puts in pretend past chats through the same saving code, so the 3 example questions can be tried right away. `seed:clear` removes only those |

## 5. Speed

Every AI call costs seconds, so the main speed rule is: **don't call the AI when code can do the job.**

- Easy questions skip the listener. Small talk skips search entirely.
- Code builds searches for plain questions (under 1 ms, vs 1–14 s for an AI planner).
- All searches run at the same time, about 0.5 s each.
- Open loops, the still-true check and the decision log use **no extra AI call**: code picks what to pass, and the writer only phrases it.
- Memory cards are written after the answer, so the user never waits for them.
- If the main writer is slow, the switch to the fast model happens at 8 s, not after Google's own ~30 s timeout.

Measured (fast model writing, real search): small talk ~1 s; "what was my last question?" ~1 s; a
follow-up ~2.5 s; "what did I ask on 3 November, is it still correct?" 3 s; the 5-CRM question
(10 searches) 6.5 s to the full answer. Skipping the AI planner cut the first word from ~10 s to ~4 s
with the same correctness. Most of the remaining time is the writer, not search (search is under 1 s).

## 6. Extra features (from minimi's own idea: remember, and nudge at the right moment)

- **Open loops.** When you compare or shortlist 2+ options, code opens a loop. It closes when you say "we went with X" (in any chat) or press Done. Open loops show on the New chat screen.
  *Why:* busy people forget half-finished decisions; this is minimi's core idea.
- **"Still true?" check.** When you ask about something we discussed before, the writer gets the old values (only the ones about what you asked: prices only for price questions) and adds one line **only if a value changed**.
  *Why:* the example questions ask "is it still correct?", and staying quiet otherwise matches "nudge only when it matters".
- **Decision log.** A closed loop becomes a decision, with the choice, the options ruled out, the date and the reason after "because". Later questions build on the choice instead of suggesting ruled-out options again.
  *Why:* suggesting an option you already ruled out feels like the agent forgot.

## 7. Test results

All tests below use AI-written questions the code was **not** tuned on, because my own test cases gave scores that were too high.

| Test | Result |
|---|---|
| Code tests (Vitest, fake AI) | **250 / 250** pass |
| Memory: 30 AI-written questions, 10 kinds (date only, name only, "last week", "in October", my last question, facts about me, what did we decide, still correct?, other words for the same thing, never discussed) | **29 / 30** (before the listener: 13 / 30). The one "miss" is a bad test question: it says "last Tuesday" but expects 3 Nov; the agent correctly picked 10 Nov |
| Recall wordings: 30 different ways to ask the 3 example questions | 30 / 30 on the set I fixed against; **29 / 30 on a fresh unseen set** (only "3/11" fails: day/month order is unclear) |
| Follow-ups: 10 AI-written two-turn chats ("and X?", "is it cheaper?", "who runs it now?") | **10 / 10** with the listener (code rules alone: 4 / 10) |
| The 3 assignment questions (real AI, seeded history) | All correct: right old chat, every product searched, then vs now with sources |
| Tricky list (same name for two things, same topic on two days, a changed price, a day with no chat, several chats on one day, two users kept apart) | **6 / 6** |
| Tricky questions on the real AI (a day with no chat, something never discussed, my last question, a 3-step follow-up) | All correct; honest "not found" where nothing existed |
| Clean install from a fresh clone | `npm install` in 12 s; works with and without keys (without, the page explains which key to add) |
| User test: 12 real-user stories in the browser | Found 7 small issues the code tests missed; 5 fixed the same day |

Not yet tested: **answers written by 3.8.** On test day Google's 3.8 was overloaded (42 s to say "ok", then a
503 "high demand" error). The app's switch to the fast model handled it, and all results above are with
the fast model writing.

## 8. Considered and rejected

| Option | Why not |
|---|---|
| Gemini's built-in Google search | We wouldn't see every result and source, so we couldn't save facts with sources or check them |
| Google Custom Search API | Closed to new sign-ups, shutting down |
| A graph database (Neo4j) | An extra install; breaks the simple `npm install` → `npm run dev` |
| An agent framework (LangChain etc.) | Hidden prompts and extra calls; our own small loop is faster and easier to test |
| Code word lists for every wording | Fit only the cases they were written for (4/10 on unseen); kept as the backup only |
| Filling memory ahead with searches | Memory is about *your* chats; facts are checked live when needed |
| Searching alongside the planner, or shorter search results | No speed gain when measured |
| A terminal UI | Harder to browse past conversations |

## 9. Known limits and next steps

- **Writing slips with the fast model:** sometimes "[THEN]" marks, or "Changed" next to "Couldn't confirm". The facts and sources are right; 3.8 should help.
- **Listener time:** usually 1–1.5 s, sometimes 5–6 s when Google is busy (then the old rules answer).
- **"3/11"-style dates** are ambiguous (3 Nov or 11 Mar), so they aren't guessed.
- **Unusual decision wording** ("Pipedrive it is") doesn't close a loop; the Done button is the backup.
- **Next:** meaning-based search (embeddings) for finding old chats, real login, and a hosted demo.
