/** git log, show, diff, reflog, tag, clean and the plumbing commands (cat-file, hash-object, rev-parse, ls-files). */
import { unifiedHunks } from '../diff';
import { blobSha, flatten, shortSha, subject, tagBody, commitBody, writeBlob, writeTag } from '../objects';
import { blobText, flatOf, nowSec, sameEntry, statGraph, summaryLine, treeStats } from '../ops';
import {
  computeStatus,
  currentBranch,
  deleteWorkFile,
  displayPath,
  GitError,
  headSha,
  headTree,
  identity,
  ignoreRules,
  inSpec,
  isIgnored,
  mergeBase,
  mustResolve,
  readWorktree,
  repoPath,
  resolveRev,
  revList,
} from '../repo';
import type { FlatTree, Repo } from '../types';
import { gitDate } from './basic';
import { GitCtx, parseArgs, repoOf } from './common';
import { resolvePath } from '../../vfs/path';

// ------------------------------------------------------------------ decorations

export function decorations(repo: Repo, sha: string): string[] {
  const out: string[] = [];
  const cur = currentBranch(repo);
  const headIs = headSha(repo) === sha;
  if (headIs) out.push(cur ? `HEAD -> ${cur}` : 'HEAD');
  for (const [t, s] of Object.entries(repo.tags).sort()) {
    const peeled = repo.objects.tags[s]?.object ?? s;
    if (peeled === sha) out.push(`tag: ${t}`);
  }
  for (const [b, s] of Object.entries(repo.heads).sort()) if (s === sha && !(headIs && b === cur)) out.push(b);
  for (const [r, s] of Object.entries(repo.remoteRefs).sort()) if (s === sha) out.push(r);
  return out;
}

const deco = (repo: Repo, sha: string) => {
  const d = decorations(repo, sha);
  return d.length ? ` (${d.join(', ')})` : '';
};

// ------------------------------------------------------------------ diffs

/** `diff --git` output between two flat trees (or a tree and the working tree contents). */
export function treeDiff(
  repo: Repo,
  from: FlatTree,
  to: Record<string, { sha: string; mode: string; content?: string }>,
  filter: (p: string) => boolean = () => true,
): string {
  let out = '';
  for (const p of Object.keys({ ...from, ...to }).sort()) {
    if (!filter(p)) continue;
    const a = from[p];
    const b = to[p];
    if (a && b && a.sha === b.sha && a.mode === b.mode) continue;
    const aText = blobText(repo, a?.sha);
    const bText = b?.content ?? blobText(repo, b?.sha);
    out += `diff --git a/${p} b/${p}\n`;
    if (!a) out += `new file mode ${b!.mode}\nindex 0000000..${shortSha(b!.sha)}\n--- /dev/null\n+++ b/${p}\n`;
    else if (!b) out += `deleted file mode ${a.mode}\nindex ${shortSha(a.sha)}..0000000\n--- a/${p}\n+++ /dev/null\n`;
    else {
      if (a.mode !== b.mode) out += `old mode ${a.mode}\nnew mode ${b.mode}\n`;
      if (a.sha === b.sha) continue;
      out += `index ${shortSha(a.sha)}..${shortSha(b.sha)}${a.mode === b.mode ? ` ${a.mode}` : ''}\n--- a/${p}\n+++ b/${p}\n`;
    }
    out += unifiedHunks(aText, bText);
  }
  return out;
}

function worktreeAsTree(repo: Repo, g: GitCtx, tracked: string[]): Record<string, { sha: string; mode: string; content: string }> {
  const work = readWorktree(g.ctx.vfs, repo);
  const out: Record<string, { sha: string; mode: string; content: string }> = {};
  for (const p of tracked) if (work[p]) out[p] = { sha: blobSha(work[p].content), mode: work[p].mode, content: work[p].content };
  return out;
}

function statText(repo: Repo, from: FlatTree, to: FlatTree): string {
  const stats = treeStats(repo, from, to);
  return stats.length ? statGraph(stats) + summaryLine(stats) : '';
}

