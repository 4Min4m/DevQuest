/**
 * GitHub Actions: workflows in .github/workflows/*.yml run on push (and workflow_dispatch) in fresh
 * runner machines. Validation errors, `on` filters, needs/if, matrix, env/secrets/vars, outputs,
 * environments, and the known marketplace actions.
 */
import { isMap, isSeq, LineCounter, parseDocument, YAMLMap } from 'yaml';
import { commitTree } from '../git/repo';
import { blobText } from '../git/ops';
import type { Repo } from '../git/types';
import { forgeRepo, nextId } from '../forge';
import type { CiJob, CiRun, CiStep, ForgeRepo } from '../forge/types';
import type { SimState } from '../state';
import { resolveAction, hashFiles } from './actions';
import { condition, evaluate, ExprContext, ExprError, interpolate, str } from './expr';
import { advance, Engine } from './pipeline';
import { makeRunner, mask, Runner, runScript } from './runner';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

export const LINUX_LABELS = ['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04', 'ubuntu-20.04', 'linux', 'x64'];
const OTHER_HOSTED = ['windows-latest', 'windows-2022', 'windows-2019', 'macos-latest', 'macos-15', 'macos-14', 'macos-13'];

interface Workflow {
  file: string;
  name: string;
  on: J;
  env: Record<string, J>;
  jobs: Record<string, J>;
  runName?: string;
}

// ------------------------------------------------------------------ parsing & validation

const TOP_KEYS = ['name', 'run-name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs'];
const JOB_KEYS = ['name', 'needs', 'runs-on', 'permissions', 'environment', 'concurrency', 'outputs', 'env', 'defaults', 'if', 'steps', 'timeout-minutes', 'strategy', 'continue-on-error', 'container', 'services', 'uses', 'with', 'secrets'];
const STEP_KEYS = ['id', 'if', 'name', 'uses', 'run', 'working-directory', 'shell', 'with', 'env', 'continue-on-error', 'timeout-minutes'];

