# minimi — working notes
Source for DESIGN.md. Rewrite points in place; don't append logs. Keep it to about one page.

## Goal
A chat agent as good as online chat apps. Web search is its only tool. It remembers past
conversations by date and topic, so it can answer "Last Tuesday I asked about X. Has it changed?"
Users: busy founders and team leads who juggle many jobs (the same people minimi serves).
Status: Phase 1 (basic chat) done: chat page, web search, streaming answers with sources.

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
- Models: Gemini (free). Code picks per job: gemini-3.8-flash for answers (smart; the user reads it), gemini-3.5-flash-lite for background chores like summaries, map updates and loops (fast; repeated a lot). Both can be changed in .env.
- Search: Exa main, Tavily backup (switches automatically if Exa fails or runs out). Gemini gets one tool, web_search; our code runs it, so we see every result and source. Why Exa: faster (about 0.5 s vs 1–2 s), 2,500 free searches a month vs 1,000, no card, so it works with the reviewer's free keys.
- UI: simple web page served by the Node server.
- Streaming: answers appear word by word, so the user never waits on a blank screen.
- Users: multiple, each with separate memory.
- Storage: built-in `node:sqlite`, kept only on the user's computer (no cloud database, like minimi). No native build, so `npm install` stays reliable.
- Memory is code around the model, so web search stays the only tool.
- Memory map: things (Neon, HubSpot) + links (chat → mentions → Neon) + facts with date and source. Stored as tables in the same SQLite file.
- Speed: code builds the searches when it finds a product name in the question or the chat's note (under 1 ms). The AI planner (lite, 1–14 s) is the backup when code finds nothing, or always with SEARCH_MODE=planner. If the planner breaks, search the question as-is.
- Chat note: the writer adds a hidden <note> {things, topic} at the end of each answer; the server cuts it out of the stream. Missing or broken → code builds it from the searches. Kept by the page for now; moves to the database in Phase 2.
- Seeding: pretend past chats with a "seed" label, for testing only. Same saving steps as real chats, deletable in one go. Real use starts empty.
- Models: 3.8-flash writes answers (only 20 free requests/day; after a daily-quota refusal it's skipped until Google's reset time and lite writes). flash-lite is the backup planner.
- Way of working: small steps; test, then commit after each one; /notes at the last step of each phase; notes go into that step's commit.
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
- Gemini's built-in Google search: not free on current models (only on gemini-2.5-flash, retired 1 Dec 2026). The paid tier would break for a reviewer with a free key.
- Google Custom Search API: closed to new sign-ups, shuts down 1 Jan 2027.
- Serper: free credits probably one-time, snippets only. Brave: needs a card.
- Searching straight away alongside the planner, and shorter search results: no speed gain in the eval.

## Open questions
- Final rule list: pending.
- Re-run speed tests with 3.8 writing (normal vs less thinking), 3 runs each, at a quiet time.
- Fresh test of code-built searches on 10 new chats. First test: code 10/10 vs AI planner 8/10, but the code was fixed against those same questions.

## Next week ideas
- Embeddings (meaning-based search) for finding past conversations.

## Learnings
- npm 11 skips esbuild's setup script and warns about it. Harmless: tests and dev server still work.
- Planner eval (11 Nov, partial): 4 simple questions, 3 runs each, before 3.8-flash hit its daily limit. Time to choose searches: flash-lite 3.5 s avg vs 3.8-flash 9.6 s avg. Both covered 100% of what was asked. 3.8-flash wrote the wrong year (2024) in its Vercel searches; flash-lite used 2026. The hard memory and multi-product questions were not reached.
- Evals must save each result as it arrives; the first run lost its early results when it stopped.
- Gemini sometimes cites as [n:2] instead of [2]; the citation reader accepts both.
- Speed eval: skipping the planner cut the first word from ~10 s to ~4 s and stayed correct. Every AI call costs seconds; search itself is 0.4–1.4 s.
- Gemini lite is sometimes overloaded (503 "high demand", 429 per minute); the same call swings 1–7 s. Compare versions in the same run.
- To stop a dev server, stop the whole tsx watch, not just its child, or it comes back on the next code change. For tests, use npm start and stop that exact process.
