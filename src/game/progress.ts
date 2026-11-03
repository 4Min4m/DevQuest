/**
 * Player progress: XP, levels, streaks, hearts and unlocking.
 * Everything here is pure: functions take a ProgressState and return a new one,
 * so the logic is easy to test and the state is trivially serializable.
 */
import type { SessionStats } from './session';
import type { BranchId, Lesson, Mission } from './types';

export const MAX_HEARTS = 3;
export const PROGRESS_VERSION = 1;

export interface MissionRecord {
  /** Highest XP total earned on this mission (replays only award improvements). */
  bestXp: number;
  completions: number;
  firstCompletedAt: string;
  /** Ever completed without hints / within par. */
  noHints: boolean;
  onPar: boolean;
}

export interface StreakState {
  current: number;
  best: number;
  /** Local calendar day (YYYY-MM-DD) of the last completed mission. */
  lastDay: string | null;
}

export interface ProgressState {
  version: typeof PROGRESS_VERSION;
  xp: number;
  missions: Record<string, MissionRecord>;
  /** Hearts left per lesson id; a missing entry means full hearts. */
  hearts: Record<string, number>;
  streak: StreakState;
}

export function initialProgress(): ProgressState {
  return { version: PROGRESS_VERSION, xp: 0, missions: {}, hearts: {}, streak: { current: 0, best: 0, lastDay: null } };
}

// ------------------------------------------------------------------ scoring

export interface XpBreakdown {
  base: number;
  hintCost: number;
  noHintBonus: number;
  parBonus: number;
  total: number;
}

/** Bonus fractions of the base reward. */
export const NO_HINT_BONUS = 0.2;
export const PAR_BONUS = 0.2;
/** Hints can never reduce a mission below this share of its base XP. */
export const MIN_SHARE = 0.25;

export function scoreMission(mission: Mission, stats: SessionStats): XpBreakdown {
  const base = mission.xp;
  const hintCost = Math.min(stats.hintXpCost, base - Math.ceil(base * MIN_SHARE));
  const noHintBonus = stats.hintsUsed === 0 ? Math.round(base * NO_HINT_BONUS) : 0;
  const parBonus = stats.commands <= stats.par ? Math.round(base * PAR_BONUS) : 0;
  return { base, hintCost, noHintBonus, parBonus, total: base - hintCost + noHintBonus + parBonus };
}

// ------------------------------------------------------------------ levels

/** Total XP needed to reach `level` (level 1 = 0, 2 = 100, 3 = 300, 4 = 600, ...). */
export function xpForLevel(level: number): number {
  return 50 * level * (level - 1);
}

export interface LevelInfo {
  level: number;
  /** XP earned inside the current level. */
  intoLevel: number;
  /** XP the current level spans. */
  levelSize: number;
  toNext: number;
}

export function levelInfo(xp: number): LevelInfo {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  const start = xpForLevel(level);
  const end = xpForLevel(level + 1);
  return { level, intoLevel: xp - start, levelSize: end - start, toNext: end - xp };
}

// ------------------------------------------------------------------ streaks

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Record activity today. Consecutive days extend the streak; a gap restarts it. */
export function touchStreak(streak: StreakState, now: Date): StreakState {
  const today = dayKey(now);
  if (streak.lastDay === today) return streak;
  const gap = streak.lastDay ? daysBetween(streak.lastDay, today) : Infinity;
  const current = gap === 1 ? streak.current + 1 : 1;
  return { current, best: Math.max(streak.best, current), lastDay: today };
}

/** The streak as it should be displayed now: 0 once a full day has been missed. */
export function activeStreak(streak: StreakState, now: Date): number {
  if (!streak.lastDay) return 0;
  return daysBetween(streak.lastDay, dayKey(now)) <= 1 ? streak.current : 0;
}

// ------------------------------------------------------------------ hearts

export function heartsLeft(p: ProgressState, lessonId: string): number {
  return p.hearts[lessonId] ?? MAX_HEARTS;
}

export function loseHeart(p: ProgressState, lessonId: string): ProgressState {
  return { ...p, hearts: { ...p.hearts, [lessonId]: Math.max(0, heartsLeft(p, lessonId) - 1) } };
}

export function refillHearts(p: ProgressState, lessonId: string): ProgressState {
  const hearts = { ...p.hearts };
  delete hearts[lessonId];
  return { ...p, hearts };
}

// ------------------------------------------------------------------ completion

export interface Reward {
  breakdown: XpBreakdown;
  /** XP actually added (only the improvement over a previous best). */
  awarded: number;
  previousBest: number;
  levelBefore: number;
  levelAfter: number;
  streak: number;
  firstCompletion: boolean;
}

export function completeMission(
  p: ProgressState,
  mission: Mission,
  stats: SessionStats,
  now: Date,
): { progress: ProgressState; reward: Reward } {
  const breakdown = scoreMission(mission, stats);
  const prev = p.missions[mission.id];
  const previousBest = prev?.bestXp ?? 0;
  const awarded = Math.max(0, breakdown.total - previousBest);
  const record: MissionRecord = {
    bestXp: Math.max(previousBest, breakdown.total),
    completions: (prev?.completions ?? 0) + 1,
    firstCompletedAt: prev?.firstCompletedAt ?? now.toISOString(),
    noHints: (prev?.noHints ?? false) || stats.hintsUsed === 0,
    onPar: (prev?.onPar ?? false) || stats.commands <= stats.par,
  };
  const streak = touchStreak(p.streak, now);
  const progress: ProgressState = {
    ...p,
    xp: p.xp + awarded,
    missions: { ...p.missions, [mission.id]: record },
    streak,
  };
  return {
    progress,
    reward: {
      breakdown,
      awarded,
      previousBest,
      levelBefore: levelInfo(p.xp).level,
      levelAfter: levelInfo(progress.xp).level,
      streak: streak.current,
      firstCompletion: !prev,
    },
  };
}

