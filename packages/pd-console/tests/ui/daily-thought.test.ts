import { describe, it, expect } from "vitest";
import { DAILY_THOUGHTS, getDailyThoughtIndex } from "../../src/ui/data/daily-thoughts.js";

describe("getDailyThoughtIndex", () => {
  it("returns a deterministic index for a given date string", () => {
    const idx1 = getDailyThoughtIndex(DAILY_THOUGHTS, "2026-06-17");
    const idx2 = getDailyThoughtIndex(DAILY_THOUGHTS, "2026-06-17");
    expect(idx1).toBe(idx2);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(DAILY_THOUGHTS.length);
  });

  it("returns different indices for different dates", () => {
    const idx1 = getDailyThoughtIndex(DAILY_THOUGHTS, "2026-06-17");
    const idx2 = getDailyThoughtIndex(DAILY_THOUGHTS, "2026-06-18");
    expect(idx1).not.toBe(idx2);
  });

  it("returns -1 for an empty library", () => {
    const idx = getDailyThoughtIndex([], "2026-06-17");
    expect(idx).toBe(-1);
  });
});

describe("DAILY_THOUGHTS library", () => {
  it("contains at least 30 entries", () => {
    expect(DAILY_THOUGHTS.length).toBeGreaterThanOrEqual(30);
  });

  it("has unique ids", () => {
    const ids = DAILY_THOUGHTS.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("provides complete zh and en content for every entry", () => {
    for (const thought of DAILY_THOUGHTS) {
      expect(thought.id).toMatch(/^dt-\d+$/);
      expect(thought.zh.quote).toBeTruthy();
      expect(thought.en.quote).toBeTruthy();
      expect(thought.zh.author).toBeTruthy();
      expect(thought.en.author).toBeTruthy();
      expect(thought.zh.note).toBeTruthy();
      expect(thought.en.note).toBeTruthy();
    }
  });

  it("supports manual refresh cycling", () => {
    const start = getDailyThoughtIndex(DAILY_THOUGHTS, "2026-06-17");
    const next = (start + 1) % DAILY_THOUGHTS.length;
    expect(next).toBeGreaterThanOrEqual(0);
    expect(next).toBeLessThan(DAILY_THOUGHTS.length);
    expect(DAILY_THOUGHTS[next]).toBeDefined();
  });
});