/** Parse and validate a workflow file. Returns the GitHub annotation text on error. */
export function parseWorkflow(file: string, text: string): Workflow | { error: string } {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const head = `Invalid workflow file: ${file}`;
  if (doc.errors.length) {
    const line = lc.linePos(doc.errors[0].pos[0]).line;
    return { error: `${head}#L${line}\nYou have an error in your yaml syntax on line ${line}` };
  }
  const where = (node: J) => {
    const range = node?.range ?? [0];
    const p = lc.linePos(range[0]);
    return { line: p.line, text: `${file} (Line: ${p.line}, Col: ${p.col})` };
  };
  const fail = (node: J, msg: string) => {
    const w = where(node);
    return { error: `${head}#L${w.line}\nThe workflow is not valid. ${w.text}: ${msg}` };
  };
  const root = doc.contents;
  if (!isMap(root)) return fail(root, 'Unexpected value');
  for (const pair of root.items) {
    const k = String((pair.key as J)?.value ?? pair.key);
    if (!TOP_KEYS.includes(k)) return fail(pair.key, `Unexpected value '${k}'`);
  }
  if (!root.has('on')) return fail(root, 'Required property is missing: on');
  const jobsNode = root.get('jobs', true) as J;
  if (!jobsNode) return fail(root, 'Required property is missing: jobs');
  if (!isMap(jobsNode)) return fail(jobsNode, 'Unexpected value');
  const keys = (jobsNode as YAMLMap).items.map((p) => String((p.key as J).value));
  for (const pair of (jobsNode as YAMLMap).items) {
    const key = String((pair.key as J).value);
    const job = pair.value as J;
    if (!isMap(job)) return fail(job ?? pair.key, `Unexpected value '${str((job as J)?.toJSON?.() ?? job)}'`);
    for (const jp of (job as YAMLMap).items) {
      const k = String((jp.key as J).value);
      if (!JOB_KEYS.includes(k)) return fail(jp.key, `Unexpected value '${k}'`);
    }
    if (!(job as YAMLMap).has('uses')) {
      if (!(job as YAMLMap).has('runs-on')) return fail(job, 'Required property is missing: runs-on');
      const steps = (job as YAMLMap).get('steps', true) as J;
      if (!steps) return fail(job, 'Required property is missing: steps');
      if (!isSeq(steps)) return fail(steps, 'A sequence was not expected');
      for (const st of steps.items as J[]) {
        if (!isMap(st)) return fail(st, 'Unexpected value');
        for (const sp of (st as YAMLMap).items) {
          const k = String((sp.key as J).value);
          if (!STEP_KEYS.includes(k)) return fail(sp.key, `Unexpected value '${k}'`);
        }
        const hasUses = (st as YAMLMap).has('uses');
        const hasRun = (st as YAMLMap).has('run');
        if (hasUses && hasRun) return fail((st as YAMLMap).get('run', true), "Unexpected value 'run'");
        if (!hasUses && !hasRun) return fail(st, "Required property is missing: one of 'uses' or 'run'");
        if (hasUses) {
          const u = String((st as YAMLMap).get('uses'));
          if (!/^[\w.-]+\/[\w./-]+@[\w.-]+$/.test(u) && !u.startsWith('./') && !u.startsWith('docker://')) {
            return fail((st as YAMLMap).get('uses', true), `Expected format {org}/{repo}[/path]@ref. Actual '${u}'`);
          }
        }
      }
    }
    const needs = (job as YAMLMap).get('needs', true) as J;
    if (needs) {
      const list: string[] = isSeq(needs) ? (needs.items as J[]).map((n) => String(n.value)) : [String(needs.value)];
      for (const n of list) {
        if (!keys.includes(n)) {
          const w = where(needs);
          return { error: `${head}#L${w.line}\nThe workflow is not valid. ${w.text}: Job '${key}' depends on unknown job '${n}'.` };
        }
      }
    }
  }
  const js = doc.toJS() as J;
  // Dependency cycles.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyc = (k: string): string | null => {
    if (done.has(k)) return null;
    if (visiting.has(k)) return k;
    visiting.add(k);
    for (const n of needsOf(js.jobs[k])) {
      const c = cyc(n);
      if (c) return c;
    }
    visiting.delete(k);
    done.add(k);
    return null;
  };
  for (const k of keys) {
    const c = cyc(k);
    if (c) return fail(jobsNode, `Job '${c}' depends on job '${needsOf(js.jobs[c])[0]}' which creates a cycle in the dependency graph.`);
  }
  return { file, name: js.name ?? file, on: js.on, env: js.env ?? {}, jobs: js.jobs, runName: js['run-name'] };
}

function needsOf(job: J): string[] {
  const n = job?.needs;
  return n === undefined || n === null ? [] : Array.isArray(n) ? n.map(String) : [String(n)];
}

// ------------------------------------------------------------------ triggers

function glob(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Branch/tag/path filters with `!negation` (last match wins). */
function filterMatch(patterns: J, value: string): boolean {
  const list: string[] = Array.isArray(patterns) ? patterns.map(String) : [String(patterns)];
  let ok = false;
  for (const p of list) {
    if (p.startsWith('!')) {
      if (glob(p.slice(1)).test(value)) ok = false;
    } else if (glob(p).test(value)) ok = true;
  }
  return ok;
}

export interface GhEvent {
  name: 'push' | 'workflow_dispatch';
  branch?: string;
  tag?: string;
  sha: string;
  before?: string;
  changed: string[];
  inputs?: Record<string, string>;
}

function eventConfig(on: J, name: string): J | undefined {
  if (typeof on === 'string') return on === name ? {} : undefined;
  if (Array.isArray(on)) return on.includes(name) ? {} : undefined;
  if (on && typeof on === 'object' && name in on) return on[name] ?? {};
  return undefined;
}

export function triggers(wf: Workflow, ev: GhEvent): boolean {
  const cfg = eventConfig(wf.on, ev.name);
  if (cfg === undefined) return false;
  if (ev.name !== 'push') return true;
  if (ev.tag) {
    if (cfg.tags !== undefined) return filterMatch(cfg.tags, ev.tag);
    if (cfg['tags-ignore'] !== undefined) return !filterMatch(cfg['tags-ignore'], ev.tag);
    return cfg.branches === undefined && cfg['branches-ignore'] === undefined && cfg.paths === undefined;
  }
  const branch = ev.branch ?? '';
  if (cfg.branches !== undefined && !filterMatch(cfg.branches, branch)) return false;
  if (cfg['branches-ignore'] !== undefined && filterMatch(cfg['branches-ignore'], branch)) return false;
  if ((cfg.branches === undefined && cfg['branches-ignore'] === undefined) && (cfg.tags !== undefined || cfg['tags-ignore'] !== undefined)) return false;
  if (cfg.paths !== undefined && !ev.changed.some((f) => filterMatch(cfg.paths, f))) return false;
  if (cfg['paths-ignore'] !== undefined && ev.changed.every((f) => filterMatch(cfg['paths-ignore'], f))) return false;
  return true;
}

// ------------------------------------------------------------------ runs

function workflowFiles(remote: Repo, sha: string): Record<string, string> {
  const tree = commitTree(remote, sha);
  const out: Record<string, string> = {};
  for (const [path, e] of Object.entries(tree)) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) out[path] = blobText(remote, e.sha);
  }
  return out;
}

