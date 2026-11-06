/** The GitHub CLI (`gh`) for Actions: runs, logs, reruns, dispatches, secrets and variables. */
import type { Repo } from '../git/types';
import { ago, elapsed, findBySlug, forgeRepo, iso, jobState, repoForCwd, runEnd, runState, webUrl } from '../forge';
import type { CiJob, CiRun, ForgeRepo } from '../forge/types';
import type { CommandContext, CommandDef } from '../shell/types';
import { dispatchGithub, rerunGithub } from './github';

class GhError extends Error {
  constructor(
    message: string,
    public code = 1,
  ) {
    super(message);
  }
}

interface Parsed {
  flags: Record<string, string | true>;
  multi: Record<string, string[]>;
  args: string[];
}

function parse(argv: string[], bool: string[], value: string[], alias: Record<string, string> = {}): Parsed {
  const al = { R: 'repo', ...alias };
  const out: Parsed = { flags: {}, multi: {}, args: [] };
  const vals = new Set(['repo', ...value]);
  const set = (k: string, v: string | true) => {
    const key = al[k as keyof typeof al] ?? k;
    out.flags[key] = v;
    if (typeof v === 'string') (out.multi[key] ??= []).push(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const long = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    const short = /^-([A-Za-z])$/.exec(a);
    if (long || short) {
      const name = long ? long[1] : al[short![1] as keyof typeof al] ?? short![1];
      if (vals.has(name)) {
        const v = long?.[2] ?? argv[++i];
        if (v === undefined) throw new GhError(`flag needs an argument: ${a}`);
        set(name, v);
      } else if (bool.includes(name)) set(name, true);
      else throw new GhError(`unknown flag: ${a}\n\nUsage:  see \`gh --help\``);
      continue;
    }
    out.args.push(a);
  }
  return out;
}

function target(ctx: CommandContext, p: Parsed): { url: string; remote: Repo; repo: ForgeRepo } {
  if (typeof p.flags.repo === 'string') {
    const hit = findBySlug(ctx.state, p.flags.repo, 'github');
    if (!hit) throw new GhError(`HTTP 404: Not Found (https://api.github.com/repos/${p.flags.repo})`);
    return { ...hit, repo: forgeRepo(ctx.state, hit.url) };
  }
  const r = repoForCwd(ctx, 'github');
  if ('error' in r) throw new GhError(r.error);
  return { ...r, repo: forgeRepo(ctx.state, r.url) };
}

const ICON: Record<string, string> = { success: '✓', failure: 'X', cancelled: 'X', skipped: '-', manual: '!' };

function runIcon(run: CiRun, now: number): string {
  const s = runState(run, now);
  return s.status === 'completed' ? ICON[s.conclusion ?? 'success'] ?? '✓' : '*';
}

function jobIcon(job: CiJob, now: number): string {
  const s = jobState(job, now);
  return s.status === 'completed' ? ICON[s.conclusion ?? 'success'] ?? '✓' : '*';
}

function findRun(repo: ForgeRepo, id: string | undefined, ctx: CommandContext): CiRun {
  if (!id) {
    const latest = [...repo.runs].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0];
    if (!latest) throw new GhError('found no runs');
    ctx.note('devquest: no interactive picker here; using the most recent run\n');
    return latest;
  }
  const run = repo.runs.find((r) => String(r.id) === id);
  if (!run) throw new GhError(`failed to get run: HTTP 404: Not Found (https://api.github.com/repos/${repo.slug}/actions/runs/${id}?exclude_pull_requests=true)`);
  return run;
}

function table(rows: string[][]): string {
  const w: number[] = [];
  for (const r of rows) r.forEach((c, i) => (w[i] = Math.max(w[i] ?? 0, [...c].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(w[i] - [...c].length))).join('  ') + '\n').join('');
}

// ------------------------------------------------------------------ gh run

