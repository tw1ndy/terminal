import { describe, expect, it } from "vitest";
import { getLevelProgress, validateLevelThresholds } from "../src/levels";

describe("level threshold configuration", () => {
  it("allows levels to remain disabled until an owner configures them", () => {
    expect(validateLevelThresholds({})).toEqual({});
    expect(getLevelProgress(500, {})).toBeNull();
  });

  it("requires level one at zero XP and sequential, increasing thresholds", () => {
    expect(validateLevelThresholds({ "1": 0, "2": 100, "3": 250 }))
      .toEqual({ "1": 0, "2": 100, "3": 250 });
    expect(validateLevelThresholds({ "2": 100 })).toBeNull();
    expect(validateLevelThresholds({ "1": 1, "2": 100 })).toBeNull();
    expect(validateLevelThresholds({ "1": 0, "3": 250 })).toBeNull();
    expect(validateLevelThresholds({ "1": 0, "2": 100, "3": 100 })).toBeNull();
  });

  it("rejects malformed values and excessive level counts", () => {
    expect(validateLevelThresholds(null)).toBeNull();
    expect(validateLevelThresholds([])).toBeNull();
    expect(validateLevelThresholds({ "1": 0, "2": "100" })).toBeNull();
    expect(validateLevelThresholds({ "1": 0, "2": -1 })).toBeNull();
    expect(validateLevelThresholds(Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [String(i + 1), i])
    ))).toBeNull();
  });

  it("calculates the current level and XP remaining to the next level", () => {
    const thresholds = validateLevelThresholds({ "1": 0, "2": 100, "3": 250 });
    expect(thresholds).not.toBeNull();
    expect(getLevelProgress(0, thresholds!)).toEqual({
      level: 1, title: "Новичок", nextLevel: 2, xpToNext: 100
    });
    expect(getLevelProgress(180, thresholds!)).toEqual({
      level: 2, title: "Новичок", nextLevel: 3, xpToNext: 70
    });
    expect(getLevelProgress(250, thresholds!)).toEqual({
      level: 3, title: "Новичок", nextLevel: null, xpToNext: null
    });
  });

  it("returns no current level when the first configured threshold is not reached", () => {
    const thresholds = { "1": 0, "2": 100 };
    expect(getLevelProgress(-1, thresholds)).toBeNull();
  });
});