function changedFiles(remote: Repo, before: string | undefined, after: string): string[] {
  const a = before && remote.objects.commits[before] ? commitTree(remote, before) : {};
  const b = commitTree(remote, after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p]?.sha !== b[p]?.sha);
}

function expandMatrix(job: J): Record<string, J>[] {
  const m = job.strategy?.matrix;
  if (!m || typeof m !== 'object') return [{}];
  let combos: Record<string, J>[] = [{}];
  for (const [k, vals] of Object.entries(m)) {
    if (k === 'include' || k === 'exclude') continue;
    const list = Array.isArray(vals) ? vals : [vals];
    combos = combos.flatMap((c) => list.map((v) => ({ ...c, [k]: v })));
  }
  for (const ex of (m.exclude ?? []) as J[]) combos = combos.filter((c) => !Object.entries(ex).every(([k, v]) => c[k] === v));
  for (const inc of (m.include ?? []) as J[]) {
    const target = combos.find((c) => Object.entries(inc).every(([k, v]) => !(k in c) || c[k] === v) && Object.keys(c).length);
    if (target && Object.keys(m).some((k) => k !== 'include' && k !== 'exclude')) Object.assign(target, inc);
    else combos.push({ ...inc });
  }
  return combos.filter((c) => Object.keys(c).length || combos.length === 1);
}

function matrixLabel(values: Record<string, J>): string {
  const v = Object.values(values).map((x) => (typeof x === 'object' ? JSON.stringify(x) : str(x)));
  return v.length ? ` (${v.join(', ')})` : '';
}

