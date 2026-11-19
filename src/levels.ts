export type LevelThresholds = Record<string, number>;

export interface LevelProgress {
  level: number;
  title: string;
  nextLevel: number | null;
  xpToNext: number | null;
}

export function levelTitle(level: number): string {
  if (level <= 5) return "Новичок";
  if (level <= 10) return "Активист";
  if (level <= 20) return "Постоянный";
  if (level <= 35) return "Ветеран";
  if (level <= 50) return "Легенда НК";
  return "Элитный участник";
}

/** Accepts sequential XP thresholds; an empty object intentionally disables level display. */
export function validateLevelThresholds(value: unknown): LevelThresholds | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return {};
  if (entries.length > 100) return null;
  const parsed = entries.map(([key, xp]) => [Number(key), xp] as const)
    .sort((a, b) => a[0] - b[0]);
  if (parsed.some(([level, xp], index) =>
    !Number.isSafeInteger(level) || level !== index + 1 ||
    typeof xp !== "number" || !Number.isSafeInteger(xp) || xp < 0 || xp > 1_000_000_000)) return null;
  if (parsed[0][1] !== 0) return null;
  for (let i = 1; i < parsed.length; i++) {
    if (Number(parsed[i][1]) <= Number(parsed[i - 1][1])) return null;
  }
  return Object.fromEntries(parsed.map(([level, xp]) => [String(level), Number(xp)]));
}

export function getLevelProgress(lifetimeXp: number, thresholds: LevelThresholds): LevelProgress | null {
  const levels = Object.entries(thresholds)
    .map(([level, xp]) => ({ level: Number(level), xp }))
    .sort((a, b) => a.level - b.level);
  if (levels.length === 0) return null;
  let currentIndex = -1;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].xp <= lifetimeXp) currentIndex = i;
    else break;
  }
  if (currentIndex < 0) return null;
  const current = levels[currentIndex];
  const next = levels[currentIndex + 1];
  return {
    level: current.level,
    title: levelTitle(current.level),
    nextLevel: next?.level ?? null,
    xpToNext: next ? Math.max(0, next.xp - lifetimeXp) : null
  };
}
