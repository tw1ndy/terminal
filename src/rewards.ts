export function previousDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, date - 1));
  return value.toISOString().slice(0, 10);
}

/** Returns 0 when today's reward is already present; otherwise the next streak day (1–7). */
export function nextDailyClaimStreak(today: string, recentClaimDays: string[]): number {
  if (recentClaimDays[0] === today) return 0;
  let expected = previousDay(today);
  let consecutive = 0;
  for (const claimDay of recentClaimDays) {
    if (claimDay !== expected) break;
    consecutive += 1;
    expected = previousDay(expected);
  }
  return Math.min(consecutive + 1, 7);
}

export function dailyRewardAmount(streakDay: number): number {
  const cycle = [10, 15, 20, 25, 30, 50, 100];
  return cycle[Math.max(0, Math.min(7, streakDay) - 1)] ?? 10;
}

export function dailyMessageMilestone(count: number): { sourceKey: string; amount: number; note: string } | null {
  if (count === 50) return { sourceKey: "50", amount: 20, note: "50 сообщений за день" };
  if (count === 100) return { sourceKey: "100", amount: 35, note: "100 сообщений за день" };
  return null;
}