/** Start runs for every workflow this event triggers. Returns the new runs. */
export function startGithubRuns(host: SimState, url: string, remote: Repo, ev: GhEvent, onlyFile?: string): CiRun[] {
  const repo = forgeRepo(host, url);
  const created: CiRun[] = [];
  const commit = remote.objects.commits[ev.sha];
  for (const [file, text] of Object.entries(workflowFiles(remote, ev.sha))) {
    if (onlyFile && file !== onlyFile) continue;
    const wf = parseWorkflow(file, text);
    if ('error' in wf) {
      if (ev.name !== 'push') continue;
      const run = newRun(host, repo, file, file, ev, commit?.message ?? '');
      run.error = wf.error;
      created.push(run);
      continue;
    }
    if (!triggers(wf, ev)) continue;
    const run = newRun(host, repo, wf.name, file, ev, commit?.message ?? '');
    if (ev.name === 'workflow_dispatch') run.title = wf.name;
    if (wf.runName) {
      try {
        run.title = interpolate(wf.runName, exprCtx(host, repo, run, wf, {}, {}, null, {}, true));
      } catch {
        /* keep the default title */
      }
    }
    for (const [key, spec] of Object.entries(wf.jobs)) {
      for (const values of expandMatrix(spec)) {
        let name = (spec.name ?? key) as string;
        try {
          name = interpolate(String(name), exprCtx(host, repo, run, wf, values, {}, null, {}, true));
        } catch {
          /* keep raw */
        }
        if (Object.keys(values).length && !/\$\{\{/.test(String(spec.name ?? ''))) name += matrixLabel(values);
        const runsOn = spec['runs-on'];
        const labels = (Array.isArray(runsOn) ? runsOn : [runsOn]).filter((x) => x !== undefined).map((l) => {
          try {
            return interpolate(String(l), exprCtx(host, repo, run, wf, values, {}, null, {}, true));
          } catch {
            return String(l);
          }
        });
        run.jobs.push({ id: nextId(host, 31_000_000_000), name, key, status: 'created', needs: needsOf(spec), steps: [], outputs: {}, matrix: Object.keys(values).length ? values : undefined, labels });
      }
    }
    created.push(run);
  }
  for (const run of created) {
    repo.runs.push(run);
    if (!run.error) advance(run, githubEngine(host, url, remote, run), host.clock);
  }
  return created;
}

function newRun(host: SimState, repo: ForgeRepo, workflow: string, file: string, ev: GhEvent, message: string): CiRun {
  return {
    id: nextId(host, 11_600_000_000),
    number: repo.runs.filter((r) => r.file === file).length + 1,
    attempt: 1,
    workflow,
    file,
    event: ev.name,
    branch: ev.branch ?? ev.tag ?? '',
    tag: ev.tag,
    sha: ev.sha,
    title: message.split('\n')[0],
    actor: 'student',
    createdAt: host.clock,
    jobs: [],
    inputs: ev.inputs,
    artifacts: {},
  };
}

// ------------------------------------------------------------------ expressions

function secretsFor(repo: ForgeRepo, environment?: string): Record<string, string> {
  const out: Record<string, string> = { GITHUB_TOKEN: 'ghs_16C7e42F292c6912E7710c838347Ae178B4a' };
  for (const [k, v] of Object.entries(repo.secrets)) out[k] = v.value;
  if (environment) for (const [k, v] of Object.entries(repo.environments[environment]?.secrets ?? {})) out[k] = v.value;
  return out;
}

function exprCtx(_host: SimState, repo: ForgeRepo, run: CiRun, wf: Workflow, matrix: Record<string, J>, env: Record<string, string>, runner: Runner | null, extra: Record<string, J>, early = false): ExprContext {
  const ref = run.tag ? `refs/tags/${run.tag}` : `refs/heads/${run.branch}`;
  const [owner] = repo.slug.split('/');
  return {
    contexts: {
      github: {
        event_name: run.event,
        sha: run.sha,
        ref,
        ref_name: run.tag ?? run.branch,
        ref_type: run.tag ? 'tag' : 'branch',
        repository: repo.slug,
        repository_owner: owner,
        actor: run.actor,
        triggering_actor: run.actor,
        run_id: String(run.id),
        run_number: String(run.number),
        run_attempt: String(run.attempt),
        workflow: wf.name,
        server_url: 'https://github.com',
        api_url: 'https://api.github.com',
        workspace: runner?.workspace ?? `/home/runner/work/${repo.slug.split('/')[1]}/${repo.slug.split('/')[1]}`,
        token: '***',
        job: extra.jobKey ?? '',
        event: { inputs: run.inputs ?? {}, ref, head_commit: { message: run.title, id: run.sha }, after: run.sha },
        base_ref: '',
        head_ref: '',
      },
      env,
      vars: Object.fromEntries(Object.entries(repo.variables).map(([k, v]) => [k, v.value])),
      secrets: early ? {} : secretsFor(repo, extra.environment),
      inputs: run.inputs ?? {},
      matrix,
      strategy: { 'fail-fast': true, 'job-index': 0, 'job-total': 1 },
      needs: extra.needs ?? {},
      steps: extra.steps ?? {},
      job: { status: extra.jobStatus ?? 'success' },
      runner: { os: 'Linux', arch: 'X64', name: 'GitHub Actions 2', temp: '/home/runner/work/_temp', tool_cache: '/opt/hostedtoolcache' },
    },
    status: { success: extra.ok ?? true, failure: !(extra.ok ?? true), cancelled: false },
    hashFiles: runner ? (p) => hashFiles(runner, p) : undefined,
  };
}

function interpMap(m: Record<string, J> | undefined, ctx: ExprContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) out[k] = typeof v === 'string' ? interpolate(v, ctx) : str(v);
  return out;
}

// ------------------------------------------------------------------ the engine

/** The workflow a run came from (re-read from the commit). */
function workflowOf(remote: Repo, run: CiRun): Workflow | null {
  const files = workflowFiles(remote, run.sha);
  const text = files[run.file];
  if (text === undefined) return null;
  const wf = parseWorkflow(run.file, text);
  return 'error' in wf ? null : wf;
}

export function githubEngine(host: SimState, url: string, remote: Repo, run: CiRun): Engine {
  const repo = forgeRepo(host, url);
  const wf = workflowOf(remote, run);
  const needsCtx = (job: CiJob) =>
    Object.fromEntries(
      job.needs.map((n) => {
        const deps = run.jobs.filter((x) => x.key === n);
        const result = deps.some((d) => d.status === 'failure') ? 'failure' : deps.some((d) => d.status === 'cancelled') ? 'cancelled' : deps.every((d) => d.status === 'skipped') ? 'skipped' : 'success';
        return [n, { result, outputs: Object.assign({}, ...deps.map((d) => d.outputs)) }];
      }),
    );
  return {
    settled: (d) => ['success', 'failure', 'skipped', 'cancelled'].includes(d.status),
    decide(job, deps) {
      if (!wf) return 'skip';
      const spec = wf.jobs[job.key];
      const ok = deps.every((d) => d.status === 'success');
      let cond: boolean;
      try {
        cond = condition(spec.if, exprCtx(host, repo, run, wf, job.matrix ?? {}, {}, null, { needs: needsCtx(job), ok, jobKey: job.key }, true));
      } catch {
        cond = false;
      }
      if (!cond) return 'skip';
      const labels = job.labels ?? [];
      if (!labels.length || labels.some((l) => !LINUX_LABELS.includes(l) && !OTHER_HOSTED.includes(l))) return 'stuck';
      return 'run';
    },
    execute(job, start) {
      runJob(host, url, repo, run, wf!, job, start, needsCtx(job));
    },
  };
}

function hostname(job: CiJob): string {
  return `fv-az${(job.id % 900) + 100}-${(job.id % 9000) + 1000}`;
}

function runJob(host: SimState, url: string, repo: ForgeRepo, run: CiRun, wf: Workflow, job: CiJob, start: number, needs: Record<string, J>): void {
  const spec = wf.jobs[job.key];
  const name = repo.slug.split('/')[1];
  const workspace = `/home/runner/work/${name}/${name}`;
  const environment = typeof spec.environment === 'string' ? spec.environment : spec.environment?.name;
  const secrets = secretsFor(repo, environment);
  const secretValues = Object.values(secrets).filter(Boolean);
  if (environment) repo.environments[environment] ??= { secrets: {} };
  job.environment = environment;
  const ref = run.tag ? `refs/tags/${run.tag}` : `refs/heads/${run.branch}`;
  const tmp = '/home/runner/work/_temp';
  const ghEnv: Record<string, string> = {
    GITHUB_ACTIONS: 'true',
    GITHUB_SHA: run.sha,
    GITHUB_REF: ref,
    GITHUB_REF_NAME: run.tag ?? run.branch,
    GITHUB_REF_TYPE: run.tag ? 'tag' : 'branch',
    GITHUB_REPOSITORY: repo.slug,
    GITHUB_REPOSITORY_OWNER: repo.slug.split('/')[0],
    GITHUB_WORKSPACE: workspace,
    GITHUB_RUN_ID: String(run.id),
    GITHUB_RUN_NUMBER: String(run.number),
    GITHUB_RUN_ATTEMPT: String(run.attempt),
    GITHUB_ACTOR: run.actor,
    GITHUB_EVENT_NAME: run.event,
    GITHUB_JOB: job.key,
    GITHUB_WORKFLOW: wf.name,
    GITHUB_SERVER_URL: 'https://github.com',
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    RUNNER_TEMP: tmp,
  };
  const runner = makeRunner(host, { kind: 'github', job: job.name, clock: start, workspace, user: 'runner', hostname: hostname(job), env: ghEnv, cluster: false });
  runner.vfs.mkdir(`${tmp}/_runner_file_commands`, { parents: true });
  let ok = true;
  const steps: CiStep[] = [];
  const stepsCtx: Record<string, J> = {};
  let jobEnv: Record<string, string> = {};
  const ctx = (extraEnv: Record<string, string> = {}) =>
    exprCtx(host, repo, run, wf, job.matrix ?? {}, { ...jobEnv, ...extraEnv }, runner, { needs, steps: stepsCtx, environment, ok, jobKey: job.key, jobStatus: ok ? 'success' : 'failure' });
  const clockNow = () => runner.state.clock;
  const pushStep = (stepName: string, status: CiStep['status'], from: number, log: string[], minSecs = 1) => {
    if (runner.state.clock < from + minSecs * 1000) runner.state.clock = from + minSecs * 1000;
    steps.push({ name: stepName, status, startedAt: from, completedAt: runner.state.clock, log: log.map((l) => mask(l, secretValues)) });
  };
  // Set up job
  const setupLog = ['Current runner version: \'2.321.0\'', 'Operating System', '  Ubuntu', '  24.04.1', '  LTS', 'Runner Image', '  Image: ubuntu-24.04', '  Version: 20241117.1.0', 'GITHUB_TOKEN Permissions', '  Contents: read', '  Metadata: read', 'Secret source: Actions', 'Prepare workflow directory', 'Prepare all required actions'];
  if ((job.labels ?? []).some((l) => OTHER_HOSTED.includes(l))) setupLog.push('devquest: Windows and macOS runners are simulated as Ubuntu');
  const uses = (spec.steps ?? []).map((s: J) => s.uses).filter(Boolean) as string[];
  for (const u of [...new Set(uses)]) setupLog.push(`Download action repository '${u}' (SHA:${(job.id * 7919).toString(16).padEnd(40, 'a').slice(0, 40)})`);
  try {
    jobEnv = { ...interpMap(wf.env, ctx()), ...{} };
    jobEnv = { ...jobEnv, ...interpMap(spec.env, ctx()) };
  } catch (e) {
    setupLog.push(`##[error]${(e as Error).message}`);
    ok = false;
  }
  setupLog.push(`Complete job name: ${job.name}`);
  pushStep('Set up job', ok ? 'success' : 'failure', clockNow(), setupLog);
  for (const u of uses) {
    const r = resolveAction(u);
    if ('error' in r) {
      steps[0].log.push(`##[error]${r.error}`);
      steps[0].status = 'failure';
      ok = false;
      break;
    }
  }
  const posts: { name: string; fn: () => string[] }[] = [];
  const outFile = `${tmp}/_runner_file_commands/set_output_${job.id}`;
  const envFile = `${tmp}/_runner_file_commands/set_env_${job.id}`;
  for (const [i, st] of ((ok ? spec.steps : []) as J[]).entries()) {
    const id = st.id ?? `__run_${i}`;
    const from = clockNow();
    let stepName: string;
    let stepEnv: Record<string, string> = {};
    try {
      stepEnv = interpMap(st.env, ctx());
      stepName = st.name !== undefined ? interpolate(String(st.name), ctx(stepEnv)) : st.uses ? `Run ${st.uses}` : `Run ${String(st.run).trim().split('\n')[0]}`;
    } catch (e) {
      pushStep(st.name ?? `Step ${i + 1}`, 'failure', from, [`##[error]${(e as Error).message}`]);
      ok = false;
      continue;
    }
    let cond: boolean;
    try {
      cond = condition(st.if, ctx(stepEnv));
    } catch (e) {
      pushStep(stepName, 'failure', from, [`##[error]${(e as Error).message}`]);
      ok = false;
      continue;
    }
    if (!cond) {
      steps.push({ name: stepName, status: 'skipped', startedAt: from, completedAt: from, log: [] });
      stepsCtx[id] = { outputs: {}, outcome: 'skipped', conclusion: 'skipped' };
      continue;
    }
    let code = 0;
    const log: string[] = [];
    let outputs: Record<string, string> = {};
    if (st.uses) {
      const r = resolveAction(String(st.uses));
      let inputs: Record<string, string>;
      try {
        inputs = interpMap(st.with, ctx(stepEnv));
      } catch (e) {
        pushStep(stepName, 'failure', from, [`##[error]${(e as Error).message}`]);
        ok = false;
        continue;
      }
      log.push(`##[group]Run ${st.uses}`, 'with:', ...Object.entries(inputs).map(([k, v]) => `  ${k}: ${v.includes('\n') ? v.split('\n').join('\n  ') : v}`), '##[endgroup]');
      if ('impl' in r) {
        const res = r.impl({ runner, inputs, repo, url, run, sha: run.sha, ref, secrets: secretValues, jobOk: () => ok });
        code = res.code;
        log.push(...res.log.map((l) => (code !== 0 && /^(Error|ERROR)/.test(l) ? `##[error]${l.replace(/^Error: /, '')}` : l)));
        outputs = res.outputs ?? {};
        if (res.env) jobEnv = { ...jobEnv, ...res.env };
        if (res.post) posts.push({ name: `Post ${stepName}`, fn: res.post });
        runner.state.clock += (res.secs ?? 1) * 1000;
      }
    } else {
      let script: string;
      try {
        script = interpolate(String(st.run), ctx(stepEnv));
      } catch (e) {
        pushStep(stepName, 'failure', from, [`##[error]${e instanceof ExprError ? `The template is not valid. ${wf.file}: ${e.message}` : (e as Error).message}`]);
        ok = false;
        continue;
      }
      const envShown = Object.fromEntries(Object.entries({ ...jobEnv, ...stepEnv }).filter(([k]) => !k.startsWith('DEVQUEST_') && k !== 'KUBECONFIG'));
      log.push(`##[group]Run ${script.trim().split('\n')[0]}`, ...script.replace(/\n$/, '').split('\n'), 'shell: /usr/bin/bash -e {0}');
      if (Object.keys(envShown).length) log.push('env:', ...Object.entries(envShown).map(([k, v]) => `  ${k}: ${v}`));
      log.push('##[endgroup]');
      runner.vfs.writeFile(outFile, '');
      runner.vfs.writeFile(envFile, '');
      const wd = st['working-directory'] ?? spec.defaults?.run?.['working-directory'];
      const res = runScript(runner, script, { ...jobEnv, ...stepEnv, GITHUB_OUTPUT: outFile, GITHUB_ENV: envFile, GITHUB_STEP_SUMMARY: `${tmp}/_runner_file_commands/step_summary_${job.id}` }, { cwd: wd, secrets: secretValues });
      code = res.code;
      log.push(...res.log);
      if (code !== 0) log.push(`##[error]Process completed with exit code ${code}.`);
      outputs = parseKv(runner.vfs.readFile(outFile));
      jobEnv = { ...jobEnv, ...parseKv(runner.vfs.readFile(envFile)) };
    }
    const failed = code !== 0;
    const continueOnError = st['continue-on-error'] === true || st['continue-on-error'] === 'true';
    stepsCtx[id] = { outputs, outcome: failed ? 'failure' : 'success', conclusion: failed && !continueOnError ? 'failure' : 'success' };
    pushStep(stepName, failed ? 'failure' : 'success', from, log);
    if (failed && !continueOnError) ok = false;
  }
  for (const p of posts.reverse()) {
    const from = clockNow();
    pushStep(p.name, 'success', from, p.fn());
  }
  pushStep('Complete job', 'success', clockNow(), ['Cleaning up orphan processes']);
  // Job outputs
  try {
    job.outputs = interpMap(spec.outputs, ctx());
  } catch {
    job.outputs = {};
  }
  job.steps = steps;
  job.startedAt = start;
  job.completedAt = runner.state.clock;
  job.status = ok ? 'success' : 'failure';
}

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const heredoc = /^([\w-]+)<<(\S+)$/.exec(l);
    if (heredoc) {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i] !== heredoc[2]; i++) body.push(lines[i]);
      out[heredoc[1]] = body.join('\n');
      continue;
    }
    const eq = l.indexOf('=');
    if (eq > 0) out[l.slice(0, eq)] = l.slice(eq + 1);
  }
  return out;
}

