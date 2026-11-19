import { describe, expect, it } from "vitest";
import { dailyMessageMilestone, dailyRewardAmount, nextDailyClaimStreak, previousDay } from "../src/rewards";

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
  });

  it("uses the configured seven-day reward cycle", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(dailyRewardAmount)).toEqual([10, 15, 20, 25, 30, 50, 100]);
    expect(dailyRewardAmount(8)).toBe(100);
  });

  it("grants message milestones only at daily thresholds", () => {
    expect(dailyMessageMilestone(49)).toBeNull();
    expect(dailyMessageMilestone(50)).toEqual({ sourceKey: "50", amount: 20, note: "50 сообщений за день" });
    expect(dailyMessageMilestone(100)?.amount).toBe(35);
  });
});
