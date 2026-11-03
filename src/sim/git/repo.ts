/** Repository plumbing: finding repos, refs and revisions, the working tree, ignore rules, status. */
import type { CommandContext } from '../shell/types';
import type { SimState } from '../state';
import { dirname, joinPath, normalize, resolvePath } from '../vfs/path';
import type { DirNode } from '../vfs/types';
import { Vfs } from '../vfs/vfs';
import { blobSha, emptyStore, flatten, modeOf, shortSha, subject } from './objects';
import type { Commit, FileMode, FlatTree, GitState, Repo } from './types';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code = 128,
  ) {
    super(message);
  }
}

export function gitState(state: SimState): GitState {
  return (state.git ??= { repos: {}, remotes: {} });
}

export function newRepo(root: string, branch: string, bare = false): Repo {
  return {
    root,
    bare,
    objects: emptyStore(),
    heads: {},
    tags: {},
    remoteRefs: {},
    head: { branch },
    index: {},
    conflicts: {},
    remotes: {},
    branches: {},
    config: {},
    reflog: [],
    stash: [],
  };
}

/** The repository containing `cwd` (walking up), if its .git directory still exists. */
export function findRepo(state: SimState, vfs: Vfs, cwd: string): Repo | null {
  const gs = state.git;
  if (!gs) return null;
  let dir = cwd;
  for (;;) {
    const repo = gs.repos[dir];
    if (repo) {
      if (vfs.exists(joinPath(dir, '.git'))) return repo;
      delete gs.repos[dir]; // someone ran rm -rf .git
    }
    if (dir === '/') return null;
    dir = dirname(dir);
  }
}

export function notARepo(): GitError {
  return new GitError('fatal: not a git repository (or any of the parent directories): .git');
}

// ------------------------------------------------------------------ config

/** Parse git's INI-style config into "section.key" (or "section.sub.key") → value. */
export function parseConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[([\w.-]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (sec) {
      section = sec[1].toLowerCase() + (sec[2] !== undefined ? `.${sec[2]}` : '');
      continue;
    }
    const kv = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && section) out[`${section}.${kv[1].toLowerCase()}`] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

export function formatConfig(values: Record<string, string>): string {
  const sections = new Map<string, [string, string][]>();
  for (const [k, v] of Object.entries(values)) {
    const parts = k.split('.');
    const key = parts.pop()!;
    const sec = parts.length > 1 ? `${parts[0]} "${parts.slice(1).join('.')}"` : parts[0];
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec)!.push([key, v]);
  }
  let out = '';
  for (const [sec, kvs] of sections) out += `[${sec}]\n` + kvs.map(([k, v]) => `\t${k} = ${v}\n`).join('');
  return out;
}

export function globalConfigPath(state: SimState): string {
  return joinPath(state.vars.HOME ?? '/root', '.gitconfig');
}

export function globalConfig(ctx: CommandContext): Record<string, string> {
  try {
    return parseConfig(ctx.vfs.readFile(globalConfigPath(ctx.state)));
  } catch {
    return {};
  }
}

/** `git -c key=value` overrides for the command being run. */
let overrides: Record<string, string> = {};
export function setConfigOverrides(o: Record<string, string>): void {
  overrides = o;
}

/** Effective config: -c overrides, then repo-local, then global values. */
export function configValue(ctx: CommandContext, repo: Repo | null, key: string): string | undefined {
  const k = key.toLowerCase();
  return overrides[k] ?? repo?.config[k] ?? globalConfig(ctx)[k];
}

export function identity(ctx: CommandContext, repo: Repo): { name: string; email: string } {
  const name = configValue(ctx, repo, 'user.name');
  const email = configValue(ctx, repo, 'user.email');
  if (!name || !email) {
    throw new GitError(
      'Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n' +
        '  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\n' +
        "to set your account's default identity.\nOmit --global to set the identity only in this repository.\n\n" +
        `fatal: unable to auto-detect email address (got '${ctx.state.user}@${ctx.state.hostname}.(none)')`,
    );
  }
  return { name, email };
}

