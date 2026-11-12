// Dates in questions → real time ranges, in the user's own time zone. Plain code, no AI.
// "last Tuesday", "on Monday", "3 November", "yesterday", "last week" …
// A range is [from, to): from is included, to is not. Both are UTC ISO times, ready for the database.

export interface DateRange {
  from: string;
  to: string;
  label: string; // for people: "Tue 10 Nov", "3–9 Nov"
  phrase: string; // the words that gave this range, e.g. "last Tuesday"
  // For weekday words ("last Tuesday"): the same weekday one week earlier, in case
  // the user meant that one and there was no chat on the most recent one.
  weekEarlier?: DateRange;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DAY_MS = 24 * 60 * 60 * 1000;

interface Ymd { y: number; m: number; d: number } // m: 1-12

// --- Time zone helpers ----------------------------------------------------------

function validZone(tz?: string): string {
  if (tz) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { /* fall through */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// The calendar date (and weekday) at this moment, in the time zone.
function localDate(at: Date, tz: string): Ymd & { weekday: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "long" })
      .formatToParts(at).map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: WEEKDAYS.indexOf(p.weekday.toLowerCase()) };
}

// How far the time zone is ahead of UTC at this moment, in ms (India: +5:30).
function zoneOffset(at: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(at)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
}

// The UTC moment when this calendar day starts (midnight) in the time zone. Handles summer-time changes.
function startOfDay({ y, m, d }: Ymd, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - zoneOffset(guess, tz);
  t = guess - zoneOffset(t, tz); // second pass in case the offset changed in between
  return t;
}

// Calendar arithmetic (no time zone involved).
function addDays(day: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function dayLabel(day: Ymd): string {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d));
  return `${WEEKDAYS[t.getUTCDay()].slice(0, 3).replace(/^./, (c) => c.toUpperCase())} ${day.d} ${MONTHS[day.m - 1].slice(0, 3).replace(/^./, (c) => c.toUpperCase())}`;
}

function rangeOfDays(first: Ymd, days: number, tz: string, phrase: string): DateRange {
  const last = addDays(first, days - 1);
  const label = days === 1 ? dayLabel(first) : `${dayLabel(first)} – ${dayLabel(last)}`;
  return { from: new Date(startOfDay(first, tz)).toISOString(), to: new Date(startOfDay(addDays(first, days), tz)).toISOString(), label, phrase };
}

// --- Reading the question ---------------------------------------------------------

// Finds the first date phrase in the question and turns it into a range. Undefined if there is none.
export function findDateRange(question: string, now: Date = new Date(), timeZone?: string): DateRange | undefined {
  const tz = validZone(timeZone);
  const q = ordinalWordsToNumbers(question.toLowerCase().replace(/[’']/g, "'"));
  const today = localDate(now, tz);
  const one = (day: Ymd, phrase: string) => rangeOfDays(day, 1, tz, phrase);

  // ISO date: 2026-11-03
  let m = /\b(20\d\d)-(\d\d)-(\d\d)\b/.exec(q);
  if (m) {
    const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    if (validDay(day)) return one(day, m[0]);
  }

  // "3 November", "3rd of Nov", "November 3", "Nov 3rd, 2026"
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH_RE}(?:,?\\s+(20\\d\\d))?\\b`).exec(q)
    ?? swapMonthFirst(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d\\d))?`).exec(q));
  if (m) {
    const month = monthIndex(m[2]) + 1;
    const d = Number(m[1]);
    let y = m[3] ? Number(m[3]) : today.y;
    // No year and the date is still ahead → it was last year ("3 December" said in November).
    if (!m[3] && (month > today.m || (month === today.m && d > today.d))) y -= 1;
    const day = { y, m: month, d };
    if (validDay(day)) return one(day, m[0].trim());
  }

  // "the 3rd", "on the 10th", "since the 10th", "tuesday the 3rd": a day of this month,
  // or of last month if that day hasn't come yet. Checked before weekdays, so "tuesday the 3rd" = the 3rd.
  m = /\bthe (\d{1,2})(?:st|nd|rd|th)\b/.exec(q);
  if (m) {
    const d = Number(m[1]);
    const day = d <= today.d ? { y: today.y, m: today.m, d } : addMonths({ y: today.y, m: today.m, d }, -1);
    if (validDay(day)) return one(day, m[0]);
  }

  if ((m = /\b(day before yesterday)\b/.exec(q))) return one(addDays(today, -2), m[1]);
  if ((m = /\b(yesterday)\b/.exec(q))) return one(addDays(today, -1), m[1]);
  if ((m = /\b(earlier today|today|this morning|this afternoon|this evening|tonight)\b/.exec(q))) return one(today, m[1]);

  // "3 days ago", "a couple of days ago"
  if ((m = /\b(\d{1,2}|a|one|two|three|four|five|six|seven) days? ago\b/.exec(q))) {
    const n = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 }[m[1] as "a"] ?? Number(m[1]);
    return one(addDays(today, -n), m[0]);
  }

  // Weekdays: "on Monday", "last Tuesday", "this Wednesday", "Tuesday"
  m = new RegExp(`\\b(last|this|on|past)?\\s*${WEEKDAY_RE}\\b`).exec(q);
  if (m) {
    const wanted = weekdayIndex(m[2]);
    let back = (today.weekday - wanted + 7) % 7; // 0 = today
    // "last Tuesday" said on a Tuesday means a week ago; plain "Tuesday" on a Tuesday means today.
    if (back === 0 && m[1] === "last") back = 7;
    const phrase = m[0].trim();
    const range = one(addDays(today, -back), phrase);
    range.weekEarlier = one(addDays(today, -back - 7), `${phrase} (a week earlier)`);
    return range;
  }

  // Weeks: "last week" (Monday–Sunday before this one), "this week" (Monday until today)
  const monday = addDays(today, -((today.weekday + 6) % 7));
  if ((m = /\b(last week|past week)\b/.exec(q))) {
    return m[1] === "past week" ? rangeOfDays(addDays(today, -6), 7, tz, m[1]) : rangeOfDays(addDays(monday, -7), 7, tz, m[1]);
  }
  if ((m = /\b(this week|earlier this week)\b/.exec(q))) {
    return rangeOfDays(monday, ((today.weekday + 6) % 7) + 1, tz, m[1]);
  }

  return undefined;
}

