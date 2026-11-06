/** The GitLab CLI (`glab`) for CI/CD: pipelines, job logs, manual jobs, retries, lint, variables. */
import { currentBranch, findRepo } from '../git/repo';
import type { Repo } from '../git/types';
import { ago, findBySlug, forgeRepo, hostOf, jobState, repoForCwd, runState } from '../forge';
import type { CiJob, CiRun, ForgeRepo } from '../forge/types';
import type { CommandContext, CommandDef } from '../shell/types';
import { parseGitlab, playGitlabJob, retryGitlabJob, startGitlabPipeline } from './gitlab';

class GlabError extends Error {}

interface Parsed {
  flags: Record<string, string | true>;
  multi: Record<string, string[]>;
  args: string[];
}

function parse(argv: string[], bool: string[], value: string[], alias: Record<string, string> = {}): Parsed {
  const al: Record<string, string> = { R: 'repo', ...alias };
  const out: Parsed = { flags: {}, multi: {}, args: [] };
  const vals = new Set(['repo', ...value]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a) ?? (/^-([A-Za-z])$/.exec(a) ? [a, al[a[1]] ?? a[1]] : null);
    if (m) {
      const name = al[m[1]] ?? m[1];
      if (vals.has(name)) {
        const v = m[2] ?? argv[++i];
        if (v === undefined) throw new GlabError(`flag needs an argument: ${a}`);
        out.flags[name] = v;
        (out.multi[name] ??= []).push(v);
      } else if (bool.includes(name)) out.flags[name] = true;
      else throw new GlabError(`ERROR: unknown flag: ${a}`);
      continue;
    }
    out.args.push(a);
  }
  return out;
}

function target(ctx: CommandContext, p: Parsed): { url: string; remote: Repo; repo: ForgeRepo } {
  if (typeof p.flags.repo === 'string') {
    const hit = findBySlug(ctx.state, p.flags.repo, 'gitlab');
    if (!hit) throw new GlabError(`ERROR: 404 Project Not Found`);
    return { ...hit, repo: forgeRepo(ctx.state, hit.url) };
  }
  const r = repoForCwd(ctx, 'gitlab');
  if ('error' in r) throw new GlabError(r.error);
  return { ...r, repo: forgeRepo(ctx.state, r.url) };
}

function localBranch(ctx: CommandContext): string | null {
  const local = findRepo(ctx.state, ctx.vfs, ctx.state.cwd);
  return local ? currentBranch(local) : null;
}

/** GitLab's status words. */
function statusWord(run: CiRun, now: number): string {
  if (run.error) return 'failed';
  const s = runState(run, now);
  if (s.status === 'in_progress') return 'running';
  if (s.status === 'queued') return run.jobs.some((j) => j.status === 'stuck') ? 'pending' : 'created';
  if (s.status === 'waiting') return 'manual';
  return s.conclusion === 'success' ? 'success' : s.conclusion === 'cancelled' ? 'canceled' : 'failed';
}

function jobWord(job: CiJob, now: number): string {
  if (job.status === 'manual') return 'manual';
  if (job.status === 'stuck') return 'pending';
  if (job.status === 'created') return 'created';
  const s = jobState(job, now);
  if (s.status === 'in_progress') return 'running';
  if (s.status === 'queued') return 'pending';
  return s.conclusion === 'success' ? 'success' : s.conclusion === 'skipped' ? 'skipped' : s.conclusion === 'cancelled' ? 'canceled' : 'failed';
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
}

function pipelineFor(repo: ForgeRepo, branch: string | null, id?: string): CiRun {
  const runs = [...repo.runs].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const run = id ? runs.find((r) => String(r.id) === id || String(r.number) === id) : runs.find((r) => !branch || r.branch === branch);
  if (!run) throw new GlabError(id ? `ERROR: 404 Not found` : `ERROR: No pipelines running or available on branch: ${branch}`);
  return run;
}

function findJob(run: CiRun, ref: string | undefined, repo: ForgeRepo): CiJob {
  if (!ref) throw new GlabError('ERROR: job id or name is required');
  const job = run.jobs.find((j) => String(j.id) === ref || j.name === ref) ?? repo.runs.flatMap((r) => r.jobs).find((j) => String(j.id) === ref);
  if (!job) throw new GlabError(`ERROR: no job found with name or ID "${ref}"`);
  return job;
}