// ------------------------------------------------------------------ refs & revisions

export function currentBranch(repo: Repo): string | null {
  return 'branch' in repo.head ? repo.head.branch : null;
}

/** The commit HEAD points at (undefined on an unborn branch). */
export function headSha(repo: Repo): string | undefined {
  return 'branch' in repo.head ? repo.heads[repo.head.branch] : repo.head.detached;
}

export function headTree(repo: Repo): FlatTree {
  const h = headSha(repo);
  return h ? commitTree(repo, h) : {};
}

export function commitTree(repo: Repo, sha: string): FlatTree {
  const c = repo.objects.commits[sha];
  return c ? flatten(repo.objects, c.tree) : {};
}

/** Peel annotated tags to the commit they point at. */
function peel(repo: Repo, sha: string): string {
  let s = sha;
  while (repo.objects.tags[s]) s = repo.objects.tags[s].object;
  return s;
}

function lookupName(repo: Repo, name: string): string | undefined {
  if (name === 'HEAD' || name === '@') return headSha(repo);
  const n = name.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '').replace(/^refs\/remotes\//, '').replace(/^remotes\//, '');
  if (repo.heads[n]) return repo.heads[n];
  if (repo.tags[n]) return peel(repo, repo.tags[n]);
  if (repo.remoteRefs[n]) return repo.remoteRefs[n];
  if (repo.remotes[n] && repo.remoteRefs[`${n}/HEAD`]) return repo.remoteRefs[`${n}/HEAD`];
  if (/^[0-9a-f]{4,40}$/.test(name)) {
    const all = [...Object.keys(repo.objects.commits), ...Object.keys(repo.objects.tags)];
    const hits = all.filter((s) => s.startsWith(name));
    if (hits.length === 1) return peel(repo, hits[0]);
    if (hits.length > 1) throw new GitError(`error: short object ID ${name} is ambiguous\nfatal: ambiguous argument '${name}': unknown revision or path not in the working tree.`);
  }
  return undefined;
}

/** Resolve `main`, `HEAD~2`, `abc1234^2`, `HEAD@{1}`, `origin/main`, `v1.0`... to a commit id (or null). */
export function resolveRev(repo: Repo, rev: string): string | null {
  const m = /^(.*?)((?:[~^]\d*)*)$/.exec(rev)!;
  let base = m[1];
  const suffix = m[2];
  let sha: string | undefined;
  const reflog = /^(.*)@\{(\d+)\}$/.exec(base);
  if (reflog) {
    if (reflog[1] && reflog[1] !== 'HEAD') return null;
    const entry = repo.reflog[repo.reflog.length - 1 - Number(reflog[2])];
    sha = entry?.sha;
  } else {
    if (base === '') base = 'HEAD';
    sha = lookupName(repo, base);
  }
  if (!sha) return null;
  const re = /([~^])(\d*)/g;
  let mm;
  while ((mm = re.exec(suffix))) {
    const n = mm[2] === '' ? 1 : Number(mm[2]);
    const c: Commit | undefined = repo.objects.commits[sha];
    if (!c) return null;
    if (mm[1] === '^') {
      if (n === 0) continue;
      sha = c.parents[n - 1];
    } else {
      for (let k = 0; k < n && sha; k++) sha = repo.objects.commits[sha]?.parents[0];
    }
    if (!sha) return null;
  }
  return sha;
}

export function mustResolve(repo: Repo, rev: string): string {
  const sha = resolveRev(repo, rev);
  if (!sha) throw new GitError(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
  return sha;
}

export function ancestors(repo: Repo, sha: string): Set<string> {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    stack.push(...(repo.objects.commits[s]?.parents ?? []));
  }
  return seen;
}

