import { useStore } from 'zustand';
import type { ProgressState } from '../game/progress';
import { createProgressStore, ProgressStore } from '../game/store';

/** The app-wide progress store, persisted to localStorage. */
export const progressStore = createProgressStore();

export function useProgress(): ProgressState;
export function useProgress<T>(select: (p: ProgressState) => T): T;
export function useProgress<T>(select?: (p: ProgressState) => T) {
  return useStore(progressStore, (s: ProgressStore) => (select ? select(s.progress) : s.progress));
}

export const actions = () => progressStore.getState();