function nameStatus(from: FlatTree, to: FlatTree, withStatus: boolean): string {
  let out = '';
  for (const p of Object.keys({ ...from, ...to }).sort()) {
    if (sameEntry(from[p], to[p])) continue;
    out += withStatus ? `${!from[p] ? 'A' : !to[p] ? 'D' : 'M'}\t${p}\n` : `${p}\n`;
  }
  return out;
}

export function gitDiff(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['staged', 'cached', 'stat', 'name-only', 'name-status', 'quiet', 'exit-code', 'no-color', 'color'] }, 'usage: git diff [<options>] [<commit>] [--] [<path>...]');
  const repo = repoOf(g);
  const cwd = g.ctx.state.cwd;
  const revs: string[] = [];
  const pathArgs = [...p.paths];
  for (const a of p.args) {
    if (!p.dashdash && (resolveRev(repo, a) || /\.\.\.?/.test(a)) && !pathArgs.length) revs.push(a);
    else pathArgs.push(a);
  }
  const specs = pathArgs.map((a) => repoPath(repo, cwd, a));
  const filter = (f: string) => !specs.length || specs.some((s) => inSpec(f, s));
  let from: FlatTree;
  let to: Record<string, { sha: string; mode: string; content?: string }>;
  const staged = p.flags.staged || p.flags.cached;
  if (revs.length === 1 && /\.\.\.?/.test(revs[0])) {
    const [a, b] = revs[0].split(/\.\.\.?/);
    const aSha = mustResolve(repo, a || 'HEAD');
    const bSha = mustResolve(repo, b || 'HEAD');
    const fromSha = revs[0].includes('...') ? mergeBase(repo, aSha, bSha) ?? aSha : aSha;
    from = flatOf(repo, fromSha);
    to = flatOf(repo, bSha);
  } else if (revs.length === 2) {
    from = flatOf(repo, mustResolve(repo, revs[0]));
    to = flatOf(repo, mustResolve(repo, revs[1]));
  } else if (revs.length === 1) {
    from = flatOf(repo, mustResolve(repo, revs[0]));
    to = staged ? repo.index : worktreeAsTree(repo, g, Object.keys({ ...repo.index, ...from }));
  } else if (staged) {
    from = headTree(repo);
    to = repo.index;
  } else {
    from = { ...repo.index };
    // Conflicted files: compare against our side, like a simplified `diff --cc`.
    for (const [f, c] of Object.entries(repo.conflicts)) if (c.ours) from[f] = c.ours;
    to = worktreeAsTree(repo, g, Object.keys(from));
    for (const f of Object.keys(from)) if (!to[f] && !(f in repo.index) && !(f in repo.conflicts)) delete from[f];
  }
  const changed = Object.keys({ ...from, ...to }).some((f) => filter(f) && !sameEntry(from[f], to[f]));
  if (p.flags.quiet) return changed ? 1 : 0;
  const toFlat: FlatTree = Object.fromEntries(Object.entries(to).map(([k, v]) => [k, { sha: v.content !== undefined ? writeBlob(repo.objects, v.content) : v.sha, mode: v.mode as '100644' }]));
  const filtered = (t: FlatTree) => Object.fromEntries(Object.entries(t).filter(([k]) => filter(k)));
  if (p.flags.stat) g.out(statText(repo, filtered(from), filtered(toFlat)));
  else if (p.flags['name-only'] || p.flags['name-status']) g.out(nameStatus(filtered(from), filtered(toFlat), !!p.flags['name-status']));
  else g.out(treeDiff(repo, from, to, filter));
  return p.flags['exit-code'] && changed ? 1 : 0;
}

// ------------------------------------------------------------------ log / show

interface LogFormat {
  oneline: boolean;
  format?: string;
  stat: boolean;
  patch: boolean;
  nameOnly: boolean;
}