// ------------------------------------------------------------------ entry points

/** A push to a GitHub remote: start the workflows it triggers. */
export function githubOnPush(host: SimState, url: string, remote: Repo, update: { branch?: string; tag?: string; before?: string; after: string }): CiRun[] {
  return startGithubRuns(host, url, remote, {
    name: 'push',
    branch: update.branch,
    tag: update.tag,
    sha: update.after,
    before: update.before,
    changed: changedFiles(remote, update.before, update.after),
  });
}

/** Re-run a run (all jobs, or only failed ones and what depends on them). */
export function rerunGithub(host: SimState, url: string, remote: Repo, run: CiRun, failedOnly: boolean): void {
  run.attempt += 1;
  run.createdAt = host.clock;
  const reset = new Set<string>();
  for (const j of run.jobs) if (!failedOnly || j.status === 'failure' || j.status === 'cancelled' || j.status === 'skipped') reset.add(j.key);
  // Dependents of reset jobs are reset too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const j of run.jobs) if (!reset.has(j.key) && j.needs.some((n) => reset.has(n))) {
      reset.add(j.key);
      grew = true;
    }
  }
  if (!failedOnly) run.artifacts = {};
  for (const j of run.jobs) {
    if (!reset.has(j.key)) continue;
    j.status = 'created';
    j.steps = [];
    j.outputs = {};
    delete j.startedAt;
    delete j.completedAt;
  }
  advance(run, githubEngine(host, url, remote, run), host.clock);
}