// ------------------------------------------------------------------ unlocking

export function isMissionDone(p: ProgressState, missionId: string): boolean {
  return missionId in p.missions;
}

export function lessonProgress(p: ProgressState, lesson: Lesson): { done: number; total: number } {
  return { done: lesson.missions.filter((m) => isMissionDone(p, m.id)).length, total: lesson.missions.length };
}

export function isLessonComplete(p: ProgressState, lesson: Lesson): boolean {
  return lesson.missions.every((m) => isMissionDone(p, m.id));
}

export function isLessonUnlocked(p: ProgressState, lesson: Lesson, all: Lesson[]): boolean {
  return lesson.prerequisites.every((id) => {
    const pre = all.find((l) => l.id === id);
    return !!pre && isLessonComplete(p, pre);
  });
}

/** Missions unlock in order inside an unlocked lesson. */
export function isMissionUnlocked(p: ProgressState, lesson: Lesson, index: number, all: Lesson[]): boolean {
  if (!isLessonUnlocked(p, lesson, all)) return false;
  return lesson.missions.slice(0, index).every((m) => isMissionDone(p, m.id));
}

/** Index of the mission to open for a lesson: the first unfinished one (or 0). */
export function nextMissionIndex(p: ProgressState, lesson: Lesson): number {
  const i = lesson.missions.findIndex((m) => !isMissionDone(p, m.id));
  return i < 0 ? 0 : i;
}

// ------------------------------------------------------------------ skill tree

export const BRANCHES: { id: BranchId; title: string; icon: string }[] = [
  { id: 'linux-basics', title: 'Linux Basics', icon: '🐧' },
  { id: 'files-permissions', title: 'Files & Permissions', icon: '🔐' },
  { id: 'processes', title: 'Processes', icon: '⚙️' },
  { id: 'text-processing', title: 'Text Processing', icon: '🔎' },
  { id: 'docker-basics', title: 'Docker Basics', icon: '🐳' },
  { id: 'images-dockerfile', title: 'Images & Dockerfile', icon: '📦' },
  { id: 'volumes-networks', title: 'Volumes & Networks', icon: '🔌' },
  { id: 'compose', title: 'Compose', icon: '🧩' },
  { id: 'troubleshooting', title: 'Troubleshooting', icon: '🚑' },
];

export type NodeStatus = 'locked' | 'available' | 'in-progress' | 'complete' | 'coming-soon';

export interface LessonNode {
  lesson: Lesson;
  status: NodeStatus;
  done: number;
  total: number;
}

export interface BranchNode {
  id: BranchId;
  title: string;
  icon: string;
  status: NodeStatus;
  lessons: LessonNode[];
}

export function skillTree(p: ProgressState, all: Lesson[]): BranchNode[] {
  return BRANCHES.map((b) => {
    const lessons: LessonNode[] = all
      .filter((l) => l.branch === b.id)
      .map((lesson) => {
        const { done, total } = lessonProgress(p, lesson);
        let status: NodeStatus;
        if (!isLessonUnlocked(p, lesson, all)) status = 'locked';
        else if (done === total) status = 'complete';
        else if (done > 0) status = 'in-progress';
        else status = 'available';
        return { lesson, status, done, total };
      });
    let status: NodeStatus;
    if (!lessons.length) status = 'coming-soon';
    else if (lessons.every((l) => l.status === 'complete')) status = 'complete';
    else if (lessons.every((l) => l.status === 'locked')) status = 'locked';
    else if (lessons.some((l) => l.done > 0)) status = 'in-progress';
    else status = 'available';
    return { ...b, status, lessons };
  });
}

// ------------------------------------------------------------------ import / export

export function exportProgress(p: ProgressState): string {
  return JSON.stringify({ app: 'devops-quest', ...p }, null, 2);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Parse and validate an exported progress file. Throws a readable error if it's not valid. */
export function importProgress(json: string): ProgressState {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!isObj(data) || data.app !== 'devops-quest') throw new Error('This is not a DevOps Quest progress file.');
  if (data.version !== PROGRESS_VERSION) throw new Error(`Unsupported progress version: ${String(data.version)}.`);
  if (!isNum(data.xp)) throw new Error('Progress file has an invalid "xp" value.');
  if (!isObj(data.missions) || !isObj(data.hearts) || !isObj(data.streak)) {
    throw new Error('Progress file is missing missions, hearts or streak data.');
  }
  const missions: Record<string, MissionRecord> = {};
  for (const [id, r] of Object.entries(data.missions)) {
    if (!isObj(r) || !isNum(r.bestXp) || !isNum(r.completions) || typeof r.firstCompletedAt !== 'string') {
      throw new Error(`Progress file has an invalid record for mission "${id}".`);
    }
    missions[id] = {
      bestXp: r.bestXp,
      completions: r.completions,
      firstCompletedAt: r.firstCompletedAt,
      noHints: r.noHints === true,
      onPar: r.onPar === true,
    };
  }
  const hearts: Record<string, number> = {};
  for (const [id, h] of Object.entries(data.hearts)) {
    if (!isNum(h) || h > MAX_HEARTS) throw new Error(`Progress file has invalid hearts for "${id}".`);
    hearts[id] = Math.floor(h);
  }
  const s = data.streak;
  if (!isNum(s.current) || !isNum(s.best) || !(s.lastDay === null || (typeof s.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.lastDay)))) {
    throw new Error('Progress file has invalid streak data.');
  }
  return {
    version: PROGRESS_VERSION,
    xp: data.xp,
    missions,
    hearts,
    streak: { current: s.current, best: s.best, lastDay: s.lastDay as string | null },
  };
}