function runSummary(repo: ForgeRepo, run: CiRun, now: number, verbose: boolean): string {
  const st = runState(run, now);
  let out = `\n${runIcon(run, now)} ${run.branch} ${run.workflow} · ${run.id}${run.attempt > 1 ? ` (Attempt #${run.attempt})` : ''}\nTriggered via ${run.event} ${ago(now, run.createdAt)}\n\n`;
  if (run.error) {
    return out + `X This run likely failed because of a workflow file issue.\n\nANNOTATIONS\nX ${run.error.replace(/\n/g, '\n  ')}\n\nFor more information, see: ${webUrl(repo)}/actions/runs/${run.id}\n`;
  }
  out += 'JOBS\n';
  const annotations: string[] = [];
  for (const j of run.jobs) {
    const js = jobState(j, now);
    const dur = j.completedAt && j.startedAt && js.status === 'completed' ? ` in ${elapsed(j.completedAt - j.startedAt)}` : js.conclusion === 'skipped' ? ' in 0s' : '';
    out += `${jobIcon(j, now)} ${j.name}${dur} (ID ${j.id})\n`;
    const failed = js.status === 'completed' && j.status === 'failure';
    if ((verbose || failed) && js.status === 'completed') {
      for (const s of j.steps) out += `  ${s.status === 'success' ? '✓' : s.status === 'failure' ? 'X' : '-'} ${s.name}\n`;
    }
    if (failed) {
      const err = j.steps.flatMap((s) => s.log.filter((l) => l.startsWith('##[error]'))).pop();
      if (err) annotations.push(`X ${err.replace('##[error]', '')}\n${j.name}: .github#${(j.id % 40) + 1}\n`);
    }
    if (j.status === 'stuck') annotations.push(`- ${j.name}: Waiting for a runner to pick up this job... (no runner with the labels: ${(j.labels ?? []).join(', ')})\n`);
  }
  const arts = Object.keys(run.artifacts);
  if (arts.length && st.status === 'completed') out += `\nARTIFACTS\n${arts.join('\n')}\n`;
  if (annotations.length) out += `\nANNOTATIONS\n${annotations.join('\n')}`;
  out += '\n';
  if (st.status === 'completed' && st.conclusion === 'failure') out += `\nTo see what failed, try: gh run view ${run.id} --log-failed\n`;
  else out += `For more information about a job, try: gh run view --job=<job-id>\n`;
  out += `View this run on GitHub: ${webUrl(repo)}/actions/runs/${run.id}\n`;
  return out;
}

function runLogs(run: CiRun, now: number, failedOnly: boolean, jobId?: string): string {
  let out = '';
  for (const j of run.jobs) {
    if (jobId && String(j.id) !== jobId) continue;
    if (jobState(j, now).status !== 'completed') continue;
    if (failedOnly && j.status !== 'failure') continue;
    for (const s of j.steps) {
      if (failedOnly && s.status !== 'failure') continue;
      s.log.forEach((l, i) => {
        const t = new Date(s.startedAt + i * 37).toISOString().replace('Z', '0000Z');
        out += `${j.name}\t${s.name}\t${t} ${l}\n`;
      });
    }
  }
  return out;
}

function ghRun(ctx: CommandContext, argv: string[]): number {
  const [sub, ...rest] = argv;
  const now = ctx.state.clock;
  switch (sub) {
    case 'list':
    case 'ls': {
      const p = parse(rest, [], ['workflow', 'branch', 'limit', 'event', 'status', 'json', 'user', 'commit'], { w: 'workflow', b: 'branch', L: 'limit', e: 'event', s: 'status', u: 'user', c: 'commit' });
      const { repo } = target(ctx, p);
      let runs = [...repo.runs].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
      if (p.flags.workflow) runs = runs.filter((r) => r.workflow === p.flags.workflow || r.file.endsWith(`/${p.flags.workflow}`));
      if (p.flags.branch) runs = runs.filter((r) => r.branch === p.flags.branch);
      if (p.flags.event) runs = runs.filter((r) => r.event === p.flags.event);
      runs = runs.slice(0, Number(p.flags.limit ?? 20));
      if (!runs.length) {
        ctx.err('no runs found\n');
        return 0;
      }
      const rows = runs.map((r) => {
        const s = runState(r, now);
        const el = elapsed(Math.min(now, runEnd(r)) - r.createdAt);
        return { r, s, el };
      });
      if (!ctx.stdoutIsTTY) {
        ctx.out(rows.map(({ r, s, el }) => [s.status, s.conclusion ?? '', r.title, r.workflow, r.branch, r.event, String(r.id), el, iso(r.createdAt)].join('\t') + '\n').join(''));
        return 0;
      }
      ctx.out(table([['STATUS', 'TITLE', 'WORKFLOW', 'BRANCH', 'EVENT', 'ID', 'ELAPSED', 'AGE'], ...rows.map(({ r, el }) => [runIcon(r, now), r.title.length > 30 ? r.title.slice(0, 29) + '…' : r.title, r.workflow, r.branch, r.event, String(r.id), el, ago(now, r.createdAt)])]));
      return 0;
    }
    case 'view': {
      const p = parse(rest, ['log', 'log-failed', 'verbose', 'exit-status', 'web'], ['job', 'attempt', 'json'], { v: 'verbose', j: 'job' });
      if (p.flags.web) throw new GhError('devquest: there is no browser here; use `gh run view ID` and `--log` instead');
      const { repo } = target(ctx, p);
      const run = findRun(repo, p.args[0], ctx);
      if (p.flags.log || p.flags['log-failed']) {
        if (run.error) throw new GhError(`failed to get run log: log not found`);
        if (runState(run, now).status !== 'completed') throw new GhError(`run ${run.id} is still in progress; logs will be available when it is complete`);
        ctx.out(runLogs(run, now, !!p.flags['log-failed'], p.flags.job as string | undefined));
        return 0;
      }
      ctx.out(runSummary(repo, run, now, !!p.flags.verbose));
      return p.flags['exit-status'] && runState(run, now).conclusion === 'failure' ? 1 : 0;
    }
    case 'watch': {
      const p = parse(rest, ['exit-status', 'compact'], ['interval'], { i: 'interval' });
      const { repo } = target(ctx, p);
      const run = findRun(repo, p.args[0], ctx);
      const before = runState(run, now);
      if (before.status === 'completed') {
        ctx.out(`Run ${run.workflow} (${run.id}) has already completed with '${before.conclusion}'\n`);
        return p.flags['exit-status'] && before.conclusion !== 'success' ? 1 : 0;
      }
      const end = runEnd(run);
      const stuck = run.jobs.filter((j) => j.status === 'stuck' || j.status === 'manual');
      ctx.state.clock = Math.max(now, end + 1000);
      if (stuck.length) {
        ctx.state.clock = Math.max(ctx.state.clock, now + 10 * 60_000);
        ctx.out(runSummary(repo, run, ctx.state.clock, false));
        ctx.note(`devquest: stopped watching after 10 minutes: ${stuck.map((j) => j.name).join(', ')} never started (Waiting for a runner to pick up this job...)\n`);
        return 1;
      }
      ctx.out(`Refreshing run status every 3 seconds. Press Ctrl+C to quit.\n${runSummary(repo, run, ctx.state.clock, true)}`);
      const s = runState(run, ctx.state.clock);
      ctx.out(`\n${runIcon(run, ctx.state.clock)} Run ${run.workflow} (${run.id}) completed with '${s.conclusion}'\n`);
      return p.flags['exit-status'] && s.conclusion !== 'success' ? 1 : 0;
    }
    case 'rerun': {
      const p = parse(rest, ['failed', 'debug'], ['job'], { d: 'debug', j: 'job' });
      const t = target(ctx, p);
      const run = findRun(t.repo, p.args[0], ctx);
      const s = runState(run, now);
      if (s.status !== 'completed') throw new GhError(`run ${run.id} cannot be rerun; it is still in progress`);
      if (run.error) throw new GhError(`run ${run.id} cannot be rerun; its workflow file may be broken`);
      if (p.flags.failed && s.conclusion === 'success') throw new GhError(`run ${run.id} cannot be rerun; there are no failed jobs to rerun`);
      rerunGithub(ctx.state, t.url, t.remote, run, !!p.flags.failed);
      ctx.out(`✓ Requested rerun${p.flags.failed ? ' (failed jobs)' : ''} of run ${run.id}\n`);
      return 0;
    }
    case 'cancel':
    case 'delete':
    case 'download':
      throw new GhError(`devquest: 'gh run ${sub}' is real, but not simulated here`);
  }
  throw new GhError(`unknown command "${sub ?? ''}" for "gh run"\n\nAvailable commands: list, view, watch, rerun`);
}

// ------------------------------------------------------------------ gh workflow

function ghWorkflow(ctx: CommandContext, argv: string[]): number {
  const [sub, ...rest] = argv;
  const p = parse(rest, ['all', 'json'], ['ref', 'field', 'raw-field'], { r: 'ref', F: 'field', f: 'raw-field', a: 'all' });
  const t = target(ctx, p);
  const branch = t.remote.head && 'branch' in t.remote.head ? t.remote.head.branch : 'main';
  const files = Object.keys(t.remote.heads[branch] ? listWorkflows(t.remote, t.remote.heads[branch]) : {});
  switch (sub) {
    case 'list':
    case 'ls': {
      if (!files.length) {
        ctx.err('no workflows found\n');
        return 0;
      }
      const wfs = listWorkflows(t.remote, t.remote.heads[branch]);
      ctx.out(table([['NAME', 'STATE', 'ID'], ...Object.entries(wfs).map(([f, name], i) => [name, 'active', String(118_000_000 + i * 17 + f.length)])]));
      return 0;
    }
    case 'run': {
      const ref = (p.flags.ref as string | undefined) ?? branch;
      const wanted = p.args[0];
      if (!wanted) throw new GhError('workflow ID, name, or filename required when not running interactively');
      const wfs = listWorkflows(t.remote, t.remote.heads[ref] ?? t.remote.heads[branch]);
      const file = Object.keys(wfs).find((f) => f === wanted || f.endsWith(`/${wanted}`) || wfs[f] === wanted);
      if (!file) throw new GhError(`could not find any workflows named ${wanted}`);
      const inputs: Record<string, string> = {};
      for (const kv of [...(p.multi.field ?? []), ...(p.multi['raw-field'] ?? [])]) {
        const eq = kv.indexOf('=');
        if (eq <= 0) throw new GhError(`field "${kv}" requires a value separated by an '=' sign`);
        inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      const r = dispatchGithub(ctx.state, t.url, t.remote, file, ref, inputs);
      if (typeof r === 'string') throw new GhError(r);
      ctx.out(`✓ Created workflow_dispatch event for ${file.split('/').pop()} at ${ref}\n\nTo see runs for this workflow, try: gh run list --workflow=${file.split('/').pop()}\n`);
      return 0;
    }
  }
  throw new GhError(`unknown command "${sub ?? ''}" for "gh workflow"\n\nAvailable commands: list, run`);
}

function listWorkflows(remote: Repo, sha: string | undefined): Record<string, string> {
  if (!sha) return {};
  const out: Record<string, string> = {};
  const commit = remote.objects.commits[sha];
  if (!commit) return out;
  // Avoid a cycle with github.ts parsing: a light read of `name:`.
  const flat: Record<string, string> = {};
  const walk = (tree: string, prefix: string) => {
    for (const e of remote.objects.trees[tree] ?? []) {
      if (e.mode === '040000') walk(e.sha, `${prefix}${e.name}/`);
      else flat[`${prefix}${e.name}`] = remote.objects.blobs[e.sha] ?? '';
    }
  };
  walk(commit.tree, '');
  for (const [f, text] of Object.entries(flat)) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) continue;
    out[f] = /^name:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] ?? f;
  }
  return out;
}

