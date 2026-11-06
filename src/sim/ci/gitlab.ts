/**
 * GitLab CI/CD: .gitlab-ci.yml pipelines with stages, needs, rules/only/except, manual jobs,
 * artifacts between stages, caches, CI/CD variables (protected / masked / file) and runner tags.
 */
import { parseDocument } from 'yaml';
import { blobText } from '../git/ops';
import { commitTree } from '../git/repo';
import type { Repo } from '../git/types';
import { forgeRepo, hostOf, nextId } from '../forge';
import type { CiJob, CiRun, ForgeRepo } from '../forge/types';
import type { SimState } from '../state';
import { joinPath } from '../vfs/path';
import { advance, Engine } from './pipeline';
import { collectFiles, makeRunner, mask, runScript, writeFiles } from './runner';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

const RESERVED = ['stages', 'variables', 'default', 'include', 'workflow', 'image', 'services', 'before_script', 'after_script', 'cache'];
const JOB_KEYS = ['script', 'before_script', 'after_script', 'stage', 'image', 'services', 'variables', 'rules', 'only', 'except', 'when', 'allow_failure', 'needs', 'dependencies', 'artifacts', 'cache', 'environment', 'tags', 'retry', 'timeout', 'coverage', 'extends', 'interruptible', 'resource_group', 'parallel', 'release', 'trigger', 'inherit', 'id_tokens', 'secrets', 'hooks'];
export const SHARED_RUNNER_TAGS = ['saas-linux-small-amd64', 'gitlab-org', 'docker', 'linux'];

export interface GlConfig {
  stages: string[];
  variables: Record<string, string>;
  defaults: J;
  workflowRules?: J[];
  jobs: Record<string, J>;
}

const asList = (v: J): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map((x) => String(x)) : [String(v)]);

/** Parse and validate .gitlab-ci.yml; errors read like GitLab's "This GitLab CI configuration is invalid". */
export function parseGitlab(text: string): GlConfig | { error: string } {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length) {
    const e = doc.errors[0];
    const m = /at line (\d+), column (\d+)/.exec(e.message);
    return { error: `(<unknown>): ${e.message.split(' at line')[0].replace(/\.$/, '').toLowerCase()}${m ? ` at line ${m[1]} column ${m[2]}` : ''}` };
  }
  const y = doc.toJS() ?? {};
  if (typeof y !== 'object' || Array.isArray(y)) return { error: 'Invalid configuration format' };
  if (y.include) return { error: 'devquest: `include:` (CI templates from other files) is not simulated; put the jobs in .gitlab-ci.yml' };
  const declared = y.stages ? asList(y.stages) : ['build', 'test', 'deploy'];
  const stages = ['.pre', ...declared.filter((s) => s !== '.pre' && s !== '.post'), '.post'];
  const defaults = { ...(y.default ?? {}) };
  for (const k of ['image', 'services', 'before_script', 'after_script', 'cache']) if (y[k] !== undefined && defaults[k] === undefined) defaults[k] = y[k];
  const raw: Record<string, J> = {};
  for (const [k, v] of Object.entries(y)) if (!RESERVED.includes(k)) raw[k] = v;
  // extends (single or list, from hidden or visible jobs)
  const resolve = (name: string, seen: string[] = []): J => {
    const job = raw[name];
    if (!job || typeof job !== 'object') return job;
    if (!job.extends) return job;
    let merged: J = {};
    for (const parent of asList(job.extends)) {
      if (seen.includes(parent)) return job;
      if (!raw[parent]) throw new Error(`${name}: unknown keys in \`extends\` (${parent})`);
      merged = deepMerge(merged, resolve(parent, [...seen, name]));
    }
    const { extends: _e, ...rest } = job;
    void _e;
    return deepMerge(merged, rest);
  };
  const jobs: Record<string, J> = {};
  try {
    for (const name of Object.keys(raw)) {
      if (name.startsWith('.')) continue;
      jobs[name] = resolve(name);
    }
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!Object.keys(jobs).length) return { error: 'jobs config should contain at least one visible job' };
  for (const [name, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) return { error: `jobs:${name} config should be a hash` };
    const unknown = Object.keys(job).filter((k) => !JOB_KEYS.includes(k));
    if (unknown.length) return { error: `jobs:${name} config contains unknown keys: ${unknown.join(', ')}` };
    if (job.script === undefined && job.trigger === undefined) return { error: `jobs:${name} config should implement the script:, run:, or trigger: keyword` };
    const stage = job.stage ?? 'test';
    if (!stages.includes(stage)) return { error: `${name} job: chosen stage ${stage} does not exist; available stages are ${stages.join(', ')}` };
    for (const n of asList(job.needs?.map ? job.needs.map((x: J) => (typeof x === 'object' ? x.job : x)) : job.needs)) {
      if (!jobs[n]) return { error: `${name} job: undefined need: ${n}` };
      if (stages.indexOf(jobs[n].stage ?? 'test') > stages.indexOf(stage)) return { error: `${name} job: need ${n} is not defined in current or prior stages` };
    }
    if (job.when !== undefined && !['on_success', 'on_failure', 'always', 'manual', 'never', 'delayed'].includes(job.when)) return { error: `jobs:${name} when unknown value: ${job.when}` };
  }
  const variables: Record<string, string> = {};
  for (const [k, v] of Object.entries(y.variables ?? {})) variables[k] = typeof v === 'object' && v ? String((v as J).value ?? '') : String(v);
  return { stages, variables, defaults, workflowRules: y.workflow?.rules, jobs };
}

