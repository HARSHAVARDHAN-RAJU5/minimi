import { describe, it, expect } from "vitest";
import { findDateRange } from "../src/dates.js";

// Thursday 12 Nov 2026, 08:30 in India (03:00 UTC). In New York it is still Wednesday 11 Nov, 22:00.
const now = new Date("2026-11-12T03:00:00.000Z");
const IN = "Asia/Kolkata";
const NY = "America/New_York";
const r = (q: string, tz = IN) => findDateRange(q, now, tz);
const label = (q: string, tz = IN) => r(q, tz)?.label;

describe("days", () => {
  it("today, yesterday, day before yesterday", () => {
    expect(label("What did I ask earlier today?")).toBe("Thu 12 Nov");
    expect(label("what did we talk about yesterday")).toBe("Wed 11 Nov");
    expect(label("the day before yesterday")).toBe("Tue 10 Nov");
    expect(label("3 days ago")).toBe("Mon 9 Nov");
    expect(label("a day ago")).toBe("Wed 11 Nov");
  });

  it("a day in India runs from its own midnight to the next, in UTC", () => {
    expect(r("yesterday")).toMatchObject({ from: "2026-11-10T18:30:00.000Z", to: "2026-11-11T18:30:00.000Z", phrase: "yesterday" });
  });

  it("uses the user's own time zone: in New York it is still Wednesday", () => {
    expect(label("today", NY)).toBe("Wed 11 Nov");
    expect(r("today", NY)).toMatchObject({ from: "2026-11-11T05:00:00.000Z", to: "2026-11-12T05:00:00.000Z" });
  });
});

describe("weekdays", () => {
  it("'on Monday' and 'last Tuesday' mean the most recent one", () => {
    expect(label("On Monday we shortlisted 5 CRM tools")).toBe("Mon 9 Nov");
    expect(label("Last Tuesday I asked you about Postgres hosting")).toBe("Tue 10 Nov");
    expect(label("what did I ask on Tue")).toBe("Tue 10 Nov");
  });

  it("also gives the same weekday one week earlier, in case that was meant", () => {
    const tue = r("Last Tuesday I asked you about Postgres hosting")!;
    expect(tue.weekEarlier?.label).toBe("Tue 3 Nov");
    expect(tue.weekEarlier?.phrase).toBe("last tuesday (a week earlier)");
  });

  it("today's weekday: plain = today, 'last' = a week ago", () => {
    expect(label("what did I ask on Thursday")).toBe("Thu 12 Nov");
    expect(label("last Thursday")).toBe("Thu 5 Nov");
  });

  it("does not mistake words that only start like a weekday", () => {
    expect(r("I want to monitor this")).toBeUndefined();
    expect(r("Is Wednesday Addams on Netflix?")).toBeDefined(); // a real weekday word is still read
  });
});

describe("calendar dates", () => {
  it("'3 November', 'November 3', '3rd of Nov', 'Nov 3, 2026'", () => {
    for (const q of ["What did I ask you on 3 November?", "on November 3", "on the 3rd of Nov", "Nov 3, 2026", "2026-11-03"]) {
      expect(label(q)).toBe("Tue 3 Nov");
    }
  });

  it("a date still ahead this year means last year", () => {
    expect(r("on 3 December")).toMatchObject({ label: "Wed 3 Dec", from: "2025-12-02T18:30:00.000Z" });
  });

  it("an explicit year is kept", () => {
    expect(r("on 3 November 2025")?.from).toBe("2025-11-02T18:30:00.000Z");
  });

  it("'the 3rd' / 'since the 10th' / 'tuesday the 3rd': a day of this month, and it wins over a weekday", () => {
    expect(label("what did i ask on the 3rd")).toBe("Tue 3 Nov");
    expect(label("any updates since the 10th?")).toBe("Tue 10 Nov");
    expect(label("what did i ask you on tuesday the 3rd")).toBe("Tue 3 Nov");
    expect(label("back on Monday the 9th")).toBe("Mon 9 Nov");
    expect(label("on the 25th")).toBe("Sun 25 Oct"); // hasn't come yet this month → last month
    expect(r("for the 20 users")).toBeUndefined(); // a plain number is not a date
  });

  it("numbers written as words: 'the third of November', 'the twenty-first'", () => {
    expect(label("what I asked you on the third of November")).toBe("Tue 3 Nov");
    expect(label("third of nov")).toBe("Tue 3 Nov");
    expect(label("what i asked on november third")).toBe("Tue 3 Nov");
    expect(label("on Oct twenty-first")).toBe("Wed 21 Oct");
    expect(label("on the ninth")).toBe("Mon 9 Nov");
    expect(label("on the twenty-first of October")).toBe("Wed 21 Oct");
    expect(r("the first time I asked")).toBeUndefined(); // a noun follows: not a date
    expect(r("what was the third option?")).toBeUndefined();
    expect(r("a second opinion please")).toBeUndefined();
  });

  it("ignores impossible dates", () => {
    expect(r("on 31 November")).toBeUndefined();
  });

  it("handles the summer-time change in New York (1 Nov 2026)", () => {
    // Midnight 1 Nov is still summer time (UTC-4); midnight 2 Nov is winter time (UTC-5).
    expect(r("on 1 November", NY)).toMatchObject({ from: "2026-11-01T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" });
  });
});

describe("weeks", () => {
  it("'last week' is the Monday–Sunday before this week", () => {
    expect(r("what did I ask last week")).toMatchObject({ label: "Mon 2 Nov – Sun 8 Nov", from: "2026-11-01T18:30:00.000Z", to: "2026-11-08T18:30:00.000Z" });
  });

  it("'this week' is Monday until today", () => {
    expect(label("earlier this week")).toBe("Mon 9 Nov – Thu 12 Nov");
  });

  it("'past week' is the last 7 days including today", () => {
    expect(label("in the past week")).toBe("Fri 6 Nov – Thu 12 Nov");
  });
});

describe("no date", () => {
  it("returns nothing when the question has no date words", () => {
    for (const q of ["What does Neon cost?", "Compare HubSpot and Pipedrive", "is it still correct?", "Monitor my day"]) {
      expect(r(q)).toBeUndefined();
    }
  });
});