/** `gh workflow run`: returns an error message, or the new run. */
export function dispatchGithub(host: SimState, url: string, remote: Repo, file: string, branch: string, inputs: Record<string, string>): string | CiRun {
  const sha = remote.heads[branch];
  if (!sha) return `could not create workflow dispatch event: HTTP 422: No ref found for: ${branch}`;
  const files = workflowFiles(remote, sha);
  const text = files[file];
  if (text === undefined) return `could not create workflow dispatch event: HTTP 404: Not Found`;
  const wf = parseWorkflow(file, text);
  if ('error' in wf) return `could not create workflow dispatch event: HTTP 422: Workflow does not have 'workflow_dispatch' trigger`;
  const cfg = eventConfig(wf.on, 'workflow_dispatch');
  if (cfg === undefined) return `could not create workflow dispatch event: HTTP 422: Workflow does not have 'workflow_dispatch' trigger`;
  const declared: Record<string, J> = cfg?.inputs ?? {};
  for (const k of Object.keys(inputs)) if (!(k in declared)) return `could not create workflow dispatch event: HTTP 422: Unexpected inputs provided: ["${k}"]`;
  const full: Record<string, string> = {};
  for (const [k, d] of Object.entries(declared)) {
    if (inputs[k] !== undefined) full[k] = inputs[k];
    else if (d?.default !== undefined) full[k] = str(d.default);
    else if (d?.required) return `could not create workflow dispatch event: HTTP 422: Required input '${k}' not provided`;
    else full[k] = '';
    if (d?.type === 'choice' && Array.isArray(d.options) && !d.options.map(String).includes(full[k])) return `could not create workflow dispatch event: HTTP 422: Provided value '${full[k]}' for input '${k}' not in the list of allowed values`;
  }
  const runs = startGithubRuns(host, url, remote, { name: 'workflow_dispatch', branch, sha, changed: [], inputs: full }, file);
  return runs[0];
}

export { evaluate };
