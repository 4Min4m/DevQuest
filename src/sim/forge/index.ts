/** Hosting-platform state: which repository is which, CI run bookkeeping, and the container registry. */
import { findRepo } from '../git/repo';
import type { Repo } from '../git/types';
import type { CommandContext } from '../shell/types';
import type { SimState } from '../state';
import type { CiJob, CiRun, ForgeKind, ForgeRepo, ForgeState } from './types';

export * from './types';

/** "https://github.com/acme/shop.git" → "acme/shop". */
export function slugOf(url: string): string {
  return url
    .replace(/^[a-z]+:\/\/[^/]+\//, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

export function kindOf(url: string): ForgeKind {
  return /gitlab/.test(url) ? 'gitlab' : 'github';
}

export function hostOf(url: string): string {
  return /^[a-z]+:\/\/([^/]+)/.exec(url)?.[1] ?? (kindOf(url) === 'gitlab' ? 'gitlab.com' : 'github.com');
}

/** The URL people see for a repository (no .git). */
export function webUrl(repo: ForgeRepo): string {
  return `https://${hostOf(repo.url)}/${repo.slug}`;
}

export function forgeState(state: SimState): ForgeState {
  return (state.forge ??= { repos: {}, nextId: 0 });
}

/** The platform record of a hosted remote (created on first use). */
export function forgeRepo(state: SimState, url: string): ForgeRepo {
  const f = forgeState(state);
  return (f.repos[url] ??= { url, kind: kindOf(url), slug: slugOf(url), secrets: {}, variables: {}, environments: {}, runs: [], caches: {} });
}

/** Is this URL a hosted (http) remote rather than a local bare repository? */
export function isHosted(url: string): boolean {
  return /^https?:\/\//.test(url);
}

/** Find a hosted repository by "owner/name" (and optionally platform). */
export function findBySlug(state: SimState, slug: string, kind?: ForgeKind): { url: string; remote: Repo } | null {
  for (const [url, remote] of Object.entries(state.git?.remotes ?? {})) {
    if (isHosted(url) && slugOf(url).toLowerCase() === slug.toLowerCase() && (!kind || kindOf(url) === kind)) return { url, remote };
  }
  return null;
}

/** The hosted repository behind the current directory's `origin` (as gh/glab find it). */
export function repoForCwd(ctx: CommandContext, kind: ForgeKind): { url: string; remote: Repo } | { error: string } {
  const local = findRepo(ctx.state, ctx.vfs, ctx.state.cwd);
  if (!local) return { error: 'failed to run git: fatal: not a git repository (or any of the parent directories): .git' };
  const urls = Object.values(local.remotes).map((r) => r.url);
  const url = urls.find((u) => isHosted(u) && kindOf(u) === kind);
  const remote = url ? ctx.state.git?.remotes[url] : undefined;
  if (!url || !remote) {
    return {
      error:
        kind === 'github'
          ? 'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`'
          : 'none of the git remotes configured for this repository point to a known GitLab host. Please use `glab auth login` to authenticate and configure a new host for glab.',
    };
  }
  return { url, remote };
}

export function nextId(state: SimState, base: number): number {
  const f = forgeState(state);
  f.nextId += 1;
  return base + f.nextId * 7919;
}

// ------------------------------------------------------------------ time

/** gh-style relative time: "less than a minute ago", "about 3 minutes ago". */
export function ago(now: number, then: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'less than a minute ago';
  const m = Math.round(s / 60);
  if (m < 2) return 'about 1 minute ago';
  if (m < 60) return `about ${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 2) return 'about 1 hour ago';
  if (h < 24) return `about ${h} hours ago`;
  const d = Math.round(h / 24);
  return d < 2 ? 'about 1 day ago' : `about ${d} days ago`;
}

/** "1m5s", "32s" */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

// ------------------------------------------------------------------ run status (depends on the clock)

export type Shown = 'queued' | 'in_progress' | 'waiting' | 'completed';

/** What a job looks like at time `now` (runs are computed ahead; the clock reveals them). */
export function jobState(job: CiJob, now: number): { status: Shown; conclusion?: string } {
  if (job.status === 'manual') return { status: 'waiting', conclusion: 'manual' };
  if (job.status === 'stuck') return { status: 'queued' };
  if (job.status === 'created') return { status: 'queued' };
  if (job.status === 'skipped') return { status: 'completed', conclusion: 'skipped' };
  if (job.startedAt === undefined || now < job.startedAt) return { status: 'queued' };
  if (job.completedAt === undefined || now < job.completedAt) return { status: 'in_progress' };
  return { status: 'completed', conclusion: job.status };
}

export function runState(run: CiRun, now: number): { status: Shown; conclusion?: string } {
  if (run.error) return { status: 'completed', conclusion: 'failure' };
  const states = run.jobs.map((j) => ({ j, s: jobState(j, now) }));
  if (states.some((x) => x.s.status === 'in_progress')) return { status: 'in_progress' };
  if (states.some((x) => x.s.status === 'queued' && x.j.status !== 'created' && x.j.status !== 'stuck' && x.j.startedAt !== undefined)) return { status: 'in_progress' };
  if (states.some((x) => x.s.status === 'queued')) return { status: states.some((x) => x.s.status === 'completed') ? 'in_progress' : 'queued' };
  const failed = run.jobs.some((j) => (j.status === 'failure' && !j.allowFailure) || j.status === 'cancelled');
  if (run.jobs.some((j) => j.status === 'manual' && j.allowFailure === false)) return { status: 'waiting', conclusion: 'manual' };
  if (failed) return { status: 'completed', conclusion: run.jobs.some((j) => j.status === 'cancelled') && !run.jobs.some((j) => j.status === 'failure') ? 'cancelled' : 'failure' };
  return { status: 'completed', conclusion: 'success' };
}

/** When everything that will finish has finished. */
export function runEnd(run: CiRun): number {
  return Math.max(run.createdAt, ...run.jobs.map((j) => j.completedAt ?? 0));
}

// ------------------------------------------------------------------ registry

/** Registries `docker push` accepts. Other hosts don't resolve. */
export function registryHost(ref: string): string {
  const first = ref.split('/')[0];
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : 'docker.io';
}

export function fullImageRef(ref: string): string {
  const host = registryHost(ref);
  let rest = host === 'docker.io' && !ref.startsWith('docker.io/') ? ref : ref.slice(host.length + 1);
  if (host === 'docker.io' && !rest.includes('/')) rest = `library/${rest}`;
  if (!/:[^/]+$/.test(rest) && !rest.includes('@')) rest += ':latest';
  return `${host}/${rest}`;
}

export function registryPush(state: SimState, ref: string, digest: string): void {
  const reg = (state.registry ??= { images: {} });
  reg.images[fullImageRef(ref)] = { digest, pushedAt: state.clock };
  const ks = state.kube;
  if (ks) ks.pushed = [...new Set([...(ks.pushed ?? []), fullImageRef(ref)])];
}

export function registryHas(state: SimState, ref: string): boolean {
  return !!state.registry?.images[fullImageRef(ref)];
}