function addMonths({ y, m, d }: Ymd, n: number): Ymd {
  const total = y * 12 + (m - 1) + n;
  return { y: Math.floor(total / 12), m: (total % 12) + 1, d };
}

// "the third of November" → "the 3rd of november". Only after "the" or before "of",
// so "first time" or "a second" are left alone.
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"];
function ordinalNumber(word: string): number | undefined {
  const w = word.replace(/-/g, " ").trim();
  const i = ORDINALS.indexOf(w);
  if (i >= 0) return i + 1;
  const m = /^(twenty|thirty) (\w+)$/.exec(w);
  if (!m) return w === "thirtieth" ? 30 : undefined;
  const unit = ORDINALS.indexOf(m[2]);
  if (unit < 0 || unit > 8) return undefined;
  const n = (m[1] === "twenty" ? 20 : 30) + unit + 1;
  return n <= 31 ? n : undefined;
}
function ordinalWordsToNumbers(q: string): string {
  const word = "((?:twenty|thirty)[ -])?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)";
  const swap = (_: string, before: string, tens: string | undefined, unit: string, after: string) => {
    const n = ordinalNumber(`${tens ?? ""}${unit}`);
    return n ? `${before}${n}th${after}` : `${before}${tens ?? ""}${unit}${after}`;
  };
  // Not when a noun follows: "the first time", "the second one", "the third question".
  const notNoun = "(?!\\s+(?:time|times|one|ones|thing|things|step|place|option|options|question|answer|chat|try|attempt|plan|tool|item)\\b)";
  return q
    .replace(new RegExp(`(\\b${MONTH_RE} )${word}(\\b)`, "g"), (all, before: string, _month: string, tens: string | undefined, unit: string, after: string) => swap(all, before, tens, unit, after)) // "november third"
    .replace(new RegExp(`(\\bthe )${word}${notNoun}(\\b)`, "g"), swap)
    .replace(new RegExp(`(\\b)${word}( of\\b)`, "g"), swap);
}

// "Nov 3, 2026" matched as (month, day, year) → reorder to (day, month, year) like the other pattern.
function swapMonthFirst(m: RegExpExecArray | null): RegExpExecArray | null {
  if (!m) return null;
  const swapped = [m[0], m[2], m[1], m[3]] as unknown as RegExpExecArray;
  swapped.index = m.index;
  return swapped;
}

function monthIndex(word: string): number {
  return MONTHS.findIndex((name) => name.startsWith(word.replace(/\.$/, "").slice(0, 3)));
}

function weekdayIndex(word: string): number {
  return WEEKDAYS.findIndex((name) => name.startsWith(word.slice(0, 3)));
}

function validDay({ y, m, d }: Ymd): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return m >= 1 && m <= 12 && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
