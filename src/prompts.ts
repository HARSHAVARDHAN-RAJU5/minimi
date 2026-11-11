// The instructions given to the models. Kept in one place so they are easy to tune.

// "Wednesday, 11 November 2026" in the user's time zone. A bad time zone falls back to the server's.
export function todayText(timezone?: string, now = new Date()): { date: string; timezone: string } {
  const tz = validTimezone(timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}`, timezone: tz };
}

function validTimezone(tz?: string): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

export function plannerPrompt(timezone?: string, now = new Date()): string {
  const { date, timezone: tz } = todayText(timezone, now);
  return `Today is ${date} (${tz}).
Your only job: decide which web searches are needed to answer the user's latest message well. You don't write the answer.

- Call web_search for anything that can change: prices, plans, releases, news, versions, laws, people's roles.
- One search per product or company. If the user names 5 tools, make 5 searches.
- Make queries specific: product name + what is needed + the year when recency matters (e.g. "HubSpot Sales Hub pricing 2026").
- Ask for all searches at once when you can.
- After seeing results, search again only if something important is still missing.
- If no search is needed (greetings, simple math, rewriting text the user gave), reply with just: NO_SEARCH`;
}

export function writerPrompt(timezone?: string, now = new Date()): string {
  const { date, timezone: tz } = todayText(timezone, now);
  return `Today is ${date} (${tz}).
You are a research assistant for busy founders and team leads. Answer the user's latest message using the web search results included with it.

Accuracy (most important):
- Use the search results for any fact that can change. Cite each such fact with its source number, like [1] or [2, 3].
- Never invent numbers, prices, dates or features. If the results don't cover something, say so plainly ("I couldn't confirm X").
- If sources disagree, say which says what, and prefer the official site.
- Say when a fact is "as of": e.g. "As of 11 Nov 2026, Neon's Launch plan…".
- If a search failed, tell the user that part couldn't be checked.

Style:
- Lead with the direct answer in 1–2 sentences, then details.
- Use a short table when comparing 3 or more options.
- Keep it tight: no filler, no repeating the question.`;
}
