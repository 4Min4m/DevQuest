/**
 * The daily mission: one mission per calendar day, chosen when the day starts
 * and fixed until midnight. Finishing it (as a lesson or a recall) pays a bonus.
 */
import { dayKey, isMissionDone, isMissionUnlocked, ProgressState } from './progress';
import { reviewsDue } from './review';
import type { Lesson } from './types';

export const DAILY_BONUS = 25;

/** Choose today's mission: the most overdue review, else the next new mission, else any finished one. */
export function chooseDaily(p: ProgressState, lessons: Lesson[], now: Date): DailyPick | null {
  const day = dayKey(now);
  const due = reviewsDue(p, now);
  if (due.length) return { day, missionId: due[0].missionId, kind: 'review' };
  for (const lesson of lessons) {
    for (let i = 0; i < lesson.missions.length; i++) {
      const m = lesson.missions[i];
      if (!isMissionDone(p, m.id) && isMissionUnlocked(p, lesson, i, lessons)) return { day, missionId: m.id, kind: 'new' };
    }
  }
  const done = lessons.flatMap((l) => l.missions).filter((m) => isMissionDone(p, m.id));
  if (!done.length) return null;
  return { day, missionId: done[hashDay(day) % done.length].id, kind: 'review' };
}

export type DailyPick = NonNullable<ProgressState['daily']['pick']>;

function hashDay(day: string): number {
  let h = 7;
  for (const c of day) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** Make sure today has a pick (keeps an existing pick for the same day). */
export function ensureDaily(p: ProgressState, lessons: Lesson[], now: Date): ProgressState {
  if (p.daily.pick?.day === dayKey(now)) return p;
  return { ...p, daily: { ...p.daily, pick: chooseDaily(p, lessons, now) } };
}

export function dailyClaimedToday(p: ProgressState, now: Date): boolean {
  return p.daily.lastClaimed === dayKey(now);
}

/** If `missionId` is today's unclaimed daily, add the bonus. Returns the bonus paid (0 if none). */
export function claimDaily(p: ProgressState, missionId: string, now: Date): { progress: ProgressState; bonus: number } {
  const today = dayKey(now);
  if (p.daily.pick?.day !== today || p.daily.pick.missionId !== missionId || p.daily.lastClaimed === today) {
    return { progress: p, bonus: 0 };
  }
  return {
    progress: { ...p, xp: p.xp + DAILY_BONUS, daily: { ...p.daily, lastClaimed: today, count: p.daily.count + 1 } },
    bonus: DAILY_BONUS,
  };
}
