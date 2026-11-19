import { describe, expect, it } from "vitest";
import { dailyMessageMilestones, dailyRewardAmount, monthlyRewardTypes, nextDailyClaimStreak, previousDay, validateSeasonRewardSchedule } from "../src/rewards";

describe("daily reward calendar", () => {
  it("handles month and year boundaries", () => {
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
  });

  it("advances only an uninterrupted daily claim streak", () => {
    expect(nextDailyClaimStreak("2026-11-19", [])).toBe(1);
    expect(nextDailyClaimStreak("2026-11-19", ["2026-11-18", "2026-11-17"])).toBe(3);
    expect(nextDailyClaimStreak("2026-11-19", ["2026-11-18", "2026-11-16"])).toBe(2);
    expect(nextDailyClaimStreak("2026-11-19", ["2026-11-19", "2026-11-18"])).toBe(0);
    expect(nextDailyClaimStreak("2026-11-19", ["2026-11-11"])).toBe(1);
    expect(nextDailyClaimStreak("2026-11-19", [
      "2026-11-18", "2026-11-17", "2026-11-16", "2026-11-15",
      "2026-11-14", "2026-11-13", "2026-11-12"
    ])).toBe(8);
  });

  it("uses the configured seven-day reward cycle", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(dailyRewardAmount)).toEqual([10, 15, 20, 25, 30, 50, 100]);
    expect(dailyRewardAmount(8)).toBe(10);
    expect(dailyRewardAmount(9)).toBe(15);
    expect(dailyRewardAmount(15)).toBe(10);
  });

  it("grants message milestones only at daily thresholds", () => {
    expect(dailyMessageMilestones(49)).toEqual([]);
    expect(dailyMessageMilestones(50)).toEqual([{ sourceKey: "50", amount: 20, note: "50 сообщений за день" }]);
    expect(dailyMessageMilestones(100)).toEqual([
      { sourceKey: "50", amount: 20, note: "50 сообщений за день" },
      { sourceKey: "100", amount: 35, note: "100 сообщений за день" }
    ]);
    expect(dailyMessageMilestones(101)).toHaveLength(2);
  });
});


describe("season reward schedule validation", () => {
  it("allows disabled and valid schedules", () => {
    expect(validateSeasonRewardSchedule({})).toEqual({});
    expect(validateSeasonRewardSchedule(undefined)).toEqual({});
    expect(validateSeasonRewardSchedule({ "1": 500, "2": 300, "10": 25 })).toEqual({ "1": 500, "2": 300, "10": 25 });
    expect(validateSeasonRewardSchedule({ "1": 0, "2": 300 })).toEqual({ "2": 300 });
  });

  it("rejects invalid places, strings, fractions and unsafe amounts", () => {
    expect(validateSeasonRewardSchedule(null)).toEqual({});
    expect(validateSeasonRewardSchedule([])).toBeNull();
    expect(validateSeasonRewardSchedule({ "0": 100 })).toBeNull();
    expect(validateSeasonRewardSchedule({ "11": 100 })).toBeNull();
    expect(validateSeasonRewardSchedule({ "1": "500" })).toBeNull();
    expect(validateSeasonRewardSchedule({ "1": 1.5 })).toBeNull();
    expect(validateSeasonRewardSchedule({ "1": -1 })).toBeNull();
    expect(validateSeasonRewardSchedule({ "1": 1000001 })).toBeNull();
  });
});


describe("monthly ranking reward policy", () => {
  it("gives the winner a prefix and achievement", () => {
    expect(monthlyRewardTypes(1)).toEqual(["prefix", "achievement"]);
  });
  it("gives second place a prefix", () => {
    expect(monthlyRewardTypes(2)).toEqual(["prefix"]);
  });
  it("gives third place a commemorative achievement", () => {
    expect(monthlyRewardTypes(3)).toEqual(["achievement"]);
  });
  it("does not award beyond third place", () => {
    expect(monthlyRewardTypes(4)).toEqual([]);
    expect(monthlyRewardTypes(0)).toEqual([]);
  });
});
