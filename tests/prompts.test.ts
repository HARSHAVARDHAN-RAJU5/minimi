import { describe, it, expect } from "vitest";
import { plannerPrompt, todayText, writerPrompt } from "../src/prompts.js";

// 11 Nov 2026, 20:00 UTC = already 12 Nov in India (UTC+5:30 → 01:30).
const now = new Date("2026-11-11T20:00:00Z");

describe("prompts", () => {
  it("uses the user's own date and time zone", () => {
    expect(todayText("Asia/Kolkata", now)).toEqual({ date: "Thursday, 12 November 2026", timezone: "Asia/Kolkata" });
    expect(todayText("America/New_York", now)).toEqual({ date: "Wednesday, 11 November 2026", timezone: "America/New_York" });
  });

  it("falls back to the server's time zone when the given one is bad or missing", () => {
    const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(todayText("Not/AZone", now).timezone).toBe(server);
    expect(todayText(undefined, now).timezone).toBe(server);
  });

  it("puts today's date at the top of both prompts", () => {
    expect(plannerPrompt("Asia/Kolkata", now)).toMatch(/^Today is Thursday, 12 November 2026 \(Asia\/Kolkata\)\./);
    expect(writerPrompt("Asia/Kolkata", now)).toMatch(/^Today is Thursday, 12 November 2026 \(Asia\/Kolkata\)\./);
  });

  it("keeps the key rules", () => {
    expect(plannerPrompt()).toContain("One search per product or company");
    expect(writerPrompt()).toContain("Never invent numbers");
    expect(writerPrompt()).toContain("like [1] or [2, 3]");
  });
});