function deepMerge(a: J, b: J): J {
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

// ------------------------------------------------------------------ rules

/** `$CI_COMMIT_BRANCH == "main" && $DEPLOY =~ /yes/`, the subset GitLab's rules:if understands. */
export function ruleIf(expr: string, vars: Record<string, string>): boolean {
  const toks = expr.match(/\$\{?\w+\}?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^/\\]|\\.)+\/i?|==|!=|=~|!~|&&|\|\||\(|\)|null/g) ?? [];
  let i = 0;
  const value = (): string | null | RegExp => {
    const t = toks[i++];
    if (t === undefined) return null;
    if (t === 'null') return null;
    if (t.startsWith('$')) {
      const v = vars[t.replace(/^\$\{?|\}$/g, '')];
      return v === undefined ? null : v;
    }
    if (t.startsWith('/')) {
      const m = /^\/(.*)\/(i?)$/.exec(t)!;
      return new RegExp(m[1], m[2]);
    }
    return t.slice(1, -1);
  };
  const cmp = (): boolean => {
    if (toks[i] === '(') {
      i++;
      const v = or();
      i++;
      return v;
    }
    const a = value();
    const op = toks[i];
    if (op === '==' || op === '!=' || op === '=~' || op === '!~') {
      i++;
      const b = value();
      if (op === '==') return a === b;
      if (op === '!=') return a !== b;
      const re = b instanceof RegExp ? b : new RegExp(String(b ?? ''));
      const hit = typeof a === 'string' && re.test(a);
      return op === '=~' ? hit : !hit;
    }
    return typeof a === 'string' && a !== '';
  };
  const and = (): boolean => {
    let v = cmp();
    while (toks[i] === '&&') {
      i++;
      const r = cmp();
      v = v && r;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (toks[i] === '||') {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  return or();
}

/** Does a job belong in this pipeline, and how (when / allow_failure)? */
function jobRule(job: J, vars: Record<string, string>, changed: string[]): { when: string; allowFailure?: boolean } | null {
  if (job.rules) {
    for (const r of job.rules as J[]) {
      if (r.if !== undefined && !ruleIf(String(r.if), vars)) continue;
      if (r.changes !== undefined) {
        const pats = asList(Array.isArray(r.changes) ? r.changes : r.changes.paths);
        if (!changed.some((f) => pats.some((p) => globMatch(p, f)))) continue;
      }
      const when = r.when ?? job.when ?? 'on_success';
      if (when === 'never') return null;
      return { when, allowFailure: r.allow_failure ?? job.allow_failure };
    }
    return null;
  }
  const ref = vars.CI_COMMIT_BRANCH ?? vars.CI_COMMIT_TAG ?? '';
  const refMatch = (list: string[]) =>
    list.some((x) => {
      if (x === 'branches') return !!vars.CI_COMMIT_BRANCH;
      if (x === 'tags') return !!vars.CI_COMMIT_TAG;
      if (x === 'pushes') return vars.CI_PIPELINE_SOURCE === 'push';
      if (x === 'web' || x === 'api') return vars.CI_PIPELINE_SOURCE === x;
      const re = /^\/(.*)\/$/.exec(x);
      return re ? new RegExp(re[1]).test(ref) : x === ref;
    });
  const only = job.only === undefined ? null : asList(Array.isArray(job.only) || typeof job.only === 'string' ? job.only : job.only.refs);
  const except = job.except === undefined ? null : asList(Array.isArray(job.except) || typeof job.except === 'string' ? job.except : job.except.refs);
  if (only && !refMatch(only)) return null;
  if (except && refMatch(except)) return null;
  return { when: job.when ?? 'on_success', allowFailure: job.allow_failure };
}

function globMatch(p: string, f: string): boolean {
  const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  return new RegExp(`^${re}$`).test(f);
}

// ------------------------------------------------------------------ pipelines

function configAt(remote: Repo, sha: string): string | null {
  const e = commitTree(remote, sha)['.gitlab-ci.yml'];
  return e ? blobText(remote, e.sha) : null;
}

function predefined(repo: ForgeRepo, run: CiRun, remote: Repo): Record<string, string> {
  const [ns, name] = [repo.slug.split('/').slice(0, -1).join('/'), repo.slug.split('/').pop()!];
  const host = hostOf(repo.url);
  const defaultBranch = 'branch' in remote.head ? remote.head.branch : 'main';
  const v: Record<string, string> = {
    CI: 'true',
    GITLAB_CI: 'true',
    CI_SERVER_URL: `https://${host}`,
    CI_SERVER_HOST: host,
    CI_PROJECT_PATH: repo.slug,
    CI_PROJECT_NAME: name,
    CI_PROJECT_NAMESPACE: ns,
    CI_PROJECT_DIR: `/builds/${repo.slug}`,
    CI_PROJECT_URL: `https://${host}/${repo.slug}`,
    CI_REPOSITORY_URL: `https://gitlab-ci-token:[MASKED]@${host}/${repo.slug}.git`,
    CI_DEFAULT_BRANCH: defaultBranch,
    CI_COMMIT_SHA: run.sha,
    CI_COMMIT_SHORT_SHA: run.sha.slice(0, 8),
    CI_COMMIT_REF_NAME: run.tag ?? run.branch,
    CI_COMMIT_REF_SLUG: (run.tag ?? run.branch).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 63),
    CI_COMMIT_TITLE: run.title,
    CI_COMMIT_MESSAGE: run.title,
    CI_PIPELINE_ID: String(run.id),
    CI_PIPELINE_IID: String(run.number),
    CI_PIPELINE_SOURCE: run.event,
    CI_REGISTRY: 'registry.gitlab.com',
    CI_REGISTRY_IMAGE: `registry.gitlab.com/${repo.slug}`,
    CI_REGISTRY_USER: 'gitlab-ci-token',
    CI_REGISTRY_PASSWORD: 'glcbt-64_zh1Gk3qQ9xYwP2mN8vRtL',
    CI_JOB_TOKEN: 'glcbt-64_zh1Gk3qQ9xYwP2mN8vRtL',
  };
  if (run.tag) v.CI_COMMIT_TAG = run.tag;
  else v.CI_COMMIT_BRANCH = run.branch;
  if (remote.protectedBranches?.includes(run.branch) || run.branch === defaultBranch) v.CI_COMMIT_REF_PROTECTED = 'true';
  else v.CI_COMMIT_REF_PROTECTED = 'false';
  return v;
}

/** Project CI/CD variables visible to this pipeline (protected ones only on protected refs). */
function projectVars(repo: ForgeRepo, protectedRef: boolean): Record<string, { value: string; masked?: boolean; file?: boolean }> {
  const out: Record<string, { value: string; masked?: boolean; file?: boolean }> = {};
  for (const [k, v] of Object.entries(repo.variables)) if (!v.protected || protectedRef) out[k] = v;
  return out;
}

export interface GlEvent {
  source: 'push' | 'web' | 'api';
  branch?: string;
  tag?: string;
  sha: string;
  before?: string;
  variables?: Record<string, string>;
}

/** Create a pipeline for a ref. Returns it (or null when no job matched / no config). */
export function startGitlabPipeline(host: SimState, url: string, remote: Repo, ev: GlEvent): CiRun | null {
  const text = configAt(remote, ev.sha);
  if (text === null) return null;
  const repo = forgeRepo(host, url);
  const commit = remote.objects.commits[ev.sha];
  const run: CiRun = {
    id: nextId(host, 1_540_000_000),
    number: repo.runs.length + 1,
    attempt: 1,
    workflow: 'pipeline',
    file: '.gitlab-ci.yml',
    event: ev.source,
    branch: ev.branch ?? ev.tag ?? '',
    tag: ev.tag,
    sha: ev.sha,
    title: (commit?.message ?? '').split('\n')[0],
    actor: 'student',
    createdAt: host.clock,
    jobs: [],
    inputs: ev.variables,
    artifacts: {},
  };
  const cfg = parseGitlab(text);
  if ('error' in cfg) {
    run.error = `This GitLab CI configuration is invalid: ${cfg.error}`;
    repo.runs.push(run);
    return run;
  }
  const vars = { ...cfg.variables, ...Object.fromEntries(Object.entries(projectVars(repo, false)).map(([k, v]) => [k, v.value])), ...predefined(repo, run, remote), ...(ev.variables ?? {}) };
  const changed = changedFiles(remote, ev.before, ev.sha);
  if (cfg.workflowRules) {
    const hit = (cfg.workflowRules as J[]).find((r) => r.if === undefined || ruleIf(String(r.if), vars));
    if (!hit || hit.when === 'never') return null;
  }
  const included = Object.entries(cfg.jobs)
    .map(([name, job]) => ({ name, job, rule: jobRule(job, vars, changed) }))
    .filter((x) => x.rule);
  if (!included.length) return null;
  const names = included.map((x) => x.name);
  const stageOf = (j: J) => j.stage ?? 'test';
  for (const { name, job, rule } of included) {
    const si = cfg.stages.indexOf(stageOf(job));
    const explicit = job.needs !== undefined ? asList(Array.isArray(job.needs) ? job.needs.map((x: J) => (typeof x === 'object' ? x.job : x)) : job.needs).filter((n) => names.includes(n)) : null;
    const needs = explicit ?? included.filter((x) => cfg.stages.indexOf(stageOf(x.job)) < si).map((x) => x.name);
    const when = rule!.when;
    const allowFailure = rule!.allowFailure ?? (when === 'manual' ? true : false);
    run.jobs.push({ id: nextId(host, 8_300_000_000), name, key: name, stage: stageOf(job), status: 'created', when, allowFailure, needs, steps: [], outputs: {}, labels: asList(job.tags) });
  }
  run.jobs.sort((a, b) => cfg.stages.indexOf(a.stage ?? 'test') - cfg.stages.indexOf(b.stage ?? 'test'));
  repo.runs.push(run);
  advance(run, gitlabEngine(host, url, remote, run), host.clock);
  return run;
}

function changedFiles(remote: Repo, before: string | undefined, after: string): string[] {
  const a = before && remote.objects.commits[before] ? commitTree(remote, before) : {};
  const b = commitTree(remote, after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p]?.sha !== b[p]?.sha);
}