// ------------------------------------------------------------------ gh secret / variable

function ghSecret(ctx: CommandContext, argv: string[], kind: 'secret' | 'variable'): number {
  const [sub, ...rest] = argv;
  const p = parse(rest, ['json'], ['body', 'env', 'org', 'visibility'], { b: 'body', e: 'env', o: 'org', v: 'visibility' });
  const t = target(ctx, p);
  const env = p.flags.env as string | undefined;
  const store = () => {
    if (kind === 'variable') return t.repo.variables;
    if (!env) return t.repo.secrets;
    return (t.repo.environments[env] ??= { secrets: {} }).secrets;
  };
  const label = kind === 'secret' ? 'Actions secret' : 'variable';
  switch (sub) {
    case 'set': {
      const name = p.args[0];
      if (!name) throw new GhError(`must pass name argument`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new GhError(`${kind === 'secret' ? 'Secret' : 'Variable'} names can only contain alphanumeric characters ([a-z], [A-Z], [0-9]) or underscores (_). Spaces are not allowed. Must start with a letter ([a-z], [A-Z]) or underscores (_).`);
      if (/^GITHUB_/i.test(name)) throw new GhError(`${kind === 'secret' ? 'Secret' : 'Variable'} names must not start with GITHUB_.`);
      const value = typeof p.flags.body === 'string' ? p.flags.body : ctx.stdin.replace(/\n$/, '');
      if (!value && typeof p.flags.body !== 'string') throw new GhError(`no ${kind} value provided; pass --body or pipe it into the command`);
      const existed = !!store()[name];
      store()[name] = { value, updatedAt: ctx.state.clock };
      const where = env ? `environment ${env}` : t.repo.slug;
      ctx.out(kind === 'secret' ? `✓ Set ${label} ${name} for ${where}\n` : `✓ ${existed ? 'Updated' : 'Created'} ${label} ${name} for ${where}\n`);
      return 0;
    }
    case 'list':
    case 'ls': {
      const entries = Object.entries(store());
      if (!entries.length) {
        ctx.err(`no ${kind}s found\n`);
        return 0;
      }
      const head = kind === 'secret' ? ['NAME', 'UPDATED'] : ['NAME', 'VALUE', 'UPDATED'];
      ctx.out(table([head, ...entries.sort().map(([k, v]) => (kind === 'secret' ? [k, ago(ctx.state.clock, v.updatedAt)] : [k, v.value, ago(ctx.state.clock, v.updatedAt)]))]));
      return 0;
    }
    case 'delete':
    case 'remove': {
      const name = p.args[0];
      if (!name || !store()[name]) throw new GhError(`failed to delete ${kind} ${name ?? ''}: HTTP 404: Not Found`);
      delete store()[name];
      ctx.out(`✓ Deleted ${label} ${name} from ${env ? `environment ${env}` : t.repo.slug}\n`);
      return 0;
    }
  }
  throw new GhError(`unknown command "${sub ?? ''}" for "gh ${kind}"\n\nAvailable commands: delete, list, set`);
}

// ------------------------------------------------------------------ the command

const HELP = `Work seamlessly with GitHub from the command line.

USAGE
  gh <command> <subcommand> [flags]

CORE COMMANDS (simulated)
  auth:        Authenticate gh and git with GitHub
  run:         View details about workflow runs
  workflow:    View details about GitHub Actions workflows
  secret:      Manage GitHub secrets
  variable:    Manage GitHub Actions variables
`;

export const gh: CommandDef = {
  name: 'gh',
  summary: 'GitHub CLI (simulated: run, workflow, secret, variable, auth)',
  run(ctx) {
    const [sub, ...rest] = ctx.args;
    try {
      switch (sub) {
        case undefined:
        case 'help':
        case '--help':
          ctx.out(HELP);
          return 0;
        case '--version':
        case 'version':
          ctx.out('gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0\n');
          return 0;
        case 'auth':
          if (rest[0] === 'status') {
            ctx.out('github.com\n  ✓ Logged in to github.com account student (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n  - Token scopes: \'gist\', \'read:org\', \'repo\', \'workflow\'\n');
            return 0;
          }
          throw new GhError(`devquest: you're already logged in as student (try \`gh auth status\`)`);
        case 'run':
          return ghRun(ctx, rest);
        case 'workflow':
          return ghWorkflow(ctx, rest);
        case 'secret':
          return ghSecret(ctx, rest, 'secret');
        case 'variable':
          return ghSecret(ctx, rest, 'variable');
        case 'pr':
        case 'issue':
        case 'repo':
        case 'release':
        case 'api':
        case 'browse':
        case 'cache':
          throw new GhError(`devquest: 'gh ${sub}' is real, but not simulated here (simulated: run, workflow, secret, variable, auth)`);
      }
      throw new GhError(`unknown command "${sub}" for "gh"\n\nUsage:  gh <command> <subcommand> [flags]`);
    } catch (e) {
      if (e instanceof GhError) {
        ctx.err(e.message + '\n');
        return e.code;
      }
      throw e;
    }
  },
};