function formatPlaceholders(repo: Repo, sha: string, fmt: string): string {
  const c = repo.objects.commits[sha];
  const d = decorations(repo, sha);
  return fmt.replace(/%([Hhsbnd]|an|ae|ad|ar|cn|ce|P|p|T|t)/g, (_m, k: string) => {
    switch (k) {
      case 'H':
        return sha;
      case 'h':
        return shortSha(sha);
      case 's':
        return subject(c.message);
      case 'b':
        return c.message.split('\n').slice(2).join('\n');
      case 'n':
        return '\n';
      case 'd':
        return d.length ? ` (${d.join(', ')})` : '';
      case 'an':
        return c.author.name;
      case 'ae':
        return c.author.email;
      case 'ad':
        return gitDate(new Date(c.author.time * 1000));
      case 'ar':
        return 'recently';
      case 'cn':
        return c.committer.name;
      case 'ce':
        return c.committer.email;
      case 'P':
        return c.parents.join(' ');
      case 'p':
        return c.parents.map(shortSha).join(' ');
      case 'T':
        return c.tree;
      case 't':
        return shortSha(c.tree);
    }
    return '';
  });
}

function commitBlock(repo: Repo, sha: string, f: LogFormat): string {
  const c = repo.objects.commits[sha];
  if (f.format) return formatPlaceholders(repo, sha, f.format) + '\n';
  if (f.oneline) return `${shortSha(sha)}${deco(repo, sha)} ${subject(c.message)}\n`;
  let out = `commit ${sha}${deco(repo, sha)}\n`;
  if (c.parents.length > 1) out += `Merge: ${c.parents.map(shortSha).join(' ')}\n`;
  out += `Author: ${c.author.name} <${c.author.email}>\nDate:   ${gitDate(new Date(c.author.time * 1000))}\n\n`;
  out += c.message.replace(/\n$/, '').split('\n').map((l) => (l ? `    ${l}` : '')).join('\n') + '\n';
  return out;
}

function commitExtras(repo: Repo, sha: string, f: LogFormat): string {
  const c = repo.objects.commits[sha];
  if (c.parents.length > 1) return '';
  const from = c.parents[0] ? flatOf(repo, c.parents[0]) : {};
  const to = flatOf(repo, sha);
  let out = '';
  if (f.stat) out += '\n' + statText(repo, from, to);
  if (f.nameOnly) out += nameStatus(from, to, false);
  if (f.patch) out += '\n' + treeDiff(repo, from, to);
  return out;
}

/** Simplified `--graph`: one column per line of development, merges fork with |\ and rejoin with |/. */
function graphLog(repo: Repo, shas: string[], render: (sha: string) => string[]): string {
  let cols: string[] = [];
  let out = '';
  const bars = (n: number) => Array(n).fill('|').join(' ');
  for (const sha of shas) {
    let idx = cols.indexOf(sha);
    if (idx < 0) {
      cols.push(sha);
      idx = cols.length - 1;
    }
    const parents = repo.objects.commits[sha].parents;
    const isMerge = parents.length > 1;
    const lines = render(sha);
    const prefix = cols.map((_, i) => (i === idx ? '*' : '|')).join(' ');
    out += `${prefix}${isMerge ? '   ' : ' '}${lines[0]}\n`;
    const contPrefix = cols.map(() => '|').join(' ');
    for (const l of lines.slice(1)) out += `${isMerge ? contPrefix.slice(0, idx * 2 + 1) + '\\ ' + contPrefix.slice(idx * 2 + 2) : contPrefix}${l ? ' ' + l : ''}`.trimEnd() + '\n';
    // Other columns waiting for this commit merge into it.
    const dups = cols.map((c, i) => (c === sha && i !== idx ? i : -1)).filter((i) => i >= 0);
    cols[idx] = parents[0] ?? '';
    for (const p of parents.slice(1).reverse()) cols.splice(idx + 1, 0, p);
    if (isMerge && lines.length === 1) out += `${bars(idx + 1)}\\\n`.replace(/^\|(.*)\\$/, (m) => m);
    for (const d of dups.reverse()) {
      const at = d + (d > idx ? parents.length - 1 : 0);
      cols.splice(at, 1);
      out += `${bars(at)}/\n`;
    }
    // Collapse columns that now wait for the same commit.
    for (let i = cols.length - 1; i > 0; i--) {
      const first = cols.indexOf(cols[i]);
      if (cols[i] && first < i) {
        cols.splice(i, 1);
        out += `${bars(i)}/\n`;
      }
    }
    cols = cols.filter((c) => c !== '');
  }
  return out;
}