function glabCi(ctx: CommandContext, argv: string[]): number {
  const [sub, ...rest] = argv;
  const now = ctx.state.clock;
  switch (sub) {
    case 'list':
    case 'ls': {
      const p = parse(rest, [], ['status', 'per-page', 'page', 'ref'], { s: 'status', P: 'per-page', p: 'page', r: 'ref' });
      const { repo } = target(ctx, p);
      let runs = [...repo.runs].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
      if (p.flags.ref) runs = runs.filter((r) => r.branch === p.flags.ref);
      if (p.flags.status) runs = runs.filter((r) => statusWord(r, now) === p.flags.status);
      runs = runs.slice(0, Number(p.flags['per-page'] ?? 30));
      if (!runs.length) {
        ctx.out(`No Pipelines available on ${repo.slug}\n`);
        return 0;
      }
      ctx.out(`Showing ${runs.length} pipelines on ${repo.slug} (Page 1)\n\n${runs.map((r) => `(${statusWord(r, now)}) • #${r.id}\t${r.branch}\t(${ago(now, r.createdAt)})\n`).join('')}\n`);
      return 0;
    }
    case 'status':
    case 'stats': {
      const p = parse(rest, ['live', 'compact'], ['branch'], { b: 'branch', l: 'live', c: 'compact' });
      const t = target(ctx, p);
      const branch = (p.flags.branch as string | undefined) ?? localBranch(ctx);
      const run = pipelineFor(t.repo, branch);
      if (p.flags.live) {
        // Follow the pipeline until nothing is running any more (manual / stuck jobs stop it).
        const end = Math.max(ctx.state.clock, ...run.jobs.map((j) => j.completedAt ?? 0));
        ctx.state.clock = end + 1000;
      }
      const now = ctx.state.clock;
      let out = '';
      if (run.error) out += `${run.error}\n`;
      for (const j of run.jobs) {
        const dur = j.startedAt !== undefined && j.completedAt !== undefined && jobState(j, now).status === 'completed' ? j.completedAt - j.startedAt : 0;
        out += `(${jobWord(j, now)}) • ${mmss(dur)}\t${j.stage ?? ''}\t\t${j.name}\n`;
      }
      out += `\nhttps://${hostOf(t.url)}/${t.repo.slug}/-/pipelines/${run.id}\nSHA: ${run.sha}\nPipeline state: ${statusWord(run, now)}\n`;
      const stuck = run.jobs.filter((j) => j.status === 'stuck');
      for (const j of stuck) out += `\nThis job is stuck because you don't have any active runners online or available with any of these tags assigned to them: ${(j.labels ?? []).join(' ')}\n`;
      ctx.out(out);
      return 0;
    }
    case 'trace': {
      const p = parse(rest, [], ['branch', 'pipeline-id'], { b: 'branch', p: 'pipeline-id' });
      const t = target(ctx, p);
      const run = pipelineFor(t.repo, (p.flags.branch as string | undefined) ?? localBranch(ctx), p.flags['pipeline-id'] as string | undefined);
      const job = findJob(run, p.args[0], t.repo);
      ctx.out(`\nGetting job trace...\nShowing logs for ${job.name} job #${job.id}\n`);
      if (job.status === 'manual') {
        ctx.out(`This job does not have a trace (it is a manual action: \`glab ci trigger ${job.name}\` starts it)\n`);
        return 0;
      }
      if (job.status === 'stuck' || job.status === 'created') {
        ctx.out(`Waiting for job to start...\nThis job is stuck because you don't have any active runners online or available with any of these tags assigned to them: ${(job.labels ?? []).join(' ')}\n`);
        return 0;
      }
      if (job.status === 'skipped') {
        ctx.out('This job has been skipped\n');
        return 0;
      }
      if (job.completedAt !== undefined && ctx.state.clock < job.completedAt) ctx.state.clock = job.completedAt;
      ctx.out(job.steps.flatMap((s) => s.log).join('\n') + '\n');
      return 0;
    }
    case 'trigger':
    case 'retry': {
      const p = parse(rest, [], ['branch', 'pipeline-id'], { b: 'branch', p: 'pipeline-id' });
      const t = target(ctx, p);
      const run = pipelineFor(t.repo, (p.flags.branch as string | undefined) ?? localBranch(ctx), p.flags['pipeline-id'] as string | undefined);
      const job = findJob(run, p.args[0], t.repo);
      const owner = t.repo.runs.find((r) => r.jobs.includes(job)) ?? run;
      const api = `https://${hostOf(t.url)}/api/v4/projects/${encodeURIComponent(t.repo.slug)}/jobs/${job.id}`;
      if (sub === 'trigger') {
        if (job.status !== 'manual') throw new GlabError(`ERROR: POST ${api}/play: 403 {message: 403 Forbidden  - Unplayable Job}`);
        playGitlabJob(ctx.state, t.url, t.remote, owner, job);
        ctx.out(`Triggered job (id: ${job.id} ), status: pending , ref: ${owner.branch} , weburl: https://${hostOf(t.url)}/${t.repo.slug}/-/jobs/${job.id} )\n`);
        return 0;
      }
      if (!['success', 'failure', 'cancelled'].includes(job.status)) throw new GlabError(`ERROR: POST ${api}/retry: 403 {message: 403 Forbidden  - Job is not retryable}`);
      retryGitlabJob(ctx.state, t.url, t.remote, owner, job);
      ctx.out(`Retried job (ID: ${job.id} ), status: pending , ref: ${owner.branch} , weburl: https://${hostOf(t.url)}/${t.repo.slug}/-/jobs/${job.id} )\n`);
      return 0;
    }
    case 'run':
    case 'create': {
      const p = parse(rest, [], ['branch', 'variables'], { b: 'branch' });
      const t = target(ctx, p);
      const branch = (p.flags.branch as string | undefined) ?? localBranch(ctx) ?? 'main';
      const sha = t.remote.heads[branch];
      if (!sha) throw new GlabError(`ERROR: POST https://${hostOf(t.url)}/api/v4/projects/${encodeURIComponent(t.repo.slug)}/pipeline: 400 {message: {base: [Reference not found]}}`);
      const variables: Record<string, string> = {};
      for (const kv of p.multi.variables ?? []) {
        const i = kv.indexOf(':');
        if (i <= 0) throw new GlabError(`ERROR: invalid variable format "${kv}", expected key:value`);
        variables[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const run = startGitlabPipeline(ctx.state, t.url, t.remote, { source: 'web', branch, sha, variables });
      if (!run) throw new GlabError(`ERROR: POST https://${hostOf(t.url)}/api/v4/projects/${encodeURIComponent(t.repo.slug)}/pipeline: 400 {message: {base: [Pipeline will not run for the selected trigger. The rules configuration prevented any jobs from being added to the pipeline.]}}`);
      ctx.out(`Created pipeline (id: ${run.id} ), status: created , ref: ${branch} , weburl: https://${hostOf(t.url)}/${t.repo.slug}/-/pipelines/${run.id} )\n`);
      return 0;
    }
    case 'lint': {
      const file = rest[0] ?? '.gitlab-ci.yml';
      let text: string;
      try {
        text = ctx.vfs.readFile(ctx.resolve(file));
      } catch {
        throw new GlabError(`ERROR: open ${file}: no such file or directory`);
      }
      ctx.out('Validating...\n');
      const r = parseGitlab(text);
      if ('error' in r) {
        ctx.out(`${file} is invalid\n1 ${r.error}\n`);
        return 1;
      }
      ctx.out('✓ CI/CD YAML is valid!\n');
      return 0;
    }
    case 'view':
      throw new GlabError('devquest: the interactive pipeline viewer needs a full-screen terminal; use `glab ci status` and `glab ci trace JOB` instead');
    case 'delete':
    case 'cancel':
    case 'artifact':
    case 'get':
      throw new GlabError(`devquest: 'glab ci ${sub}' is real, but not simulated here`);
  }
  throw new GlabError(`ERROR: unknown command "${sub ?? ''}" for "glab ci"\n\nAvailable commands: list, status, trace, trigger, retry, run, lint`);
}

function glabVariable(ctx: CommandContext, argv: string[]): number {
  const [sub, ...rest] = argv;
  const p = parse(rest, ['protected', 'masked', 'raw'], ['value', 'type', 'scope'], { p: 'protected', m: 'masked', t: 'type', s: 'scope', v: 'value' });
  const { repo } = target(ctx, p);
  switch (sub) {
    case 'set':
    case 'new':
    case 'create':
    case 'update': {
      const [key, positional] = p.args;
      const value = (p.flags.value as string | undefined) ?? positional ?? ctx.stdin.replace(/\n$/, '');
      if (!key) throw new GlabError('ERROR: key is required');
      if (!/^[A-Za-z0-9_]+$/.test(key)) throw new GlabError('ERROR: key is invalid. A valid key can only contain letters, numbers, and underscores.');
      if (p.flags.masked && value.length < 8) throw new GlabError(`ERROR: POST https://gitlab.com/api/v4/projects/${encodeURIComponent(repo.slug)}/variables: 400 {message: {value: [is invalid]}}`);
      const existed = !!repo.variables[key];
      repo.variables[key] = { value, protected: !!p.flags.protected, masked: !!p.flags.masked, file: p.flags.type === 'file', updatedAt: ctx.state.clock };
      ctx.out(`✓ ${existed ? 'Updated' : 'Created'} variable ${key} for ${repo.slug} with scope *.\n`);
      return 0;
    }
    case 'list':
    case 'ls': {
      const rows = [['KEY', 'PROTECTED', 'MASKED', 'EXPANDED', 'SCOPE'], ...Object.entries(repo.variables).map(([k, v]) => [k, String(!!v.protected), String(!!v.masked), 'true', '*'])];
      const w: number[] = [];
      for (const r of rows) r.forEach((c, i) => (w[i] = Math.max(w[i] ?? 0, c.length)));
      ctx.out(rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join('\t').trimEnd() + '\n').join(''));
      return 0;
    }
    case 'get': {
      const v = repo.variables[p.args[0] ?? ''];
      if (!v) throw new GlabError('ERROR: 404 Variable Not Found');
      ctx.out(v.value + '\n');
      return 0;
    }
    case 'delete': {
      if (!repo.variables[p.args[0] ?? '']) throw new GlabError('ERROR: 404 Variable Not Found');
      delete repo.variables[p.args[0]];
      ctx.out(`✓ Deleted variable ${p.args[0]} with scope * for ${repo.slug}.\n`);
      return 0;
    }
  }
  throw new GlabError(`ERROR: unknown command "${sub ?? ''}" for "glab variable"`);
}

export const glab: CommandDef = {
  name: 'glab',
  summary: 'GitLab CLI (simulated: ci, variable, auth)',
  run(ctx) {
    const [sub, ...rest] = ctx.args;
    try {
      switch (sub) {
        case undefined:
        case 'help':
        case '--help':
          ctx.out('GLab is an open source GitLab CLI tool that brings GitLab to your command line.\n\nUSAGE\n  glab <command> <subcommand> [flags]\n\nCORE COMMANDS (simulated)\n  auth:        Manage glab\'s authentication state\n  ci:          Work with GitLab CI/CD pipelines and jobs\n  variable:    Manage variables for a GitLab project or group\n');
          return 0;
        case 'version':
        case '--version':
          ctx.out('glab 1.48.0 (2024-10-17)\n');
          return 0;
        case 'auth':
          ctx.out('gitlab.com\n  ✓ Logged in to gitlab.com as student (/home/student/.config/glab-cli/config.yml)\n  ✓ Git operations for gitlab.com configured to use https protocol.\n  ✓ API calls for gitlab.com are made over https protocol.\n  ✓ REST API Endpoint: https://gitlab.com/api/v4/\n  ✓ GraphQL Endpoint: https://gitlab.com/api/graphql/\n  ✓ Token: **************************\n');
          return 0;
        case 'ci':
        case 'pipe':
        case 'pipeline':
          return glabCi(ctx, rest);
        case 'variable':
        case 'var':
          return glabVariable(ctx, rest);
        case 'mr':
        case 'issue':
        case 'repo':
        case 'release':
        case 'api':
          throw new GlabError(`devquest: 'glab ${sub}' is real, but not simulated here (simulated: ci, variable, auth)`);
      }
      throw new GlabError(`ERROR: unknown command "${sub}" for "glab"`);
    } catch (e) {
      if (e instanceof GlabError) {
        ctx.err(e.message + '\n');
        return 1;
      }
      throw e;
    }
  },
};
