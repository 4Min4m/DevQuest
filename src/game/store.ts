import { createStore, StoreApi } from 'zustand/vanilla';
import { createJSONStorage, persist, StateStorage } from 'zustand/middleware';
import { awardBadges, BadgeDef } from './badges';
import { claimDaily, ensureDaily } from './daily';
import { InterviewResult, recordInterview } from './interview';
import * as P from './progress';
import * as R from './review';
import type { SessionStats } from './session';
import type { Lesson, Mission } from './types';

export const STORAGE_KEY = 'devops-quest-progress';

/** What a completion is worth, including extras the store adds on top of the mission score. */
export interface Extras {
  dailyBonus: number;
  badges: BadgeDef[];
}

export type MissionReward = P.Reward & Extras;
export type ReviewReward = R.ReviewReward & Extras;

export interface ProgressStore {
  progress: P.ProgressState;
  completeMission(mission: Mission, stats: SessionStats, now?: Date): MissionReward;
  /** A recall challenge was solved. */
  completeReview(mission: Mission, stats: SessionStats, now?: Date): ReviewReward;
  failReview(missionId: string, now?: Date): void;
  /** Call when a lesson's last mission is done: records a perfect run and refills hearts. */
  finishLesson(lesson: Lesson, now?: Date): BadgeDef[];
  /**
   * Called when the home screen opens: picks today's daily mission and grants badges
   * that are already earned (e.g. after importing older progress).
   */
  ensureDaily(now?: Date): void;
  recordInterview(result: InterviewResult, now?: Date): BadgeDef[];
  /** Returns the hearts left in the lesson after losing one. */
  loseHeart(lessonId: string): number;
  refillHearts(lessonId: string): void;
  exportJson(): string;
  /** Replace progress with an exported file. Throws a readable error on invalid input. */
  importJson(json: string): void;
  reset(): void;
}

/** Storage that silently does nothing (private mode, tests, blocked storage). */
const memoryFallback = (): StateStorage => {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

function browserStorage(): StateStorage {
  try {
    const ls = globalThis.localStorage;
    const probe = '__devquest_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return memoryFallback();
  }
}

/**
 * Create the progress store. `lessons` is the course catalog (needed for badges and the
 * daily mission); tests pass their own catalog and storage.
 */
export function createProgressStore(storage: StateStorage = browserStorage(), lessons: Lesson[] = []): StoreApi<ProgressStore> {
  return createStore<ProgressStore>()(
    persist(
      (set, get) => {
        /** Daily bonus + badges, applied after any completion. */
        const extras = (p: P.ProgressState, missionId: string | null, now: Date): { progress: P.ProgressState } & Extras => {
          let progress = p;
          let dailyBonus = 0;
          if (missionId) {
            const d = claimDaily(progress, missionId, now);
            progress = d.progress;
            dailyBonus = d.bonus;
          }
          const b = awardBadges(progress, lessons, now);
          return { progress: b.progress, dailyBonus, badges: b.earned };
        };
        return {
          progress: P.initialProgress(),
          completeMission(mission, stats, now = new Date()) {
            const r = P.completeMission(get().progress, mission, stats, now);
            const x = extras(r.progress, mission.id, now);
            set({ progress: x.progress });
            return { ...r.reward, dailyBonus: x.dailyBonus, badges: x.badges };
          },
          completeReview(mission, stats, now = new Date()) {
            const r = R.completeReview(get().progress, mission, stats, now);
            const x = extras(r.progress, mission.id, now);
            set({ progress: x.progress });
            return { ...r.reward, dailyBonus: x.dailyBonus, badges: x.badges };
          },
          failReview(missionId, now = new Date()) {
            set({ progress: R.failReview(get().progress, missionId, now) });
          },
          finishLesson(lesson, now = new Date()) {
            let p = get().progress;
            if (!P.isLessonComplete(p, lesson)) return [];
            if (P.heartsLeft(p, lesson.id) === P.MAX_HEARTS && !p.perfectLessons.includes(lesson.id)) {
              p = { ...p, perfectLessons: [...p.perfectLessons, lesson.id] };
            }
            p = P.refillHearts(p, lesson.id);
            const x = extras(p, null, now);
            set({ progress: x.progress });
            return x.badges;
          },
          ensureDaily(now = new Date()) {
            const p = get().progress;
            const next = awardBadges(ensureDaily(p, lessons, now), lessons, now).progress;
            if (next !== p) set({ progress: next });
          },
          recordInterview(result, now = new Date()) {
            const x = extras(recordInterview(get().progress, result), null, now);
            set({ progress: x.progress });
            return x.badges;
          },
          loseHeart(lessonId) {
            const progress = P.loseHeart(get().progress, lessonId);
            set({ progress });
            return P.heartsLeft(progress, lessonId);
          },
          refillHearts(lessonId) {
            set({ progress: P.refillHearts(get().progress, lessonId) });
          },
          exportJson: () => P.exportProgress(get().progress),
          importJson(json) {
            set({ progress: P.importProgress(json) });
          },
          reset() {
            set({ progress: P.initialProgress() });
          },
        };
      },
      {
        name: STORAGE_KEY,
        version: P.PROGRESS_VERSION,
        storage: createJSONStorage(() => storage),
        partialize: (s) => ({ progress: s.progress }),
        // Older saves are upgraded by importProgress (inside merge).
        migrate: (persisted) => persisted as ProgressStore,
        // Corrupt or foreign data must never brick the app: fall back to a fresh start.
        merge: (persisted, current) => {
          try {
            const p = (persisted as { progress?: unknown })?.progress;
            if (!p) return current;
            return { ...current, progress: P.importProgress(JSON.stringify({ app: 'devops-quest', ...(p as object) })) };
          } catch {
            return current;
          }
        },
      },
    ),
  );
}