/** Is `a` an ancestor of (or equal to) `b`? */
export function isAncestor(repo: Repo, a: string, b: string): boolean {
  return ancestors(repo, b).has(a);
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const A = ancestors(repo, a);
  const common = [...ancestors(repo, b)].filter((s) => A.has(s));
  const best = common.filter((c) => !common.some((o) => o !== c && isAncestor(repo, c, o)));
  best.sort((x, y) => repo.objects.commits[y].committer.time - repo.objects.commits[x].committer.time);
  return best[0] ?? null;
}

/** Commits reachable from `include` but not from `exclude`, newest first (like `git rev-list`). */
export function revList(repo: Repo, include: string[], exclude: string[] = []): string[] {
  const excluded = new Set<string>();
  for (const e of exclude) for (const s of ancestors(repo, e)) excluded.add(s);
  const seen = new Set<string>();
  const out: string[] = [];
  let frontier = include.filter((s) => repo.objects.commits[s]);
  while (frontier.length) {
    // Pick the newest commit in the frontier (date order, ties by insertion).
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (repo.objects.commits[frontier[i]].committer.time > repo.objects.commits[frontier[bi]].committer.time) bi = i;
    }
    const s = frontier.splice(bi, 1)[0];
    if (seen.has(s)) continue;
    seen.add(s);
    if (!excluded.has(s)) out.push(s);
    for (const p of repo.objects.commits[s].parents) if (!seen.has(p) && repo.objects.commits[p]) frontier.push(p);
  }
  return out;
}

/** Point the current branch (or detached HEAD) at a commit and record it in the reflog. */
export function moveHead(repo: Repo, sha: string, reflogMessage: string): void {
  if ('branch' in repo.head) repo.heads[repo.head.branch] = sha;
  else repo.head = { detached: sha };
  repo.reflog.push({ sha, message: reflogMessage });
}

export function describeCommit(repo: Repo, sha: string): string {
  return `${shortSha(sha)} ${subject(repo.objects.commits[sha]?.message ?? '')}`;
}

// ------------------------------------------------------------------ paths

/** Path inside the repo for a user-supplied path ('' = the whole tree). Throws outside the repo. */
export function repoPath(repo: Repo, cwd: string, p: string): string {
  const abs = resolvePath(cwd, p);
  if (abs === repo.root) return '';
  if (!abs.startsWith(repo.root === '/' ? '/' : repo.root + '/')) {
    throw new GitError(`fatal: ${p}: '${p}' is outside repository at '${repo.root}'`);
  }
  return abs.slice(repo.root === '/' ? 1 : repo.root.length + 1);
}

export function inSpec(path: string, spec: string): boolean {
  if (spec === '') return true;
  if (/[*?]/.test(spec)) return globRe(spec, true).test(path) || globRe(spec, true).test(path.split('/').pop()!);
  return path === spec || path.startsWith(spec + '/');
}

/** Display a repo path relative to the user's current directory, like git does. */
export function displayPath(repo: Repo, cwd: string, path: string): string {
  if (path.endsWith('/')) return (displayPath(repo, cwd, path.slice(0, -1)) || '.') + '/';
  const abs = normalize(joinPath(repo.root, path));
  if (cwd === repo.root) return path;
  const from = cwd.split('/').filter(Boolean);
  const to = abs.split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
}

// ------------------------------------------------------------------ working tree

export interface WorkFile {
  content: string;
  mode: FileMode;
}

/** All files in the working tree (outside .git). */
export function readWorktree(vfs: Vfs, repo: Repo): Record<string, WorkFile> {
  const out: Record<string, WorkFile> = {};
  const walk = (abs: string, rel: string) => {
    let node;
    try {
      node = vfs.lookup(abs);
    } catch {
      return;
    }
    if (node.type === 'file') {
      out[rel] = { content: node.content, mode: modeOf((node.mode & 0o100) !== 0) };
      return;
    }
    for (const name of Object.keys((node as DirNode).children).sort()) {
      if (rel === '' && name === '.git') continue;
      walk(joinPath(abs, name), rel ? `${rel}/${name}` : name);
    }
  };
  walk(repo.root, '');
  return out;
}

