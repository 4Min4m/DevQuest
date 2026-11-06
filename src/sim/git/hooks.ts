/** Server-side hooks of the simulated hosting platforms (CI triggers on push). */
import type { SimState } from '../state';
import type { Repo } from './types';

export interface PushUpdate {
  branch?: string;
  tag?: string;
  /** Previous tip (undefined for a new branch). */
  before?: string;
  after: string;
}

type PushHook = (state: SimState, url: string, remote: Repo, updates: PushUpdate[]) => void;

const hooks: PushHook[] = [];

export function onPush(h: PushHook): void {
  if (!hooks.includes(h)) hooks.push(h);
}

/** Called after a push updated refs on a remote. Runs on the host machine's state. */
export function firePush(state: SimState, url: string, remote: Repo, updates: PushUpdate[]): void {
  if (!updates.length) return;
  for (const h of hooks) h(state, url, remote, updates);
}
