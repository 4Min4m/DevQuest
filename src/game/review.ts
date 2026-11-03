/**
 * Spaced review: finished missions come back as "recall challenges" on a
 * growing schedule (1, 3, 7, 14, 30, 60 days). Failing a recall starts over.
 */
import { addDays, dayKey, daysBetween, ProgressState, touchStreak } from './progress';
import type { SessionStats } from './session';
import type { Mission } from './types';

export const REVIEW_INTERVALS = [1, 3, 7, 14, 30, 60];
/** A recall challenge is worth this share of the mission's base XP. */
export const REVIEW_SHARE = 0.3;

export interface DueReview {
  missionId: string;
  due: string;
  /** Days overdue (0 = due today). */
  overdue: number;
}

export function reviewsDue(p: ProgressState, now: Date): DueReview[] {
  const today = dayKey(now);
  return Object.entries(p.reviews)
    .filter(([id, r]) => id in p.missions && r.due <= today)
    .map(([missionId, r]) => ({ missionId, due: r.due, overdue: daysBetween(r.due, today) }))
    .sort((a, b) => b.overdue - a.overdue || (a.missionId < b.missionId ? -1 : 1));
}

export interface ReviewReward {
  awarded: number;
  /** Days until this mission comes back. */
  nextInDays: number;
  streak: number;
}

export function completeReview(p: ProgressState, mission: Mission, stats: SessionStats, now: Date): { progress: ProgressState; reward: ReviewReward } {
  const today = dayKey(now);
  const prev = p.reviews[mission.id] ?? { reps: 0, due: today, done: 0 };
  const reps = Math.min(prev.reps + 1, REVIEW_INTERVALS.length - 1);
  const nextInDays = REVIEW_INTERVALS[reps];
  // A clean recall (no wrong checks, no mistakes) earns the full review reward.
  const clean = stats.failedChecks === 0 && stats.mistakes === 0;
  const awarded = Math.max(1, Math.round(mission.xp * REVIEW_SHARE * (clean ? 1 : 0.5)));
  const record = p.missions[mission.id];
  const streak = touchStreak(p.streak, now);
  return {
    progress: {
      ...p,
      xp: p.xp + awarded,
      streak,
      missions: record ? { ...p.missions, [mission.id]: { ...record, completions: record.completions + 1 } } : p.missions,
      reviews: { ...p.reviews, [mission.id]: { reps, due: addDays(today, nextInDays), done: prev.done + 1 } },
    },
    reward: { awarded, nextInDays, streak: streak.current },
  };
}

/** A failed recall: the mission comes back tomorrow and the interval starts over. */
export function failReview(p: ProgressState, missionId: string, now: Date): ProgressState {
  const prev = p.reviews[missionId] ?? { reps: 0, due: dayKey(now), done: 0 };
  return { ...p, reviews: { ...p.reviews, [missionId]: { ...prev, reps: 0, due: addDays(dayKey(now), 1) } } };
}

export function totalReviews(p: ProgressState): number {
  return Object.values(p.reviews).reduce((s, r) => s + r.done, 0);
}