export function gitlabEngine(host: SimState, url: string, remote: Repo, run: CiRun): Engine {
  const text = configAt(remote, run.sha);
  const parsed = text === null ? null : parseGitlab(text);
  const cfg = parsed && !('error' in parsed) ? parsed : null;
  const repo = forgeRepo(host, url);
  const ok = (d: CiJob) => d.status === 'success' || d.status === 'skipped' || (d.status === 'failure' && !!d.allowFailure) || (d.status === 'manual' && d.allowFailure !== false);
  return {
    settled: (d) => ['success', 'failure', 'skipped', 'cancelled'].includes(d.status) || (d.status === 'manual' && d.allowFailure !== false),
    decide(job, deps) {
      if (!cfg) return 'skip';
      const allOk = deps.every(ok);
      const played = job.when === 'manual-played';
      if (job.when === 'on_failure') {
        if (allOk) return 'skip';
      } else if (job.when !== 'always' && !allOk) return 'skip';
      if (job.when === 'manual' && !played) return 'manual';
      const available = [...SHARED_RUNNER_TAGS, ...(repo.runnerTags ?? [])];
      if ((job.labels ?? []).some((t) => !available.includes(t))) return 'stuck';
      return 'run';
    },
    execute(job, start) {
      runGitlabJob(host, url, repo, remote, run, cfg!, job, start);
    },
  };
}

