/** CI runner machines: a fresh simulated Linux box per job, sharing the outside world (remotes, registry). */
import type { RunResult } from '../shell/types';
import { createDockerState, createInitialState, SimState } from '../state';
import { joinPath } from '../vfs/path';
import { Vfs } from '../vfs/vfs';

interface ShellLike {
  run(line: string): RunResult;
  state: SimState;
}

let factory: ((s: SimState) => ShellLike) | null = null;

/** Wired by sim/index.ts (avoids an import cycle with the command registry). */
export function setRunnerShellFactory(f: (s: SimState) => ShellLike): void {
  factory = f;
}

export interface Runner {
  state: SimState;
  shell: ShellLike;
  /** Directory the job starts in. */
  workspace: string;
  vfs: Vfs;
}

export interface RunnerOptions {
  kind: 'github' | 'gitlab';
  job: string;
  clock: number;
  workspace: string;
  user: 'runner' | 'root';
  hostname: string;
  /** Environment for every step (PATH etc. are added). */
  env: Record<string, string>;
  /** Can kubectl reach the cluster (a kubeconfig was provided)? */
  cluster: boolean;
}

/** Boot a runner for one job. Remotes, registry, forge and project specs are shared with the host. */
export function makeRunner(host: SimState, o: RunnerOptions): Runner {
  if (!factory) throw new Error('runner shell factory not set');
  const s = createInitialState({ clock: o.clock });
  s.hostname = o.hostname;
  s.processes = s.processes.filter((p) => p.user === 'root');
  s.history = [];
  s.commandLog = [];
  s.docker = createDockerState(o.clock);
  s.git = { repos: {}, remotes: host.git?.remotes ?? {} };
  s.forge = host.forge;
  s.registry = host.registry ??= { images: {} };
  s.projects = host.projects;
  s.runner = { kind: o.kind, job: o.job, host };
  if (o.cluster) s.kube = host.kube;
  else delete s.kube;
  const home = o.user === 'root' ? '/root' : '/home/runner';
  if (o.user === 'runner') {
    s.users.push({ name: 'runner', uid: 1001, gid: 1001, home, shell: '/bin/bash' });
    s.groups.push({ name: 'runner', gid: 1001, members: [] });
    s.groups.find((g) => g.name === 'docker')?.members.push('runner');
    s.groups.find((g) => g.name === 'sudo')?.members.push('runner');
  }
  s.user = o.user;
  const root = new Vfs(s.fs, { name: 'root', groups: ['root'] }, () => s.clock);
  for (const dir of [home, o.workspace]) {
    if (!root.exists(dir)) root.mkdir(dir, { parents: true });
  }
  if (o.user === 'runner') {
    // Everything under the runner's home belongs to it.
    let p = o.workspace;
    while (p.startsWith(home)) {
      root.chown(p, 'runner', 'runner');
      p = p.replace(/\/[^/]+$/, '');
    }
    root.chown(home, 'runner', 'runner');
  }
  s.cwd = o.workspace;
  s.vars = {
    ...s.vars,
    HOME: home,
    USER: o.user,
    LOGNAME: o.user,
    PWD: o.workspace,
    HOSTNAME: o.hostname,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    CI: 'true',
    ...o.env,
  };
  s.exported = [...new Set([...s.exported, 'CI', 'HOSTNAME', ...Object.keys(o.env)])];
  const shell = factory(s);
  const vfs = new Vfs(s.fs, { name: o.user, groups: o.user === 'root' ? ['root'] : ['runner', 'docker'] }, () => s.clock);
  return { state: s, shell, workspace: o.workspace, vfs };
}

/** Replace secret values in log text with *** (longest first). */
export function mask(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].filter((x) => x.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(s).join('***');
  return out;
}

export interface ScriptResult {
  code: number;
  log: string[];
}

/**
 * Run a script the way `bash -e` would: line by line (with `\` continuations), stopping at the
 * first failing command. `echo` prefixes each command with `$ ` (GitLab's job log style).
 */
export function runScript(r: Runner, script: string, env: Record<string, string>, opts: { cwd?: string; echo?: boolean; secrets: string[] }): ScriptResult {
  const s = r.state;
  const saved = { vars: { ...s.vars }, exported: [...s.exported], cwd: s.cwd };
  Object.assign(s.vars, env);
  s.exported = [...new Set([...s.exported, ...Object.keys(env)])];
  if (opts.cwd) {
    const dir = opts.cwd.startsWith('/') ? opts.cwd : joinPath(r.workspace, opts.cwd);
    if (!r.vfs.exists(dir)) {
      s.vars = saved.vars;
      s.exported = saved.exported;
      return { code: 1, log: [`Error: An error occurred trying to start process '/usr/bin/bash' with working directory '${dir}'. No such file or directory`] };
    }
    s.cwd = dir;
    s.vars.PWD = dir;
  }
  const lines: string[] = [];
  let pending = '';
  for (const raw of script.split('\n')) {
    if (/\\\s*$/.test(raw)) {
      pending += raw.replace(/\\\s*$/, ' ');
      continue;
    }
    lines.push(pending + raw);
    pending = '';
  }
  if (pending) lines.push(pending);
  const log: string[] = [];
  let code = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (opts.echo) log.push(`$ ${t}`);
    const res = r.shell.run(t);
    const text = res.output.map((o) => o.text).join('');
    if (text) log.push(...mask(text, opts.secrets).replace(/\n$/, '').split('\n'));
    if (res.exitCode !== 0) {
      code = res.exitCode;
      break;
    }
  }
  // Step-level env doesn't leak into later steps (the cwd does persist only via `working-directory`).
  const keep = { ...s.vars };
  s.vars = saved.vars;
  for (const k of ['OLDPWD']) if (keep[k] !== undefined) s.vars[k] = keep[k];
  s.exported = saved.exported;
  s.cwd = saved.cwd;
  s.vars.PWD = saved.cwd;
  return { code, log };
}

/** Every file below `dir` (relative path → content). */
export function collectFiles(vfs: Vfs, path: string): Record<string, string> | null {
  if (!vfs.exists(path)) return null;
  const out: Record<string, string> = {};
  if (!vfs.isDir(path)) {
    out[path.split('/').pop()!] = vfs.readFile(path);
    return out;
  }
  const walk = (abs: string, rel: string) => {
    for (const n of vfs.readdir(abs)) {
      const a = joinPath(abs, n);
      const relPath = rel ? `${rel}/${n}` : n;
      if (vfs.isDir(a)) walk(a, relPath);
      else out[relPath] = vfs.readFile(a);
    }
  };
  walk(path, '');
  return out;
}

/** Write files below `dir`, creating directories. */
export function writeFiles(vfs: Vfs, dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = joinPath(dir, rel);
    const parent = abs.replace(/\/[^/]+$/, '') || '/';
    if (!vfs.exists(parent)) vfs.mkdir(parent, { parents: true });
    vfs.writeFile(abs, content);
  }
}
