/**
 * Interview Mode: a timed set of missions you've already completed, no hints.
 * All solved within the time limit = pass.
 */
import { isMissionDone, ProgressState } from './progress';
import type { Lesson, Mission } from './types';

export const INTERVIEW_QUESTIONS = 3;
export const INTERVIEW_TIME_MS = 10 * 60 * 1000;
export const INTERVIEW_XP_PER_SOLVE = 15;
export const INTERVIEW_PASS_BONUS = 30;

/** Missions eligible for interviews: hands-on missions the learner has finished (not knowledge checks). */
export function interviewPool(p: ProgressState, lessons: Lesson[]): Mission[] {
  return lessons.flatMap((l) => l.missions).filter((m) => m.type !== 'quiz' && isMissionDone(p, m.id));
}

/** Deterministic shuffle (mulberry32) so a seed always yields the same interview. */
export function pickInterview(pool: Mission[], count: number, seed: number): Mission[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

export interface InterviewResult {
  solved: number;
  total: number;
  elapsedMs: number;
  passed: boolean;
  xp: number;
}

export function scoreInterview(solved: number, total: number, elapsedMs: number): InterviewResult {
  const passed = total > 0 && solved === total && elapsedMs <= INTERVIEW_TIME_MS;
  return { solved, total, elapsedMs, passed, xp: solved * INTERVIEW_XP_PER_SOLVE + (passed ? INTERVIEW_PASS_BONUS : 0) };
}

export function recordInterview(p: ProgressState, r: InterviewResult): ProgressState {
  const iv = p.interviews;
  return {
    ...p,
    xp: p.xp + r.xp,
    interviews: {
      attempts: iv.attempts + 1,
      passed: iv.passed + (r.passed ? 1 : 0),
      bestMs: r.passed ? Math.min(iv.bestMs ?? Infinity, r.elapsedMs) : iv.bestMs,
    },
  };
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