function runGitlabJob(host: SimState, url: string, repo: ForgeRepo, remote: Repo, run: CiRun, cfg: GlConfig, job: CiJob, start: number): void {
  const spec = cfg.jobs[job.name];
  const pre = predefined(repo, run, remote);
  const protectedRef = pre.CI_COMMIT_REF_PROTECTED === 'true';
  const pv = projectVars(repo, protectedRef);
  const workspace = `/builds/${repo.slug}`;
  const tmpDir = `/builds/${repo.slug}.tmp`;
  const env: Record<string, string> = { ...pre, CI_JOB_ID: String(job.id), CI_JOB_NAME: job.name, CI_JOB_STAGE: job.stage ?? 'test', CI_JOB_URL: `https://${hostOf(url)}/${repo.slug}/-/jobs/${job.id}` };
  for (const [k, v] of Object.entries(cfg.variables)) env[k] = v;
  for (const [k, v] of Object.entries(spec.variables ?? {})) env[k] = typeof v === 'object' && v ? String((v as J).value ?? '') : String(v);
  for (const [k, v] of Object.entries(run.inputs ?? {})) env[k] = v;
  const fileVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(pv)) {
    if (v.file) {
      fileVars[k] = v.value;
      env[k] = `${tmpDir}/${k}`;
    } else env[k] = v.value;
  }
  // GitLab expands $VAR / ${VAR} references inside variable values.
  for (let pass = 0; pass < 3; pass++) {
    for (const [k, v] of Object.entries(env)) env[k] = v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, n: string) => (n in env && n !== k ? env[n] : m));
  }
  const secrets = [pre.CI_REGISTRY_PASSWORD, ...Object.values(pv).filter((v) => v.masked).map((v) => v.value)];
  const image = spec.image ?? cfg.defaults.image ?? 'ruby:3.1';
  const imageName = String(typeof image === 'object' && image ? image.name ?? 'ruby:3.1' : image);
  const runner = makeRunner(host, { kind: 'gitlab', job: job.name, clock: start, workspace: '/builds', user: 'root', hostname: `runner-jlguopmm-project-${repo.slug.length * 7919}-concurrent-0`, env: {}, cluster: false });
  writeFiles(runner.vfs, tmpDir, fileVars);
  const log: string[] = [
    'Running with gitlab-runner 17.5.3 (12030cf4)',
    '  on green-4.saas-linux-small-amd64.runners-manager.gitlab.com/default JLgUopmM, system ID: s_deaa2ca09de7',
    'Preparing the "docker+machine" executor',
    `Using Docker executor with image ${imageName} ...`,
    `Pulling docker image ${imageName} ...`,
    `Using docker image sha256:4f2a1c9be0d4a8c3f5e6b7d8a9c0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192 for ${imageName} with digest ${imageName.split(':')[0]}@sha256:9d1b2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d ...`,
    'Preparing environment',
    `Running on ${runner.state.hostname} via runner-jlguopmm-s-l-s-amd64-1730883600-4b1c...`,
    'Getting source from Git repository',
    'Fetching changes with git depth set to 20...',
    `Initialized empty Git repository in ${workspace}/.git/`,
    'Created fresh repository.',
  ];
  const sh = (line: string, cwd: string) => {
    runner.state.cwd = cwd;
    const r = runner.shell.run(line);
    return { code: r.exitCode, text: r.output.map((o) => o.text).join('') };
  };
  sh(`git clone -q ${url} ${workspace}`, '/builds');
  sh(`git checkout -q ${run.sha}`, workspace);
  log.push(`Checking out ${run.sha.slice(0, 8)} as detached HEAD (ref is ${run.tag ?? run.branch})...`, 'Skipping Git submodules setup', '$ git remote set-url origin "${CI_REPOSITORY_URL}"');
  // cache
  const cacheSpec = spec.cache ?? cfg.defaults.cache;
  const cacheKey = cacheSpec ? `gl:${typeof cacheSpec.key === 'object' ? 'files-' + asList(cacheSpec.key.files).join('-') : cacheSpec.key ?? 'default'}-${protectedRef ? 'protected' : 'non_protected'}` : null;
  const cachePaths = cacheSpec ? asList(cacheSpec.paths) : [];
  if (cacheKey) {
    log.push('Restoring cache', `Checking cache for ${cacheKey.slice(3)}...`);
    const files = repo.caches[cacheKey];
    if (files) {
      writeFiles(runner.vfs, workspace, files);
      log.push('No URL provided, cache will not be downloaded from shared cache server. Instead a local version of cache will be extracted.', 'Successfully extracted cache');
    } else log.push('WARNING: file does not exist', 'Failed to extract cache');
  }
  // artifacts from dependencies
  const depNames = spec.dependencies !== undefined ? asList(spec.dependencies) : job.needs;
  for (const dep of depNames) {
    const files = run.artifacts[dep];
    const depJob = run.jobs.find((j) => j.name === dep);
    if (!files || !depJob) continue;
    writeFiles(runner.vfs, workspace, files);
    log.push(`Downloading artifacts for ${dep} (${depJob.id})...`, `Downloading artifacts from coordinator... ok        host=cdn.artifacts.gitlab-static.net id=${depJob.id} responseStatus=200 OK token=glcbt-64`);
  }
  log.push('Executing "step_script" stage of the job script');
  if (spec.environment) job.environment = typeof spec.environment === 'string' ? spec.environment : spec.environment.name;
  const before = asList(spec.before_script ?? cfg.defaults.before_script);
  const script = asList(spec.script);
  const res = runScript(runner, [...before, ...script].join('\n'), env, { cwd: workspace, echo: true, secrets });
  log.push(...res.log);
  let ok = res.code === 0;
  const after = asList(spec.after_script ?? cfg.defaults.after_script);
  if (after.length) {
    log.push('Running after_script', 'Running after script...');
    log.push(...runScript(runner, after.join('\n'), env, { cwd: workspace, echo: true, secrets }).log);
  }
  if (cacheKey && ok) {
    const files: Record<string, string> = {};
    for (const p of cachePaths) {
      const got = collectFiles(runner.vfs, joinPath(workspace, p));
      if (got) for (const [f, c] of Object.entries(got)) files[joinPath(p, f).replace(/^\.\//, '')] = c;
    }
    log.push('Saving cache for successful job', `Creating cache ${cacheKey.slice(3)}...`);
    for (const p of cachePaths) log.push(collectFiles(runner.vfs, joinPath(workspace, p)) ? `${p}: found ${Object.keys(collectFiles(runner.vfs, joinPath(workspace, p))!).length} matching artifact files and directories` : `WARNING: ${p}: no matching files. Ensure that the artifact path is relative to the working directory (${workspace})`);
    if (Object.keys(files).length) {
      repo.caches[cacheKey] = files;
      log.push('No URL provided, cache will not be uploaded to shared cache server. Cache will be stored only locally.', 'Created cache');
    }
  }
  const art = spec.artifacts;
  const artWhen = art?.when ?? 'on_success';
  if (art && (artWhen === 'always' || (artWhen === 'on_success' ? ok : !ok))) {
    log.push(`Uploading artifacts for ${ok ? 'successful' : 'failed'} job`, 'Uploading artifacts...');
    const files: Record<string, string> = {};
    let any = false;
    for (const p of asList(art.paths)) {
      const got = collectFiles(runner.vfs, joinPath(workspace, p));
      if (got) {
        any = true;
        const base = runner.vfs.isDir(joinPath(workspace, p)) ? p.replace(/\/$/, '') : p.split('/').slice(0, -1).join('/');
        for (const [f, c] of Object.entries(got)) files[base ? `${base}/${f}` : f] = c;
        log.push(`${p}: found ${Object.keys(got).length} matching artifact files and directories`);
      } else log.push(`WARNING: ${p}: no matching files. Ensure that the artifact path is relative to the working directory (${workspace})`);
    }
    if (any) {
      run.artifacts[job.name] = files;
      log.push(`Uploading artifacts as "archive" to coordinator... 201 Created  id=${job.id} responseStatus=201 Created token=glcbt-64`);
    } else log.push('ERROR: No files to upload');
  }
  log.push('Cleaning up project directory and file based variables');
  if (ok) log.push('Job succeeded');
  else log.push(`ERROR: Job failed: exit code ${res.code}`);
  if (!ok && job.allowFailure) ok = false;
  job.steps = [{ name: 'job', status: ok ? 'success' : 'failure', startedAt: start, completedAt: Math.max(runner.state.clock, start + 5000), log: log.map((l) => mask(l, secrets)) }];
  job.startedAt = start;
  job.completedAt = Math.max(runner.state.clock + 2000, start + 8000);
  job.status = ok ? 'success' : 'failure';
}

// ------------------------------------------------------------------ entry points

export function gitlabOnPush(host: SimState, url: string, remote: Repo, u: { branch?: string; tag?: string; before?: string; after: string }): CiRun | null {
  return startGitlabPipeline(host, url, remote, { source: 'push', branch: u.branch, tag: u.tag, sha: u.after, before: u.before });
}

/** Play a manual job (glab ci trigger). */
export function playGitlabJob(host: SimState, url: string, remote: Repo, run: CiRun, job: CiJob): void {
  job.when = 'manual-played';
  job.status = 'created';
  advance(run, gitlabEngine(host, url, remote, run), host.clock);
}

/** Retry a finished job (glab ci retry): a new job id, then everything after it runs again if needed. */
export function retryGitlabJob(host: SimState, url: string, remote: Repo, run: CiRun, job: CiJob): void {
  job.id = nextId(host, 8_300_000_000);
  job.status = 'created';
  job.steps = [];
  delete job.startedAt;
  delete job.completedAt;
  if (job.when === 'manual-played') job.when = 'manual-played';
  // Jobs that were skipped because of this one get another chance.
  for (const j of run.jobs) if (j.status === 'skipped' && j.needs.includes(job.name)) j.status = 'created';
  advance(run, gitlabEngine(host, url, remote, run), host.clock);
}
