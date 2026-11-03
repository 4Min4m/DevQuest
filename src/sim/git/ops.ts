/** Porcelain building blocks: committing, checking out trees, three-way merges, diffstats. */
import type { CommandContext } from '../shell/types';
import type { Vfs } from '../vfs/vfs';
import { countChanges, merge3 } from './diff';
import { blobSha, flatten, shortSha, subject, treeFromFlat, writeBlob, writeCommit } from './objects';
import { currentBranch, deleteWorkFile, GitError, headSha, headTree, identity, moveHead, readWorktree, writeWorkFile } from './repo';
import type { Conflict, FlatTree, Repo } from './types';

export const nowSec = (ctx: CommandContext) => Math.floor(ctx.state.clock / 1000);

export function sameEntry(a?: { sha: string; mode: string }, b?: { sha: string; mode: string }): boolean {
  if (!a || !b) return !a && !b;
  return a.sha === b.sha && a.mode === b.mode;
}

export function blobText(repo: Repo, sha: string | undefined): string {
  return sha ? repo.objects.blobs[sha] ?? '' : '';
}

/** Create a commit from the index and move HEAD to it. */
export function commitIndex(
  ctx: CommandContext,
  repo: Repo,
  message: string,
  parents: string[],
  reflogKind: string,
  author?: { name: string; email: string; time: number },
): string {
  const who = identity(ctx, repo);
  const committer = { ...who, time: nowSec(ctx) };
  const tree = treeFromFlat(repo.objects, repo.index);
  const sha = writeCommit(repo.objects, { tree, parents, author: author ?? committer, committer, message });
  moveHead(repo, sha, `${reflogKind}: ${subject(message)}`);
  return sha;
}

// ------------------------------------------------------------------ diffstat

export interface FileStat {
  path: string;
  ins: number;
  del: number;
  created?: string;
  deleted?: string;
  modeChange?: [string, string];
}

