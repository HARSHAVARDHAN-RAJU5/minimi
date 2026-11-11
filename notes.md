# minimi — working notes
Source for DESIGN.md. Rewrite points in place; don't append logs. Keep it to about one page.

## Goal
A chat agent as good as online chat apps. Web search is its only tool. It remembers past
conversations by date and topic, so it can answer "Last Tuesday I asked about X. Has it changed?"
Users: busy founders and team leads who juggle many jobs (the same people minimi serves).
Status: Phase 0 (setup) done.

## Rules
- JS/TS on Node. Runs with `npm install` then `npm run dev`.
- Every API key listed in `.env.example`.
- Any model/framework.
- Must be fast, correct, and remember what the user asked and when. "Best architecture wins."
- Submit: GitHub repo with a design .md, a 60-second video, top 3 projects.

## How it works (planned)
1. Code turns dates like "last Tuesday" into real dates; a quick model call decides if old conversations are needed.
2. Code uses the memory map to find matching chats, then reads the real saved messages and facts (what was asked, answered, prices, sources, as-of date).
3. Model answers with web search on and compares "then" with "now", with sources.
4. Search results are saved while answering. After the reply, one background AI call updates the map, chat summary and user profile, rewriting them rather than appending.

## Decisions so far (and why)
- Model: Gemini. Free and fast.
- Search: Gemini's built-in Google Search grounding. Free and needs no extra key. Tavily is the fallback.
- UI: simple web page served by the Node server.
- Streaming: answers appear word by word, so the user never waits on a blank screen.
- Users: multiple, each with separate memory.
- Storage: built-in `node:sqlite`, kept only on the user's computer (no cloud database, like minimi). No native build, so `npm install` stays reliable.
- Memory is code around the model, so web search stays the only tool.
- Memory map: things (Neon, HubSpot) + links (chat → mentions → Neon) + facts with date and source. Stored as tables in the same SQLite file.
- Speed: ask the AI less (code reads dates and names first) and search the web less (reuse facts checked in the last day, except "has it changed?" questions).
- Seeding: pretend past chats with a "seed" label, for testing only. Same saving steps as real chats, deletable in one go. Real use starts empty.
- Way of working: small steps; test, then commit after each one; /notes after each phase.
- Tests: Vitest. Quick tests use a fake Gemini (fast, free, same result every time); live tests use the real one, run now and then.
- Server: Express + TypeScript run by tsx. Settings via Node's built-in .env loader (no extra library). The page opens even without a key; chatting shows a clear "add your key" message.

## Accuracy rules (right answer first, speed second)
- The map only points to chats; the answer always comes from the real saved messages.
- Dates are a strict filter.
- Every thing has a type ("Apollo (sales tool)" vs "Apollo (coding tool)").
- Unsure → keep separate. Pick using date, words and source chat; if two still fit and disagree, ask the user.
- Join copies only when sure (same website, or the user confirms).
- Old and new facts are both kept, each with its date.
- Nothing found → say so, never make it up.
- A test list of tricky questions, checked after every change.

## Extra features (match minimi: remember, and nudge at the right moment)
Why: this is minimi's assignment. Their app finds open loops, reminds at the right moment and stays quiet otherwise.
Their users are busy founders and team leads. These features show the agent fits that product and those users.
- Open loops: spot unfinished things ("shortlisted 5 CRMs, none picked yet"), remind in the next chat, close once done.
  Why: minimi's core idea; busy people forget half-finished decisions.
- "Still true?" check: re-check old answers when they come up; speak up only if something changed.
  Why: the example questions ask "is it still correct?"; staying quiet otherwise matches minimi's "nudge only when it matters".
- Decision log: save what was picked and why ("HubSpot, 12 Nov, price"); never re-suggest what was ruled out.
  Why: suggesting an option you already ruled out wastes time and feels like the agent forgot.

## Considered & rejected
- Claude / OpenAI: paid. Gemini is free.
- Terminal UI: harder to browse past conversations.
- Separate graph database (Neo4j): extra install, breaks the simple npm install → npm run dev setup.
- Filling memory ahead by searching: memory is about the user's own chats; facts get searched live when needed.
- Fake memory in real use: the agent would believe things the user never said.

## Open questions
- Gemini: current free model and search limits. Check in Phase 1 (default now gemini-2.5-flash).
- Final rule list: pending.

## Next week ideas
- Embeddings (meaning-based search) for finding past conversations.

## Learnings
- npm 11 skips esbuild's setup script and warns about it. Harmless: tests and dev server still work.