/** --topo-order as git does it: children before parents, a merge's side branch shown first. */
function topoOrder(repo: Repo, shas: string[]): string[] {
  const set = new Set(shas);
  const indeg = new Map<string, number>(shas.map((s) => [s, 0]));
  for (const s of shas) for (const par of repo.objects.commits[s].parents) if (set.has(par)) indeg.set(par, indeg.get(par)! + 1);
  const stack = shas.filter((s) => indeg.get(s) === 0).reverse();
  const out: string[] = [];
  while (stack.length) {
    const s = stack.pop()!;
    out.push(s);
    for (const par of repo.objects.commits[s].parents) {
      if (!set.has(par)) continue;
      indeg.set(par, indeg.get(par)! - 1);
      if (indeg.get(par) === 0) stack.push(par);
    }
  }
  return out;
}

export function gitLog(g: GitCtx): number {
  const p = parseArgs(
    g.args,
    {
      bool: ['oneline', 'graph', 'all', 'decorate', 'stat', 'p', 'patch', 'name-only', 'reverse', 'no-merges', 'merges', 'first-parent', 'abbrev-commit'],
      value: ['n', 'max-count', 'format', 'pretty', 'author', 'grep'],
      alias: { 'max-count': 'n', p: 'patch' },
    },
    'usage: git log [<options>] [<revision-range>] [[--] <path>...]',
  );
  const repo = repoOf(g);
  const cwd = g.ctx.state.cwd;
  const include: string[] = [];
  const exclude: string[] = [];
  const pathArgs = [...p.paths];
  for (const a of p.args) {
    const range = /^(.*?)\.\.(.*)$/.exec(a);
    if (range && !p.dashdash) {
      exclude.push(mustResolve(repo, range[1] || 'HEAD'));
      include.push(mustResolve(repo, range[2] || 'HEAD'));
    } else if (a.startsWith('^')) exclude.push(mustResolve(repo, a.slice(1)));
    else if (!pathArgs.length && resolveRev(repo, a)) include.push(resolveRev(repo, a)!);
    else if (!pathArgs.length && !g.ctx.vfs.exists(resolvePath(cwd, a)) && !Object.keys(repo.index).some((f) => inSpec(f, repoPath(repo, cwd, a)))) {
      throw new GitError(`fatal: ambiguous argument '${a}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
    } else pathArgs.push(a);
  }
  if (p.flags.all) include.push(...Object.values(repo.heads), ...Object.values(repo.remoteRefs), ...Object.values(repo.tags).map((t) => repo.objects.tags[t]?.object ?? t));
  if (!include.length) {
    const h = headSha(repo);
    if (!h) {
      const b = currentBranch(repo) ?? 'HEAD';
      throw new GitError(`fatal: your current branch '${b}' does not have any commits yet`);
    }
    include.push(h);
  }
  let shas = revList(repo, include, exclude);
  if (p.flags['first-parent']) {
    const fp = new Set<string>();
    let s: string | undefined = include[0];
    while (s) {
      fp.add(s);
      s = repo.objects.commits[s]?.parents[0];
    }
    shas = shas.filter((s) => fp.has(s));
  }
  if (p.flags['no-merges']) shas = shas.filter((s) => repo.objects.commits[s].parents.length < 2);
  if (p.flags.merges) shas = shas.filter((s) => repo.objects.commits[s].parents.length > 1);
  if (p.flags.author) shas = shas.filter((s) => new RegExp(p.flags.author as string, 'i').test(`${repo.objects.commits[s].author.name} <${repo.objects.commits[s].author.email}>`));
  if (p.flags.grep) shas = shas.filter((s) => new RegExp(p.flags.grep as string, 'i').test(repo.objects.commits[s].message));
  if (pathArgs.length) {
    const specs = pathArgs.map((a) => repoPath(repo, cwd, a));
    shas = shas.filter((s) => {
      const c = repo.objects.commits[s];
      const from = c.parents[0] ? flatOf(repo, c.parents[0]) : {};
      const to = flatOf(repo, s);
      return Object.keys({ ...from, ...to }).some((f) => specs.some((sp) => inSpec(f, sp)) && !sameEntry(from[f], to[f]));
    });
  }
  if (p.flags.n !== undefined) shas = shas.slice(0, Number(p.flags.n));
  if (p.flags.reverse) shas.reverse();
  let format: string | undefined;
  const pretty = (p.flags.format ?? p.flags.pretty) as string | undefined;
  let oneline = !!p.flags.oneline;
  if (pretty) {
    if (pretty === 'oneline') oneline = true;
    else if (pretty.startsWith('format:') || pretty.startsWith('tformat:')) format = pretty.replace(/^t?format:/, '');
    else if (p.flags.format) format = pretty;
  }
  const f: LogFormat = { oneline, format, stat: !!p.flags.stat, patch: !!p.flags.patch, nameOnly: !!p.flags['name-only'] };
  if (p.flags.graph) {
    shas = topoOrder(repo, shas);
    g.out(graphLog(repo, shas, (s) => (commitBlock(repo, s, f) + commitExtras(repo, s, f)).replace(/\n$/, '').split('\n').concat(f.oneline || f.format ? [] : [''])));
    return 0;
  }
  const blocks = shas.map((s) => commitBlock(repo, s, f) + commitExtras(repo, s, f));
  g.out(f.oneline || f.format ? blocks.join('') : blocks.join('\n'));
  return 0;
}

export function gitShow(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['stat', 'name-only', 'oneline', 'no-patch', 's', 'name-status'], value: ['format', 'pretty'] }, 'usage: git show [<options>] <object>...');
  const repo = repoOf(g);
  const targets = p.args.length ? p.args : ['HEAD'];
  for (const t of targets) {
    const colon = /^([^:]*):(.+)$/.exec(t);
    if (colon) {
      const sha = mustResolve(repo, colon[1] || 'HEAD');
      const path = colon[2].replace(/^\.\//, '');
      const e = flatOf(repo, sha)[path];
      if (!e) {
        const dir = Object.keys(flatOf(repo, sha)).filter((f) => f.startsWith(path.replace(/\/$/, '') + '/'));
        if (dir.length) {
          g.out(`tree ${t}\n\n${[...new Set(dir.map((f) => f.slice(path.replace(/\/$/, '').length + 1).split('/')[0] + (f.slice(path.length + 1).includes('/') ? '/' : '')))].join('\n')}\n`);
          continue;
        }
        throw new GitError(`fatal: path '${path}' does not exist in '${colon[1] || 'HEAD'}'`);
      }
      g.out(blobText(repo, e.sha));
      continue;
    }
    if (repo.tags[t] && repo.objects.tags[repo.tags[t]]) {
      const tag = repo.objects.tags[repo.tags[t]];
      g.out(`tag ${tag.tag}\nTagger: ${tag.tagger.name} <${tag.tagger.email}>\nDate:   ${gitDate(new Date(tag.tagger.time * 1000))}\n\n${tag.message}\n`);
    }
    const sha = mustResolve(repo, t);
    const f: LogFormat = {
      oneline: !!p.flags.oneline || p.flags.pretty === 'oneline',
      format: typeof p.flags.format === 'string' ? p.flags.format : undefined,
      stat: !!p.flags.stat,
      patch: !p.flags.stat && !p.flags['name-only'] && !p.flags['no-patch'] && !p.flags.s && !p.flags['name-status'],
      nameOnly: !!p.flags['name-only'],
    };
    g.out(commitBlock(repo, sha, f) + commitExtras(repo, sha, f));
  }
  return 0;
}

export function gitReflog(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['all'], value: ['n'] }, 'usage: git reflog [show] [<log-options>] [<ref>]');
  const repo = repoOf(g);
  const args = p.args.filter((a) => a !== 'show');
  if (args.length && args[0] !== 'HEAD') throw new GitError('devquest: only the HEAD reflog is simulated (git reflog)', 1);
  let entries = [...repo.reflog].reverse();
  if (p.flags.n !== undefined) entries = entries.slice(0, Number(p.flags.n));
  g.out(entries.map((e, i) => `${shortSha(e.sha)}${deco(repo, e.sha)} HEAD@{${i}}: ${e.message}\n`).join(''));
  return 0;
}

// ------------------------------------------------------------------ tag

export function gitTag(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['a', 'annotate', 'd', 'delete', 'l', 'list', 'f', 'force'], value: ['m', 'message', 'n'], alias: { annotate: 'a', delete: 'd', list: 'l', message: 'm', force: 'f' } }, 'usage: git tag [-a | -s | -u <key-id>] [-f] [-m <msg> | -F <file>] <tagname> [<head>]');
  const repo = repoOf(g);
  if (p.flags.d) {
    let code = 0;
    for (const t of p.args) {
      if (!repo.tags[t]) {
        g.err(`error: tag '${t}' not found.\n`);
        code = 1;
        continue;
      }
      g.out(`Deleted tag '${t}' (was ${shortSha(repo.tags[t])})\n`);
      delete repo.tags[t];
    }
    return code;
  }
  if (!p.args.length || p.flags.l) {
    const pat = p.args[0];
    const re = pat ? new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
    const names = Object.keys(repo.tags).filter((t) => !re || re.test(t)).sort();
    g.out(names.map((t) => t + '\n').join(''));
    return 0;
  }
  const [name, rev] = p.args;
  if (!/^[\w./-]+$/.test(name) || name.endsWith('/') || name.includes('..')) throw new GitError(`fatal: '${name}' is not a valid tag name.`);
  if (repo.tags[name] && !p.flags.f) throw new GitError(`fatal: tag '${name}' already exists`);
  const target = mustResolve(repo, rev ?? 'HEAD');
  const annotated = p.flags.a || p.flags.m !== undefined;
  if (annotated) {
    if (p.flags.m === undefined) throw new GitError('devquest: the tag message editor is not simulated — use git tag -a NAME -m "message"', 1);
    const who = identity(g.ctx, repo);
    repo.tags[name] = writeTag(repo.objects, { object: target, tag: name, tagger: { ...who, time: nowSec(g.ctx) }, message: p.flags.m as string });
  } else repo.tags[name] = target;
  return 0;
}

// ------------------------------------------------------------------ clean

export function gitClean(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['n', 'dry-run', 'f', 'force', 'd', 'x', 'X', 'q', 'quiet', 'i'], alias: { 'dry-run': 'n', force: 'f', quiet: 'q' } }, 'usage: git clean [-d] [-f] [-i] [-n] [-q] [-e <pattern>] [-x | -X] [--] [<pathspec>...]');
  if (p.flags.i) throw new GitError('devquest: interactive clean is not simulated; use git clean -n to preview, then -f', 1);
  const repo = repoOf(g);
  if (!p.flags.n && !p.flags.f) throw new GitError('fatal: clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean');
  const cwd = g.ctx.state.cwd;
  const specs = [...p.args, ...p.paths].map((a) => repoPath(repo, cwd, a));
  const work = readWorktree(g.ctx.vfs, repo);
  const rules = ignoreRules(work);
  const st = computeStatus(g.ctx.vfs, repo, { collapseUntracked: true });
  const candidates = new Set<string>(st.untracked);
  if (p.flags.x || p.flags.X) {
    for (const f of Object.keys(work)) if (!(f in repo.index) && isIgnored(rules, f)) candidates.add(f);
  }
  let code = 0;
  for (const c of [...candidates].sort()) {
    const isDir = c.endsWith('/');
    if (p.flags.X && !isIgnored(rules, c.replace(/\/$/, ''))) continue;
    if (specs.length && !specs.some((s) => inSpec(c.replace(/\/$/, ''), s))) continue;
    if (isDir && !p.flags.d) continue;
    const shown = displayPath(repo, cwd, c.replace(/\/$/, '')) + (isDir ? '/' : '');
    if (p.flags.n) g.out(`Would remove ${shown}\n`);
    else {
      if (!p.flags.q) g.out(`Removing ${shown}\n`);
      try {
        if (isDir) g.ctx.vfs.remove(resolvePath(repo.root, c), { recursive: true });
        else deleteWorkFile(g.ctx.vfs, repo, c);
      } catch {
        code = 1;
      }
    }
  }
  return code;
}

// ------------------------------------------------------------------ plumbing

function resolveObject(repo: Repo, spec: string): { type: 'blob' | 'tree' | 'commit' | 'tag'; sha: string } {
  const all = (s: string) => ['blobs', 'trees', 'commits', 'tags'].find((k) => s in (repo.objects as unknown as Record<string, Record<string, unknown>>)[k]);
  const typeOf = (s: string) => ({ blobs: 'blob', trees: 'tree', commits: 'commit', tags: 'tag' })[all(s) as 'blobs'] as 'blob';
  const colon = /^([^:]*):(.+)$/.exec(spec);
  if (colon) {
    const e = flatOf(repo, mustResolve(repo, colon[1] || 'HEAD'))[colon[2]];
    if (!e) throw new GitError(`fatal: path '${colon[2]}' does not exist in '${colon[1] || 'HEAD'}'`);
    return { type: 'blob', sha: e.sha };
  }
  const tree = /^(.*)\^\{tree\}$/.exec(spec);
  if (tree) return { type: 'tree', sha: repo.objects.commits[mustResolve(repo, tree[1])].tree };
  if (/^[0-9a-f]{4,40}$/.test(spec)) {
    const hits = (['blobs', 'trees', 'commits', 'tags'] as const).flatMap((k) => Object.keys(repo.objects[k]).filter((s) => s.startsWith(spec)));
    if (hits.length === 1) return { type: typeOf(hits[0]), sha: hits[0] };
  }
  if (repo.tags[spec] && repo.objects.tags[repo.tags[spec]]) return { type: 'tag', sha: repo.tags[spec] };
  const sha = resolveRev(repo, spec);
  if (!sha) throw new GitError(`fatal: Not a valid object name ${spec}`);
  return { type: 'commit', sha };
}

export function gitCatFile(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['t', 'p', 's', 'e'] }, 'usage: git cat-file (-t | -s | -e | -p) <object>');
  const repo = repoOf(g);
  const spec = p.args[0];
  if (!spec || !(p.flags.t || p.flags.p || p.flags.s || p.flags.e)) throw new GitError('usage: git cat-file (-t | -s | -e | -p) <object>', 129);
  let obj;
  try {
    obj = resolveObject(repo, spec);
  } catch (e) {
    if (p.flags.e) return 1;
    throw e;
  }
  if (p.flags.e) return 0;
  const body = () => {
    switch (obj.type) {
      case 'blob':
        return repo.objects.blobs[obj.sha];
      case 'commit':
        return commitBody(repo.objects.commits[obj.sha]);
      case 'tag':
        return tagBody(repo.objects.tags[obj.sha]);
      case 'tree':
        return repo.objects.trees[obj.sha].map((e) => `${e.mode} ${e.mode === '040000' ? 'tree' : 'blob'} ${e.sha}\t${e.name}\n`).join('');
    }
  };
  if (p.flags.t) g.out(obj.type + '\n');
  else if (p.flags.s) g.out(new TextEncoder().encode(obj.type === 'tree' ? '' : body()).length + '\n');
  else g.out(body());
  return 0;
}

export function gitHashObject(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['w', 'stdin'] }, 'usage: git hash-object [-t <type>] [-w] [--stdin] <file>...');
  const contents: string[] = [];
  if (p.flags.stdin) contents.push(g.ctx.stdin);
  for (const f of p.args) {
    try {
      contents.push(g.ctx.vfs.readFile(resolvePath(g.ctx.state.cwd, f)));
    } catch {
      throw new GitError(`fatal: could not open '${f}' for reading: No such file or directory`);
    }
  }
  const repo = p.flags.w ? repoOf(g) : null;
  for (const c of contents) g.out((repo ? writeBlob(repo.objects, c) : blobSha(c)) + '\n');
  return 0;
}

export function gitRevParse(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['short', 'abbrev-ref', 'show-toplevel', 'git-dir', 'is-inside-work-tree', 'verify', 'symbolic-full-name'] }, 'usage: git rev-parse [<options>] <args>...');
  const repo = repoOf(g);
  if (p.flags['show-toplevel']) g.out(repo.root + '\n');
  if (p.flags['git-dir']) g.out((g.ctx.state.cwd === repo.root ? '.git' : `${repo.root}/.git`) + '\n');
  if (p.flags['is-inside-work-tree']) g.out('true\n');
  for (const a of p.args) {
    if (p.flags['abbrev-ref']) {
      if (a === 'HEAD') {
        g.out((currentBranch(repo) ?? 'HEAD') + '\n');
        continue;
      }
      const up = /^(.*)@\{(u|upstream)\}$/.exec(a);
      if (up) {
        const b = up[1] || currentBranch(repo);
        const cfg = b ? repo.branches[b] : undefined;
        if (!cfg) throw new GitError(`fatal: no upstream configured for branch '${b}'`);
        g.out(`${cfg.remote}/${cfg.merge.replace(/^refs\/heads\//, '')}\n`);
        continue;
      }
    }
    const sha = resolveRev(repo, a);
    if (!sha) throw new GitError(`fatal: ambiguous argument '${a}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
    g.out((p.flags.short ? shortSha(sha) : sha) + '\n');
  }
  return 0;
}

export function gitLsFiles(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['s', 'stage', 'o', 'others', 'u', 'unmerged', 'c', 'cached', 'exclude-standard', 'i', 'ignored'], alias: { stage: 's', others: 'o', unmerged: 'u', cached: 'c', ignored: 'i' } }, 'usage: git ls-files [<options>] [<file>...]');
  const repo = repoOf(g);
  const cwd = g.ctx.state.cwd;
  const d = (f: string) => displayPath(repo, cwd, f);
  if (p.flags.o) {
    const work = readWorktree(g.ctx.vfs, repo);
    const rules = ignoreRules(work);
    const files = Object.keys(work).filter((f) => !(f in repo.index) && (p.flags.i ? isIgnored(rules, f) : !p.flags['exclude-standard'] || !isIgnored(rules, f)));
    g.out(files.map((f) => d(f) + '\n').join(''));
    return 0;
  }
  if (p.flags.u) {
    let out = '';
    for (const [f, c] of Object.entries(repo.conflicts).sort()) {
      if (c.base) out += `${c.base.mode} ${c.base.sha} 1\t${d(f)}\n`;
      if (c.ours) out += `${c.ours.mode} ${c.ours.sha} 2\t${d(f)}\n`;
      if (c.theirs) out += `${c.theirs.mode} ${c.theirs.sha} 3\t${d(f)}\n`;
    }
    g.out(out);
    return 0;
  }
  const paths = Object.keys(repo.index).sort();
  g.out(paths.map((f) => (p.flags.s ? `${repo.index[f].mode} ${repo.index[f].sha} 0\t${d(f)}\n` : `${d(f)}\n`)).join(''));
  return 0;
}

export { flatten };
