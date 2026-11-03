import { createStore, StoreApi } from 'zustand/vanilla';
import { createJSONStorage, persist, StateStorage } from 'zustand/middleware';
import * as P from './progress';
import type { SessionStats } from './session';
import type { Mission } from './types';

export const STORAGE_KEY = 'devops-quest-progress';

export interface ProgressStore {
  progress: P.ProgressState;
  completeMission(mission: Mission, stats: SessionStats, now?: Date): P.Reward;
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

/** Create the progress store. Tests pass their own storage. */
export function createProgressStore(storage: StateStorage = browserStorage()): StoreApi<ProgressStore> {
  return createStore<ProgressStore>()(
    persist(
      (set, get) => ({
        progress: P.initialProgress(),
        completeMission(mission, stats, now = new Date()) {
          const { progress, reward } = P.completeMission(get().progress, mission, stats, now);
          set({ progress });
          return reward;
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
      }),
      {
        name: STORAGE_KEY,
        version: P.PROGRESS_VERSION,
        storage: createJSONStorage(() => storage),
        partialize: (s) => ({ progress: s.progress }),
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