export function treeStats(repo: Repo, from: FlatTree, to: FlatTree): FileStat[] {
  const out: FileStat[] = [];
  for (const p of Object.keys({ ...from, ...to }).sort()) {
    const a = from[p];
    const b = to[p];
    if (sameEntry(a, b)) continue;
    const { ins, del } = countChanges(blobText(repo, a?.sha), blobText(repo, b?.sha));
    const st: FileStat = { path: p, ins, del };
    if (!a) st.created = b.mode;
    if (!b) st.deleted = a.mode;
    if (a && b && a.mode !== b.mode) st.modeChange = [a.mode, b.mode];
    out.push(st);
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function summaryLine(stats: FileStat[]): string {
  if (!stats.length) return '';
  const ins = stats.reduce((n, s) => n + s.ins, 0);
  const del = stats.reduce((n, s) => n + s.del, 0);
  let line = ` ${plural(stats.length, 'file')} changed`;
  if (ins || !del) line += `, ${ins} insertion${ins === 1 ? '' : 's'}(+)`;
  if (del) line += `, ${del} deletion${del === 1 ? '' : 's'}(-)`;
  return line + '\n';
}

export function modeLines(stats: FileStat[]): string {
  let out = '';
  for (const s of stats) {
    if (s.created) out += ` create mode ${s.created} ${s.path}\n`;
    else if (s.deleted) out += ` delete mode ${s.deleted} ${s.path}\n`;
    else if (s.modeChange) out += ` mode change ${s.modeChange[0]} => ${s.modeChange[1]} ${s.path}\n`;
  }
  return out;
}

/** " file | 3 ++-" lines as printed by merge / pull / show --stat. */
export function statGraph(stats: FileStat[]): string {
  const width = Math.max(...stats.map((s) => s.path.length));
  const numW = Math.max(...stats.map((s) => String(s.ins + s.del).length));
  const max = Math.max(...stats.map((s) => s.ins + s.del));
  const scale = max > 50 ? 50 / max : 1;
  return stats
    .map((s) => {
      const n = s.ins + s.del;
      const plus = '+'.repeat(Math.round(s.ins * scale) || (s.ins ? 1 : 0));
      const minus = '-'.repeat(Math.round(s.del * scale) || (s.del ? 1 : 0));
      return ` ${s.path.padEnd(width)} | ${String(n).padStart(numW)} ${plus}${minus}`.trimEnd() + '\n';
    })
    .join('');
}

/** What `git commit` prints: "[main abc1234] message" plus the stats. */
export function commitReport(repo: Repo, sha: string, opts: { root?: boolean; detail?: string } = {}): string {
  const c = repo.objects.commits[sha];
  const parentTree = c.parents[0] ? flatOf(repo, c.parents[0]) : {};
  const stats = treeStats(repo, parentTree, flatOf(repo, sha));
  const branch = currentBranch(repo) ?? 'detached HEAD';
  const tag = opts.root ? ' (root-commit)' : '';
  return `[${branch}${tag} ${shortSha(sha)}] ${subject(c.message)}\n${opts.detail ?? ''}${summaryLine(stats)}${modeLines(stats)}`;
}

function flatOf(repo: Repo, sha: string): FlatTree {
  return flatten(repo.objects, repo.objects.commits[sha].tree);
}

// ------------------------------------------------------------------ checkout

/** Tracked paths whose index or working-tree content differs from HEAD. */
export function dirtyPaths(vfs: Vfs, repo: Repo): Set<string> {
  const head = headTree(repo);
  const work = readWorktree(vfs, repo);
  const dirty = new Set<string>();
  for (const p of Object.keys({ ...head, ...repo.index })) {
    const i = repo.index[p];
    if (!sameEntry(head[p], i)) dirty.add(p);
    const w = work[p];
    if (i && (!w || blobSha(w.content) !== i.sha || w.mode !== i.mode)) dirty.add(p);
  }
  return dirty;
}

/**
 * Move the index and working tree from HEAD's tree to `target`, keeping unrelated local
 * changes (like `git switch`). Throws if local changes or untracked files would be overwritten.
 */
export function checkoutTree(vfs: Vfs, repo: Repo, target: FlatTree, action: string, force = false): void {
  const head = headTree(repo);
  const work = readWorktree(vfs, repo);
  if (force) {
    for (const p of Object.keys({ ...head, ...repo.index })) if (!target[p]) deleteWorkFile(vfs, repo, p);
    for (const [p, e] of Object.entries(target)) {
      const w = work[p];
      if (!w || blobSha(w.content) !== e.sha || w.mode !== e.mode) writeWorkFile(vfs, repo, p, blobText(repo, e.sha), e.mode);
    }
    repo.index = { ...target };
    repo.conflicts = {};
    return;
  }
  const changed = Object.keys({ ...head, ...target }).filter((p) => !sameEntry(head[p], target[p]));
  const dirty = dirtyPaths(vfs, repo);
  const blocked = changed.filter((p) => dirty.has(p) && !(sameEntry(repo.index[p], target[p]) && work[p] && blobSha(work[p].content) === target[p]?.sha));
  if (blocked.length) {
    throw new GitError(
      `error: Your local changes to the following files would be overwritten by ${action}:\n${blocked.map((p) => `\t${p}\n`).join('')}` +
        `Please commit your changes or stash them before you ${action === 'checkout' ? 'switch branches' : action}.\nAborting`,
      1,
    );
  }
  const untracked = changed.filter((p) => !head[p] && !repo.index[p] && target[p] && work[p] && blobSha(work[p].content) !== target[p].sha);
  if (untracked.length) {
    throw new GitError(
      `error: The following untracked working tree files would be overwritten by ${action}:\n${untracked.map((p) => `\t${p}\n`).join('')}` +
        `Please move or remove them before you ${action === 'checkout' ? 'switch branches' : action}.\nAborting`,
      1,
    );
  }
  for (const p of changed) {
    const e = target[p];
    if (e) {
      writeWorkFile(vfs, repo, p, blobText(repo, e.sha), e.mode);
      repo.index[p] = e;
    } else {
      deleteWorkFile(vfs, repo, p);
      delete repo.index[p];
    }
  }
}

// ------------------------------------------------------------------ three-way merge

export interface MergeOutcome {
  /** Resulting tree for every path without a conflict. */
  clean: FlatTree;
  conflicts: Record<string, Conflict>;
  /** Working-tree content to write (null = delete). */
  work: Record<string, { content: string; mode: string } | null>;
  messages: string[];
}

export function mergeTrees(repo: Repo, base: FlatTree, ours: FlatTree, theirs: FlatTree, oursLabel: string, theirsLabel: string): MergeOutcome {
  const out: MergeOutcome = { clean: {}, conflicts: {}, work: {}, messages: [] };
  for (const p of Object.keys({ ...base, ...ours, ...theirs }).sort()) {
    const b = base[p];
    const o = ours[p];
    const t = theirs[p];
    if (sameEntry(o, t)) {
      if (o) out.clean[p] = o;
      continue;
    }
    if (sameEntry(o, b)) {
      if (t) {
        out.clean[p] = t;
        out.work[p] = { content: blobText(repo, t.sha), mode: t.mode };
      } else out.work[p] = null;
      continue;
    }
    if (sameEntry(t, b)) {
      if (o) out.clean[p] = o;
      continue;
    }
    if (o && t) {
      out.messages.push(`Auto-merging ${p}`);
      const m = merge3(blobText(repo, b?.sha), blobText(repo, o.sha), blobText(repo, t.sha), oursLabel, theirsLabel);
      const mode = o.mode === t.mode ? o.mode : o.mode === b?.mode ? t.mode : o.mode;
      if (!m.conflicts) {
        out.clean[p] = { sha: writeBlob(repo.objects, m.text), mode };
        out.work[p] = { content: m.text, mode };
      } else {
        out.conflicts[p] = { base: b, ours: o, theirs: t };
        out.work[p] = { content: m.text, mode };
        out.messages.push(`CONFLICT (${b ? 'content' : 'add/add'}): Merge conflict in ${p}`);
      }
      continue;
    }
    // Modified on one side, deleted on the other.
    out.conflicts[p] = { base: b, ours: o, theirs: t };
    if (o) {
      out.messages.push(`CONFLICT (modify/delete): ${p} deleted in ${theirsLabel} and modified in HEAD.  Version HEAD of ${p} left in tree.`);
    } else {
      out.messages.push(`CONFLICT (modify/delete): ${p} deleted in HEAD and modified in ${theirsLabel}.  Version ${theirsLabel} of ${p} left in tree.`);
      out.work[p] = { content: blobText(repo, t!.sha), mode: t!.mode };
    }
  }
  return out;
}

/** Write a merge outcome into the index and working tree. */
export function applyMergeOutcome(vfs: Vfs, repo: Repo, m: MergeOutcome): void {
  repo.index = { ...m.clean };
  repo.conflicts = m.conflicts;
  for (const [p, w] of Object.entries(m.work)) {
    if (w) writeWorkFile(vfs, repo, p, w.content, w.mode as '100644');
    else deleteWorkFile(vfs, repo, p);
  }
}

/** Refuse to start a merge-like operation that would clobber local changes. */
export function guardLocalChanges(vfs: Vfs, repo: Repo, m: MergeOutcome, action: string): void {
  const head = headTree(repo);
  const touched = Object.keys({ ...m.work, ...m.conflicts }).filter((p) => p in m.conflicts || !sameEntry(head[p], m.clean[p]));
  const dirty = dirtyPaths(vfs, repo);
  const blocked = touched.filter((p) => dirty.has(p));
  if (blocked.length) {
    throw new GitError(
      `error: Your local changes to the following files would be overwritten by ${action}:\n${blocked.map((p) => `\t${p}\n`).join('')}Please commit your changes or stash them before you ${action}.\nAborting`,
      action === 'merge' ? 2 : 1,
    );
  }
  const work = readWorktree(vfs, repo);
  const untracked = Object.keys(m.work).filter((p) => !head[p] && !repo.index[p] && work[p] && m.work[p] && m.work[p]!.content !== work[p].content);
  if (untracked.length) {
    throw new GitError(
      `error: The following untracked working tree files would be overwritten by ${action}:\n${untracked.map((p) => `\t${p}\n`).join('')}Please move or remove them before you ${action}.\nAborting`,
      action === 'merge' ? 2 : 1,
    );
  }
}

/** Apply one commit's changes onto HEAD (cherry-pick / rebase step / revert). */
export function pickOnto(repo: Repo, commit: string, revert = false): MergeOutcome {
  const c = repo.objects.commits[commit];
  const parent = c.parents[0] ? flatOf(repo, c.parents[0]) : {};
  const mine = flatOf(repo, commit);
  const label = `${shortSha(commit)} (${subject(c.message)})`;
  const head = headTree(repo);
  return revert
    ? mergeTrees(repo, mine, head, parent, 'HEAD', `parent of ${label}`)
    : mergeTrees(repo, parent, head, mine, 'HEAD', label);
}

export function requireHead(repo: Repo): string {
  const h = headSha(repo);
  if (!h) throw new GitError("fatal: your current branch '" + (currentBranch(repo) ?? 'HEAD') + "' does not have any commits yet");
  return h;
}

export { flatOf };