export function writeWorkFile(vfs: Vfs, repo: Repo, path: string, content: string, mode: FileMode): void {
  const abs = joinPath(repo.root, path);
  const dir = dirname(abs);
  if (!vfs.exists(dir)) vfs.mkdir(dir, { parents: true });
  else if (!vfs.isDir(dir)) {
    vfs.remove(dir);
    vfs.mkdir(dir, { parents: true });
  }
  if (vfs.exists(abs) && vfs.isDir(abs)) vfs.remove(abs, { recursive: true });
  vfs.writeFile(abs, content);
  vfs.chmod(abs, mode === '100755' ? 0o755 : 0o644);
}

/** Delete a file and any directories it leaves empty (git doesn't track directories). */
export function deleteWorkFile(vfs: Vfs, repo: Repo, path: string): void {
  const abs = joinPath(repo.root, path);
  if (!vfs.exists(abs)) return;
  vfs.remove(abs, { recursive: true });
  let dir = dirname(abs);
  while (dir !== repo.root && dir.startsWith(repo.root)) {
    try {
      if (vfs.readdir(dir).length) break;
      vfs.remove(dir);
    } catch {
      break;
    }
    dir = dirname(dir);
  }
}

// ------------------------------------------------------------------ .gitignore

function globRe(pattern: string, anchored: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i++;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`);
}

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

export function ignoreRules(files: Record<string, WorkFile>): IgnoreRule[] {
  const text = files['.gitignore']?.content ?? '';
  const rules: IgnoreRule[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    rules.push({ re: globRe(line, anchored), negate, dirOnly });
  }
  return rules;
}

/** Is a file (or any directory above it) ignored? */
export function isIgnored(rules: IgnoreRule[], path: string): boolean {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    const isDir = i < parts.length;
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(sub)) ignored = !r.negate;
    }
    if (ignored) return true;
  }
  return false;
}

// ------------------------------------------------------------------ status

export interface Status {
  staged: { path: string; kind: 'new file' | 'modified' | 'deleted' | 'renamed'; from?: string }[];
  unstaged: { path: string; kind: 'modified' | 'deleted' }[];
  untracked: string[];
  conflicted: { path: string; kind: string }[];
  worktree: Record<string, WorkFile>;
}

export function computeStatus(vfs: Vfs, repo: Repo, opts: { collapseUntracked?: boolean } = {}): Status {
  const head = headTree(repo);
  const index = repo.index;
  const work = readWorktree(vfs, repo);
  const staged: Status['staged'] = [];
  const conflicted = Object.entries(repo.conflicts).map(([path, c]) => ({
    path,
    kind: c.ours && c.theirs ? (c.base ? 'both modified' : 'both added') : c.ours ? 'deleted by them' : 'deleted by us',
  }));
  const isConflict = (p: string) => p in repo.conflicts;
  for (const p of Object.keys({ ...head, ...index }).sort()) {
    if (isConflict(p)) continue;
    const h = head[p];
    const i = index[p];
    if (!h && i) staged.push({ path: p, kind: 'new file' });
    else if (h && !i) staged.push({ path: p, kind: 'deleted' });
    else if (h && i && (h.sha !== i.sha || h.mode !== i.mode)) staged.push({ path: p, kind: 'modified' });
  }
  // Pair identical deleted + new files as renames.
  for (const d of staged.filter((s) => s.kind === 'deleted')) {
    const n = staged.find((s) => s.kind === 'new file' && index[s.path].sha === head[d.path].sha);
    if (n) {
      n.kind = 'renamed';
      n.from = d.path;
      staged.splice(staged.indexOf(d), 1);
    }
  }
  const unstaged: Status['unstaged'] = [];
  for (const [p, i] of Object.entries(index).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (isConflict(p)) continue;
    const w = work[p];
    if (!w) unstaged.push({ path: p, kind: 'deleted' });
    else if (blobSha(w.content) !== i.sha || w.mode !== i.mode) unstaged.push({ path: p, kind: 'modified' });
  }
  const rules = ignoreRules(work);
  const untrackedFiles = Object.keys(work).filter((p) => !(p in index) && !isConflict(p) && !isIgnored(rules, p));
  let untracked = untrackedFiles;
  if (opts.collapseUntracked !== false) {
    // Show a directory once ("logs/") when nothing inside it is tracked.
    const tracked = Object.keys(index);
    const set = new Set<string>();
    for (const p of untrackedFiles) {
      const parts = p.split('/');
      let shown = p;
      for (let k = 1; k < parts.length; k++) {
        const dir = parts.slice(0, k).join('/');
        if (!tracked.some((t) => t.startsWith(dir + '/')) && !Object.keys(repo.conflicts).some((t) => t.startsWith(dir + '/'))) {
          shown = dir + '/';
          break;
        }
      }
      set.add(shown);
    }
    untracked = [...set].sort();
  }
  return { staged, unstaged, untracked, conflicted, worktree: work };
}

export function isClean(st: Status): boolean {
  return !st.staged.length && !st.unstaged.length && !st.conflicted.length;
}

// ------------------------------------------------------------------ .git directory mirror

/**
 * Keep a readable .git/ in the virtual filesystem (HEAD, refs, config) so `cat .git/HEAD`
 * and `cat .git/refs/heads/main` show what Git really stores. The repo record is the source of truth.
 */
export function syncGitDir(vfs: Vfs, repo: Repo): void {
  const g = repo.bare ? repo.root : joinPath(repo.root, '.git');
  try {
    if (!vfs.exists(g)) vfs.mkdir(g, { parents: true });
    vfs.writeFile(joinPath(g, 'HEAD'), 'branch' in repo.head ? `ref: refs/heads/${repo.head.branch}\n` : `${repo.head.detached}\n`);
    const cfg: Record<string, string> = {
      'core.repositoryformatversion': '0',
      'core.filemode': 'true',
      'core.bare': repo.bare ? 'true' : 'false',
      ...repo.config,
    };
    for (const [name, r] of Object.entries(repo.remotes)) {
      cfg[`remote.${name}.url`] = r.url;
      cfg[`remote.${name}.fetch`] = `+refs/heads/*:refs/remotes/${name}/*`;
    }
    for (const [name, b] of Object.entries(repo.branches)) {
      cfg[`branch.${name}.remote`] = b.remote;
      cfg[`branch.${name}.merge`] = b.merge;
    }
    vfs.writeFile(joinPath(g, 'config'), formatConfig(cfg));
    const refs = joinPath(g, 'refs');
    if (vfs.exists(refs)) vfs.remove(refs, { recursive: true });
    const write = (rel: string, sha: string) => {
      const abs = joinPath(refs, rel);
      vfs.mkdir(dirname(abs), { parents: true });
      vfs.writeFile(abs, sha + '\n');
    };
    vfs.mkdir(joinPath(refs, 'heads'), { parents: true });
    vfs.mkdir(joinPath(refs, 'tags'), { parents: true });
    for (const [b, s] of Object.entries(repo.heads)) write(`heads/${b}`, s);
    for (const [t, s] of Object.entries(repo.tags)) write(`tags/${t}`, s);
    for (const [r, s] of Object.entries(repo.remoteRefs)) if (!r.endsWith('/HEAD')) write(`remotes/${r}`, s);
    if (!vfs.exists(joinPath(g, 'objects'))) vfs.mkdir(joinPath(g, 'objects'));
  } catch {
    /* read-only or full disk: the mirror is cosmetic */
  }
}
