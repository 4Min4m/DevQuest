/** Validator checks for CI/CD missions: pipeline runs on the simulated forges and the container registry. */
import { fullImageRef, jobState, registryHas, runState } from '../sim/forge';
import type { SimState } from '../sim/state';
import type { Check } from './types';

export type CiCheck = Extract<Check, { type: 'ciRun' | 'registryImage' }>;

export const CI_CHECK_TYPES = ['ciRun', 'registryImage'] as const;

function headOf(state: SimState, repo: string, branch: string): string | undefined {
  return state.git?.remotes[repo]?.heads[branch];
}

export function evaluateCi(check: CiCheck, state: SimState): boolean {
  switch (check.type) {
    case 'ciRun': {
      const repo = state.forge?.repos[check.repo];
      if (!repo) return false;
      let runs = [...repo.runs].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
      if (check.workflow) runs = runs.filter((r) => r.workflow === check.workflow || r.file === check.workflow || r.file.endsWith(`/${check.workflow}`));
      if (check.branch) runs = runs.filter((r) => r.branch === check.branch);
      if (check.event) runs = runs.filter((r) => r.event === check.event);
      if (check.minRuns !== undefined && runs.length < check.minRuns) return false;
      const run = runs[0];
      if (!run) return false;
      if (!check.anyCommit && check.branch && run.sha !== headOf(state, check.repo, check.branch)) return false;
      const s = runState(run, state.clock);
      const want = check.status ?? 'success';
      if (want === 'manual') {
        if (!run.jobs.some((j) => j.status === 'manual')) return false;
      } else if (s.status !== 'completed' || s.conclusion !== want) return false;
      if (check.job) {
        const job = run.jobs.find((j) => j.name === check.job || j.key === check.job);
        if (check.jobStatus === 'absent') return !job;
        if (!job) return false;
        const js = jobState(job, state.clock);
        const got = job.status === 'manual' ? 'manual' : js.status === 'completed' ? js.conclusion : js.status;
        if (got !== (check.jobStatus ?? 'success')) return false;
      }
      return true;
    }
    case 'registryImage': {
      let ref = check.ref;
      if (/\{(sha|short|short8)\}/.test(ref)) {
        const sha = check.repo ? headOf(state, check.repo, check.branch ?? 'main') : undefined;
        if (!sha) return false;
        ref = ref.replace('{sha}', sha).replace('{short8}', sha.slice(0, 8)).replace('{short}', sha.slice(0, 7));
      }
      return registryHas(state, ref) === (check.exists ?? true);
    }
  }
}

export function describeCi(check: CiCheck): string {
  switch (check.type) {
    case 'ciRun': {
      const what = check.workflow ? `the \`${check.workflow}\` ${check.repo.includes('gitlab') ? 'pipeline' : 'workflow'}` : check.repo.includes('gitlab') ? 'the pipeline' : 'the CI run';
      const on = check.branch ? ` on \`${check.branch}\`${check.anyCommit ? '' : ' (latest commit)'}` : '';
      if (check.job && check.jobStatus === 'absent') return `${what}${on} should not contain the job \`${check.job}\``;
      if (check.job) return `${what}${on}: job \`${check.job}\` should be ${check.jobStatus ?? 'success'}`;
      return `${what}${on} should finish with ${check.status ?? 'success'}`;
    }
    case 'registryImage':
      return `image \`${fullImageRef(check.ref.replace(/\{(sha|short8|short)\}/, '<commit>'))}\` should ${check.exists === false ? 'not ' : ''}be in the registry`;
  }
}
