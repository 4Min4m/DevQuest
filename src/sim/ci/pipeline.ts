/** Shared job scheduling for both CI engines: dependencies, skipping, manual gates, timing. */
import type { CiJob, CiRun } from '../forge/types';

export type Decision = 'run' | 'skip' | 'manual' | 'stuck';

export interface Engine {
  /** Decide what happens to a job whose dependencies are all settled. */
  decide(job: CiJob, deps: CiJob[]): Decision;
  /** Run the job starting at `start`; fills steps, status, completedAt. */
  execute(job: CiJob, start: number): void;
  /** Is this dependency settled (finished, or a manual job that doesn't block)? */
  settled(dep: CiJob): boolean;
}

const TERMINAL = new Set(['success', 'failure', 'skipped', 'cancelled']);

export function isTerminal(job: CiJob): boolean {
  return TERMINAL.has(job.status);
}

/**
 * Move the run forward as far as it can go at time `now`: start every job whose dependencies
 * are settled (in dependency order), skip the ones that shouldn't run, park manual and stuck jobs.
 */
export function advance(run: CiRun, engine: Engine, now: number): void {
  for (let guard = 0; guard < 500; guard++) {
    const next = run.jobs.find((j) => {
      if (j.status !== 'created') return false;
      const deps = j.needs.map((n) => run.jobs.filter((x) => x.key === n || x.name === n)).flat();
      return deps.every((d) => engine.settled(d));
    });
    if (!next) return;
    const deps = next.needs.map((n) => run.jobs.filter((x) => x.key === n || x.name === n)).flat();
    const d = engine.decide(next, deps);
    if (d === 'skip') {
      next.status = 'skipped';
      continue;
    }
    if (d === 'manual') {
      next.status = 'manual';
      continue;
    }
    if (d === 'stuck') {
      next.status = 'stuck';
      continue;
    }
    const start = Math.max(now, run.createdAt + 2000, ...deps.map((x) => x.completedAt ?? 0)) + 1000;
    engine.execute(next, start);
  }
}

/** Jobs that still sit behind another (for "waiting on" displays). */
export function blockedBy(run: CiRun, job: CiJob): CiJob[] {
  return job.needs.map((n) => run.jobs.filter((x) => x.key === n || x.name === n)).flat().filter((d) => !isTerminal(d));
}
