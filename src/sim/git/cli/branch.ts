/** git branch, switch, checkout, merge, rebase, cherry-pick, revert, stash. */
import { merge3 } from '../diff';
import { blobSha, shortSha, subject, writeBlob } from '../objects';
import { sha1, utf8 } from '../sha1';
import {
  applyMergeOutcome,
  blobText,
  checkoutTree,
  commitIndex,
  commitReport,
  dirtyPaths,
  guardLocalChanges,
  mergeTrees,
  MergeOutcome,
  modeLines,
  pickOnto,
  requireHead,
  sameEntry,
  statGraph,
  summaryLine,
  treeStats,
} from '../ops';
import {
  computeStatus,
  commitTree,
  currentBranch,
  deleteWorkFile,
  describeCommit,
  GitError,
  headSha,
  headTree,
  isAncestor,
  mergeBase,
  moveHead,
  mustResolve,
  readWorktree,
  repoPath,
  resolveRev,
  revList,
  writeWorkFile,
  inSpec,
} from '../repo';
import type { FlatTree, Repo, StashEntry } from '../types';
import { gitDate, longStatus, orphanedCommits, trackingText } from './basic';
import { GitCtx, parseArgs, repoOf } from './common';
import { treeDiff } from './history';

// ------------------------------------------------------------------ branch names

export function validRefName(name: string): boolean {
  return (
    !!name &&
    !name.startsWith('-') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.includes('@{') &&
    name !== '@' &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)
  );
}

function checkName(name: string): void {
  if (!validRefName(name)) throw new GitError(`fatal: '${name}' is not a valid branch name`);
}

// ------------------------------------------------------------------ switching

function headName(repo: Repo): string {
  const b = currentBranch(repo);
  return b ?? headSha(repo) ?? 'HEAD';
}

const DETACHED_ADVICE = (rev: string, sha: string, repo: Repo) =>
  `Note: switching to '${rev}'.\n\n` +
  "You are in 'detached HEAD' state. You can look around, make experimental\n" +
  'changes and commit them, and you can discard any commits you make in this\n' +
  'state without impacting any branches by switching back to a branch.\n\n' +
  'If you want to create a new branch to retain commits you create, you may\n' +
  'do so (now or later) by using -c with the switch command. Example:\n\n' +
  '  git switch -c <new-branch-name>\n\n' +
  'Or undo this operation with:\n\n  git switch -\n\n' +
  'Turn off this advice by setting config variable advice.detachedHead to false\n\n' +
  `HEAD is now at ${describeCommit(repo, sha)}\n`;

function orphanWarning(repo: Repo, leaving: string): string {
  const lost = orphanedCommits(repo, leaving);
  if (!lost.length) return '';
  const n = lost.length;
  return (
    `Warning: you are leaving ${n} commit${n === 1 ? '' : 's'} behind, not connected to\nany of your branches:\n\n` +
    lost.slice(0, 5).map((s) => `  ${describeCommit(repo, s)}\n`).join('') +
    (n > 5 ? ` ... and ${n - 5} more.\n` : '') +
    '\nIf you want to keep it by creating a new branch, this may be a good time\nto do so with:\n\n' +
    ` git branch <new-branch-name> ${shortSha(lost[0])}\n\n`
  );
}

/** Move HEAD to a branch (or detached commit), updating index and working tree. */
function switchTo(g: GitCtx, repo: Repo, target: { branch?: string; sha?: string; rev?: string }, force = false): void {
  const fromName = headName(repo);
  const fromDetached = !currentBranch(repo) ? headSha(repo) : undefined;
  const sha = target.branch ? repo.heads[target.branch] : target.sha!;
  if (target.branch && currentBranch(repo) === target.branch) {
    g.note(`Already on '${target.branch}'\n`);
    g.out(trackingText(repo));
    return;
  }
  if (sha) checkoutTree(g.ctx.vfs, repo, commitTree(repo, sha), 'checkout', force);
  let warn = '';
  if (fromDetached && (target.branch || sha !== fromDetached)) {
    repo.head = { detached: fromDetached };
    warn = orphanWarning(repo, fromDetached);
  }
  repo.head = target.branch ? { branch: target.branch } : { detached: sha! };
  repo.reflog.push({ sha: sha ?? '', message: `checkout: moving from ${fromName} to ${target.branch ?? target.rev ?? sha}` });
  if (target.branch) {
    g.note(`${warn}${warn ? 'Previous HEAD position was ' + describeCommit(repo, fromDetached!) + '\n' : ''}Switched to branch '${target.branch}'\n`);
    g.out(trackingText(repo));
  } else {
    g.note(warn + (fromDetached ? `Previous HEAD position was ${describeCommit(repo, fromDetached)}\nHEAD is now at ${describeCommit(repo, sha!)}\n` : DETACHED_ADVICE(target.rev ?? sha!, sha!, repo)));
  }
}

function previousBranch(repo: Repo): string {
  for (let i = repo.reflog.length - 1; i >= 0; i--) {
    const m = /^checkout: moving from (\S+) to /.exec(repo.reflog[i].message);
    if (m) return m[1];
  }
  throw new GitError('fatal: invalid reference: @{-1}');
}

function createBranch(g: GitCtx, repo: Repo, name: string, start: string | undefined, force: boolean): string {
  checkName(name);
  if (repo.heads[name] && !force) throw new GitError(`fatal: a branch named '${name}' already exists`);
  const sha = start ? resolveRev(repo, start) : headSha(repo);
  if (!sha) throw new GitError(`fatal: not a valid object name: '${start ?? currentBranch(repo) ?? 'HEAD'}'`);
  repo.heads[name] = sha;
  if (start && repo.remoteRefs[start] && start.includes('/')) {
    const [remote, ...rest] = start.split('/');
    repo.branches[name] = { remote, merge: `refs/heads/${rest.join('/')}` };
    g.out(`branch '${name}' set up to track '${start}'.\n`);
  }
  return sha;
}

/** `git switch foo` when only origin/foo exists: create a tracking branch (DWIM). */
function dwimRemote(g: GitCtx, repo: Repo, name: string): boolean {
  const hits = Object.keys(repo.remoteRefs).filter((r) => r.split('/').slice(1).join('/') === name);
  if (hits.length !== 1) return false;
  repo.heads[name] = repo.remoteRefs[hits[0]];
  const [remote] = hits[0].split('/');
  repo.branches[name] = { remote, merge: `refs/heads/${name}` };
  checkoutTree(g.ctx.vfs, repo, commitTree(repo, repo.heads[name]), 'checkout');
  const from = headName(repo);
  repo.head = { branch: name };
  repo.reflog.push({ sha: repo.heads[name], message: `checkout: moving from ${from} to ${name}` });
  g.out(`branch '${name}' set up to track '${hits[0]}'.\n`);
  g.note(`Switched to a new branch '${name}'\n`);
  return true;
}

function startNewBranch(g: GitCtx, repo: Repo, name: string, start: string | undefined, force: boolean): void {
  const unborn = !headSha(repo) && !start;
  if (unborn) {
    checkName(name);
    const from = headName(repo);
    repo.head = { branch: name };
    repo.reflog.push({ sha: '', message: `checkout: moving from ${from} to ${name}` });
    g.note(`Switched to a new branch '${name}'\n`);
    return;
  }
  const sha = start ? mustResolve(repo, start) : headSha(repo)!;
  if (repo.heads[name] && !force) throw new GitError(`fatal: a branch named '${name}' already exists`);
  checkName(name);
  checkoutTree(g.ctx.vfs, repo, commitTree(repo, sha), 'checkout');
  const from = headName(repo);
  createBranch(g, repo, name, start, true);
  repo.head = { branch: name };
  repo.reflog.push({ sha, message: `checkout: moving from ${from} to ${name}` });
  g.note(`Switched to a new branch '${name}'\n`);
}

export function gitSwitch(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['detach', 'd', 'f', 'force', 'discard-changes', 'q', 'quiet'], value: ['c', 'create', 'C', 'force-create'], alias: { create: 'c', 'force-create': 'C', d: 'detach', quiet: 'q' } }, 'usage: git switch [<options>] [<branch>]');
  if (p.flags.q) g = { ...g, note: () => {} };
  const repo = repoOf(g);
  const force = !!(p.flags.f || p.flags.force || p.flags['discard-changes']);
  const create = (p.flags.c ?? p.flags.C) as string | undefined;
  if (create) {
    startNewBranch(g, repo, create, p.args[0], !!p.flags.C);
    return 0;
  }
  let name = p.args[0];
  if (!name) throw new GitError('fatal: missing branch or commit argument');
  if (name === '-') name = previousBranch(repo);
  if (p.flags.detach) {
    switchTo(g, repo, { sha: mustResolve(repo, name), rev: name }, force);
    return 0;
  }
  if (repo.heads[name]) {
    switchTo(g, repo, { branch: name }, force);
    return 0;
  }
  if (dwimRemote(g, repo, name)) return 0;
  if (resolveRev(repo, name)) {
    throw new GitError(`fatal: a branch is expected, got ${repo.tags[name] ? `tag '${name}'` : repo.remoteRefs[name] ? `remote branch '${name}'` : `commit '${name}'`}\nhint: If you want to detach HEAD at the commit, try again with the --detach option.`);
  }
  throw new GitError(`fatal: invalid reference: ${name}`);
}

export function gitCheckout(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['f', 'force', 'detach', 'ours', 'theirs', 'q', 'quiet'], value: ['b', 'B'], alias: { force: 'f', quiet: 'q' } }, 'usage: git checkout [<options>] <branch>\n   or: git checkout [<options>] [<branch>] -- <file>...');
  if (p.flags.q) g = { ...g, note: () => {} };
  const repo = repoOf(g);
  const force = !!p.flags.f;
  const create = (p.flags.b ?? p.flags.B) as string | undefined;
  if (create) {
    startNewBranch(g, repo, create, p.args[0], !!p.flags.B);
    return 0;
  }
  const args = [...p.args];
  // Paths mode: `checkout -- f`, `checkout rev -- f`, `checkout --ours f`, or args that aren't revisions.
  let rev: string | undefined;
  let paths = [...p.paths];
  if (p.dashdash) rev = args[0];
  else if (args.length && (args[0] === '-' || repo.heads[args[0]] || resolveRev(repo, args[0]) || Object.keys(repo.remoteRefs).some((r) => r.split('/').slice(1).join('/') === args[0]))) {
    rev = args.shift();
    paths = args;
  } else paths = args;
  if (!rev && !paths.length) {
    if (p.flags.ours || p.flags.theirs) throw new GitError('fatal: --ours/--theirs needs paths');
    g.out(trackingText(repo));
    return 0;
  }
  if (paths.length || p.flags.ours || p.flags.theirs) {
    const cwd = g.ctx.state.cwd;
    const source: FlatTree = rev ? commitTree(repo, mustResolve(repo, rev)) : repo.index;
    let count = 0;
    for (const a of paths) {
      const spec = repoPath(repo, cwd, a);
      const universe = Object.keys({ ...source, ...repo.conflicts });
      const hits = universe.filter((f) => inSpec(f, spec));
      if (!hits.length) throw new GitError(`error: pathspec '${a}' did not match any file(s) known to git`, 1);
      for (const f of hits) {
        const c = repo.conflicts[f];
        if (c && !rev) {
          const side = p.flags.ours ? c.ours : p.flags.theirs ? c.theirs : null;
          if (!side) throw new GitError(`error: path '${f}' is unmerged`, 1);
          writeWorkFile(g.ctx.vfs, repo, f, blobText(repo, side.sha), side.mode);
        } else {
          const e = source[f];
          if (!e) continue;
          writeWorkFile(g.ctx.vfs, repo, f, blobText(repo, e.sha), e.mode);
          if (rev) {
            repo.index[f] = e;
            delete repo.conflicts[f];
          }
        }
        count++;
      }
    }
    g.note(`Updated ${count} path${count === 1 ? '' : 's'} from ${rev ? `${shortSha(mustResolve(repo, rev))}` : 'the index'}\n`);
    return 0;
  }
  let name = rev!;
  if (name === '-') name = previousBranch(repo);
  if (repo.heads[name] && !p.flags.detach) switchTo(g, repo, { branch: name }, force);
  else if (!p.flags.detach && dwimRemote(g, repo, name)) return 0;
  else switchTo(g, repo, { sha: mustResolve(repo, name), rev: name }, force);
  return 0;
}

// ------------------------------------------------------------------ branch

export function gitBranch(g: GitCtx): number {
  const p = parseArgs(
    g.args,
    {
      bool: ['d', 'D', 'delete', 'm', 'M', 'move', 'a', 'all', 'r', 'remotes', 'v', 'vv', 'verbose', 'show-current', 'unset-upstream', 'f', 'force', 'merged', 'no-merged', 'list', 'l'],
      value: ['u', 'set-upstream-to'],
      alias: { delete: 'd', move: 'm', all: 'a', remotes: 'r', verbose: 'v', 'set-upstream-to': 'u', force: 'f', list: 'l' },
    },
    'usage: git branch [<options>] [-r | -a] [--merged] [--no-merged]',
  );
  const repo = repoOf(g);
  const cur = currentBranch(repo);
  if (p.flags['show-current']) {
    if (cur) g.out(cur + '\n');
    return 0;
  }
  if (p.flags.d || p.flags.D) {
    if (!p.args.length) throw new GitError('fatal: branch name required');
    let code = 0;
    for (const name of p.args) {
      if (p.flags.r) {
        if (!repo.remoteRefs[name]) {
          g.err(`error: remote-tracking branch '${name}' not found.\n`);
          code = 1;
          continue;
        }
        g.out(`Deleted remote-tracking branch ${name} (was ${shortSha(repo.remoteRefs[name])}).\n`);
        delete repo.remoteRefs[name];
        continue;
      }
      const sha = repo.heads[name];
      if (!sha) {
        g.err(`error: branch '${name}' not found\n`);
        code = 1;
        continue;
      }
      if (name === cur) {
        g.err(`error: cannot delete branch '${name}' used by worktree at '${repo.root}'\n`);
        code = 1;
        continue;
      }
      const cfg = repo.branches[name];
      const upstream = cfg ? repo.remoteRefs[`${cfg.remote}/${cfg.merge.replace(/^refs\/heads\//, '')}`] : undefined;
      const merged = (headSha(repo) && isAncestor(repo, sha, headSha(repo)!)) || (upstream && isAncestor(repo, sha, upstream));
      if (!merged && !p.flags.D && !p.flags.f) {
        g.err(`error: the branch '${name}' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D ${name}'\nhint: Disable this message with "git config advice.forceDeleteBranch false"\n`);
        code = 1;
        continue;
      }
      delete repo.heads[name];
      delete repo.branches[name];
      g.out(`Deleted branch ${name} (was ${shortSha(sha)}).\n`);
    }
    return code;
  }
  if (p.flags.m || p.flags.M) {
    const [a, b] = p.args;
    const from = b ? a : cur;
    const to = b ?? a;
    if (!from || !to) throw new GitError('fatal: branch name required');
    checkName(to);
    if (repo.heads[to] && !p.flags.M && from !== to) throw new GitError(`fatal: a branch named '${to}' already exists`);
    if (!repo.heads[from] && from !== cur) throw new GitError(`error: refname refs/heads/${from} not found\nfatal: branch rename failed`);
    if (repo.heads[from]) {
      repo.heads[to] = repo.heads[from];
      if (from !== to) delete repo.heads[from];
    }
    if (repo.branches[from]) {
      repo.branches[to] = repo.branches[from];
      if (from !== to) delete repo.branches[from];
    }
    if (cur === from) repo.head = { branch: to };
    return 0;
  }
  if (p.flags.u !== undefined) {
    const up = p.flags.u as string;
    const name = p.args[0] ?? cur;
    if (!name) throw new GitError('fatal: could not set upstream of HEAD to ' + up + ' when it does not point to any branch.');
    if (!repo.remoteRefs[up]) throw new GitError(`fatal: the requested upstream branch '${up}' does not exist`);
    const [remote, ...rest] = up.split('/');
    repo.branches[name] = { remote, merge: `refs/heads/${rest.join('/')}` };
    g.out(`branch '${name}' set up to track '${up}'.\n`);
    return 0;
  }
  if (p.flags['unset-upstream']) {
    const name = p.args[0] ?? cur;
    if (!name || !repo.branches[name]) throw new GitError(`fatal: branch '${name}' has no upstream information`);
    delete repo.branches[name];
    return 0;
  }
  if (p.args.length && !p.flags.l) {
    createBranch(g, repo, p.args[0], p.args[1], !!p.flags.f);
    return 0;
  }
  // Listing
  const vv = !!p.flags.vv || g.args.includes('-vv');
  const verbose = p.flags.v || vv;
  let locals = Object.keys(repo.heads).sort();
  if (p.flags.merged || p.flags['no-merged']) {
    const h = headSha(repo);
    locals = locals.filter((b) => !!h && isAncestor(repo, repo.heads[b], h) === !!p.flags.merged);
  }
  const rows: [string, string, string][] = [];
  if (!p.flags.r) {
    if (!cur && headSha(repo)) {
      const op = repo.op;
      const label = op?.kind === 'rebase' ? `(no branch, rebasing ${op.branch ?? 'HEAD'})` : `(HEAD detached at ${shortSha(headSha(repo)!)})`;
      rows.push(['*', label, headSha(repo)!]);
    }
    for (const b of locals) rows.push([b === cur ? '*' : ' ', b, repo.heads[b]]);
  }
  if (p.flags.a || p.flags.r) {
    for (const r of Object.keys(repo.remoteRefs).sort()) {
      const name = (p.flags.a ? 'remotes/' : '') + r;
      if (r.endsWith('/HEAD')) rows.push([' ', `${name} -> ${r.replace(/HEAD$/, 'main')}`, '']);
      else rows.push([' ', name, repo.remoteRefs[r]]);
    }
  }
  const width = Math.max(0, ...rows.filter((r) => r[2]).map((r) => r[1].length));
  for (const [mark, name, sha] of rows) {
    if (!verbose || !sha) {
      g.out(`${mark} ${name}\n`);
      continue;
    }
    let up = '';
    if (vv && repo.branches[name]) {
      const cfg = repo.branches[name];
      const upName = `${cfg.remote}/${cfg.merge.replace(/^refs\/heads\//, '')}`;
      const upSha = repo.remoteRefs[upName];
      if (!upSha) up = `[${upName}: gone] `;
      else {
        const ahead = revList(repo, [sha], [upSha]).length;
        const behind = revList(repo, [upSha], [sha]).length;
        const parts = [ahead ? `ahead ${ahead}` : '', behind ? `behind ${behind}` : ''].filter(Boolean);
        up = `[${upName}${parts.length ? ': ' + parts.join(', ') : ''}] `;
      }
    }
    g.out(`${mark} ${name.padEnd(width)} ${shortSha(sha)} ${up}${subject(repo.objects.commits[sha]?.message ?? '')}\n`);
  }
  return 0;
}

// ------------------------------------------------------------------ merge

const UNMERGED =
  "error: Merging is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.";

function refuseIfBusy(repo: Repo, what: string): void {
  if (Object.keys(repo.conflicts).length) throw new GitError(UNMERGED.replace('Merging', what));
  if (repo.op?.kind === 'merge') throw new GitError('fatal: You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.');
  if (repo.op?.kind === 'rebase') throw new GitError('fatal: It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.  If that is the\ncase, please try\n\tgit rebase (--continue | --abort | --skip)');
  if (repo.op) throw new GitError(`error: ${repo.op.kind} is already in progress\nhint: try "git ${repo.op.kind} (--continue | --abort | --quit)"\nfatal: ${repo.op.kind} failed`);
}

function mergeMessage(repo: Repo, name: string): string {
  const cur = currentBranch(repo);
  const into = cur && cur !== 'main' && cur !== 'master' ? ` into ${cur}` : '';
  if (repo.heads[name]) return `Merge branch '${name}'${into}`;
  if (repo.remoteRefs[name]) return `Merge remote-tracking branch '${name}'${into}`;
  if (repo.tags[name]) return `Merge tag '${name}'${into}`;
  return `Merge commit '${name}'${into}`;
}

function statsOutput(repo: Repo, from: FlatTree, to: FlatTree): string {
  const stats = treeStats(repo, from, to);
  return stats.length ? statGraph(stats) + summaryLine(stats) + modeLines(stats) : '';
}

/** Restore the files a failed merge/cherry-pick touched back to HEAD. */
function abortToHead(g: GitCtx, repo: Repo): void {
  const head = headTree(repo);
  const work = readWorktree(g.ctx.vfs, repo);
  for (const f of Object.keys({ ...head, ...repo.index, ...repo.conflicts })) {
    const h = head[f];
    const changed = !sameEntry(h, repo.index[f]) || f in repo.conflicts || (h && (!work[f] || blobSha(work[f].content) !== h.sha));
    if (!changed) continue;
    if (h) writeWorkFile(g.ctx.vfs, repo, f, blobText(repo, h.sha), h.mode);
    else deleteWorkFile(g.ctx.vfs, repo, f);
  }
  repo.index = { ...head };
  repo.conflicts = {};
}

export function doMerge(g: GitCtx, repo: Repo, name: string, opts: { noFf?: boolean; ffOnly?: boolean; squash?: boolean; message?: string; noCommit?: boolean } = {}): number {
  refuseIfBusy(repo, 'Merging');
  const theirs = resolveRev(repo, name);
  if (!theirs) throw new GitError(`merge: ${name} - not something we can merge`, 1);
  const head = headSha(repo);
  const vfs = g.ctx.vfs;
  if (!head) {
    // Merging into an unborn branch just points it at theirs.
    checkoutTree(vfs, repo, commitTree(repo, theirs), 'merge');
    moveHead(repo, theirs, `merge ${name}: Fast-forward`);
    return 0;
  }
  if (isAncestor(repo, theirs, head)) {
    g.out('Already up to date.\n');
    return 0;
  }
  const canFf = isAncestor(repo, head, theirs);
  if (opts.ffOnly && !canFf) {
    throw new GitError(
      "hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nhint: or:\nhint:\nhint: \tgit rebase\nhint:\nhint: Disable this message with \"git config advice.diverging false\"\nfatal: Not possible to fast-forward, aborting.",
    );
  }
  const headT = commitTree(repo, head);
  if (canFf && !opts.noFf) {
    const target = commitTree(repo, theirs);
    checkoutTree(vfs, repo, target, 'merge');
    g.out(`Updating ${shortSha(head)}..${shortSha(theirs)}\nFast-forward\n`);
    if (opts.squash) {
      g.out('Squash commit -- not updating HEAD\n' + statsOutput(repo, headT, target));
      repo.squashMsg = squashMessage(repo, head, theirs);
      return 0;
    }
    moveHead(repo, theirs, `merge ${name}: Fast-forward`);
    g.out(statsOutput(repo, headT, target));
    return 0;
  }
  const base = mergeBase(repo, head, theirs);
  const outcome = mergeTrees(repo, base ? commitTree(repo, base) : {}, headT, commitTree(repo, theirs), 'HEAD', name);
  guardLocalChanges(vfs, repo, outcome, 'merge');
  applyMergeOutcome(vfs, repo, outcome);
  if (outcome.messages.length) g.out(outcome.messages.map((m) => m + '\n').join(''));
  const message = opts.message ?? mergeMessage(repo, name);
  if (Object.keys(outcome.conflicts).length) {
    if (!opts.squash) repo.op = { kind: 'merge', theirs, theirsName: name, message };
    else repo.squashMsg = squashMessage(repo, head, theirs);
    g.out('Automatic merge failed; fix conflicts and then commit the result.\n');
    return 1;
  }
  if (opts.squash) {
    repo.squashMsg = squashMessage(repo, head, theirs);
    g.out('Squash commit -- not updating HEAD\nAutomatic merge went well; stopped before committing as requested\n');
    return 0;
  }
  if (opts.noCommit) {
    repo.op = { kind: 'merge', theirs, theirsName: name, message };
    g.out('Automatic merge went well; stopped before committing as requested\n');
    return 0;
  }
  commitIndex(g.ctx, repo, message, [head, theirs], `merge ${name}`);
  g.out(`Merge made by the 'ort' strategy.\n${statsOutput(repo, headT, repo.index)}`);
  return 0;
}

function squashMessage(repo: Repo, head: string, theirs: string): string {
  const commits = revList(repo, [theirs], [head]);
  return (
    'Squashed commit of the following:\n\n' +
    commits
      .map((s) => {
        const c = repo.objects.commits[s];
        return `commit ${s}\nAuthor: ${c.author.name} <${c.author.email}>\nDate:   ${gitDate(new Date(c.author.time * 1000))}\n\n${c.message
          .replace(/\n$/, '')
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')}\n`;
      })
      .join('\n')
  );
}

export function gitMerge(g: GitCtx): number {
  const p = parseArgs(
    g.args,
    { bool: ['no-ff', 'ff-only', 'ff', 'squash', 'abort', 'continue', 'no-edit', 'edit', 'no-commit', 'commit', 'quit', 'q', 'quiet'], value: ['m', 'message'], alias: { message: 'm' } },
    'usage: git merge [<options>] [<commit>...]',
  );
  const repo = repoOf(g);
  if (p.flags.abort || p.flags.quit) {
    if (repo.op?.kind !== 'merge') throw new GitError('fatal: There is no merge to abort (MERGE_HEAD missing).');
    if (p.flags.abort) abortToHead(g, repo);
    delete repo.op;
    return 0;
  }
  if (p.flags.continue) {
    if (repo.op?.kind !== 'merge') throw new GitError('fatal: There is no merge in progress (MERGE_HEAD missing).');
    return concludeMerge(g, repo);
  }
  let name = p.args[0];
  if (!name) {
    const b = currentBranch(repo);
    const cfg = b ? repo.branches[b] : undefined;
    if (!cfg) throw new GitError('fatal: No remote for the current branch.');
    name = `${cfg.remote}/${cfg.merge.replace(/^refs\/heads\//, '')}`;
  }
  if (name === '-') name = previousBranch(repo);
  if (p.args.length > 1) throw new GitError('devquest: octopus merges (several branches at once) are not simulated; merge one branch at a time', 1);
  return doMerge(g, repo, name, { noFf: !!p.flags['no-ff'], ffOnly: !!p.flags['ff-only'], squash: !!p.flags.squash, message: p.flags.m as string | undefined, noCommit: !!p.flags['no-commit'] });
}

function concludeMerge(g: GitCtx, repo: Repo): number {
  const op = repo.op;
  if (op?.kind !== 'merge') return 0;
  if (Object.keys(repo.conflicts).length) throw new GitError("error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.");
  const head = requireHead(repo);
  const sha = commitIndex(g.ctx, repo, op.message, [head, op.theirs], 'commit (merge)');
  delete repo.op;
  g.out(commitReport(repo, sha));
  return 0;
}

// ------------------------------------------------------------------ rebase

const REBASE_HINT = (s: string) =>
  `error: could not apply ${s}\nhint: Resolve all conflicts manually, mark them as resolved with\nhint: "git add/rm <conflicted_files>", then run "git rebase --continue".\nhint: You can instead skip this commit: run "git rebase --skip".\nhint: To abort and get back to the state before "git rebase", run "git rebase --abort".\nhint: Disable this message with "git config advice.mergeConflict false"\nCould not apply ${s}\n`;

function commitPicked(g: GitCtx, repo: Repo, pick: string, kind: string): string | null {
  const c = repo.objects.commits[pick];
  const head = requireHead(repo);
  const headT = commitTree(repo, head);
  const same = Object.keys({ ...headT, ...repo.index }).every((f) => sameEntry(headT[f], repo.index[f]));
  if (same) return null;
  return commitIndex(g.ctx, repo, c.message, [head], `${kind}: ${subject(c.message)}`.replace(/: [^:]*$/, ''), c.author);
}

function runRebase(g: GitCtx, repo: Repo): number {
  const op = repo.op;
  if (op?.kind !== 'rebase') return 0;
  while (op.todo.length) {
    const pick = op.todo.shift()!;
    op.current = pick;
    const outcome = pickOnto(repo, pick);
    applyMergeOutcome(g.ctx.vfs, repo, outcome);
    if (Object.keys(outcome.conflicts).length) {
      g.out(outcome.messages.map((m) => m + '\n').join(''));
      g.err(REBASE_HINT(describeCommit(repo, pick)));
      return 1;
    }
    const sha = commitPicked(g, repo, pick, 'rebase (pick)');
    if (sha) repo.reflog[repo.reflog.length - 1].message = `rebase (pick): ${subject(repo.objects.commits[pick].message)}`;
    delete op.current;
  }
  const final = headSha(repo)!;
  if (op.branch) {
    repo.heads[op.branch] = final;
    repo.head = { branch: op.branch };
    repo.reflog.push({ sha: final, message: `rebase (finish): returning to refs/heads/${op.branch}` });
    g.note(`Successfully rebased and updated refs/heads/${op.branch}.\n`);
  } else g.note('Successfully rebased and updated detached HEAD.\n');
  delete repo.op;
  return 0;
}

export function startRebase(g: GitCtx, repo: Repo, upstreamName: string): number {
  refuseIfBusy(repo, 'Rebasing');
  const upstream = resolveRev(repo, upstreamName);
  if (!upstream) throw new GitError(`fatal: invalid upstream '${upstreamName}'`);
  const head = requireHead(repo);
  const dirty = dirtyPaths(g.ctx.vfs, repo);
  if (dirty.size) {
    const headT = headTree(repo);
    const staged = [...dirty].some((f) => !sameEntry(headT[f], repo.index[f]));
    throw new GitError(`error: cannot rebase: ${staged ? 'Your index contains uncommitted changes' : 'You have unstaged changes'}.\nerror: Please commit or stash them.`, 1);
  }
  const branch = currentBranch(repo);
  if (isAncestor(repo, upstream, head)) {
    g.out(`Current branch ${branch ?? 'HEAD'} is up to date.\n`);
    return 0;
  }
  const todo = revList(repo, [head], [upstream])
    .filter((s) => repo.objects.commits[s].parents.length < 2)
    .reverse();
  repo.op = { kind: 'rebase', ontoName: upstreamName, onto: upstream, branch, origHead: head, todo };
  checkoutTree(g.ctx.vfs, repo, commitTree(repo, upstream), 'checkout');
  repo.head = { detached: upstream };
  repo.reflog.push({ sha: upstream, message: `rebase (start): checkout ${upstreamName}` });
  return runRebase(g, repo);
}

export function gitRebase(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['continue', 'abort', 'skip', 'quit', 'i', 'interactive', 'q', 'quiet', 'autostash'], value: ['onto'] }, 'usage: git rebase [-i] [options] [--exec <cmd>] [--onto <newbase> | --keep-base] [<upstream> [<branch>]]');
  const repo = repoOf(g);
  if (p.flags.i || p.flags.interactive) {
    throw new GitError('devquest: interactive rebase (git rebase -i) is not simulated yet. To squash your last N commits use\n  git reset --soft HEAD~N && git commit -m "one message"\nor squash a whole branch with git merge --squash.', 1);
  }
  if (p.flags.onto) throw new GitError('devquest: git rebase --onto is not simulated yet', 1);
  const op = repo.op;
  if (p.flags.continue || p.flags.skip || p.flags.abort || p.flags.quit) {
    if (op?.kind !== 'rebase') throw new GitError('fatal: No rebase in progress?');
    if (p.flags.abort || p.flags.quit) {
      if (p.flags.abort) {
        checkoutTree(g.ctx.vfs, repo, commitTree(repo, op.origHead), 'checkout', true);
        if (op.branch) {
          repo.heads[op.branch] = op.origHead;
          repo.head = { branch: op.branch };
        } else repo.head = { detached: op.origHead };
        repo.reflog.push({ sha: op.origHead, message: `rebase (abort): returning to ${op.branch ? `refs/heads/${op.branch}` : op.origHead}` });
      }
      delete repo.op;
      return 0;
    }
    if (p.flags.skip) {
      abortToHead(g, repo);
      delete op.current;
      return runRebase(g, repo);
    }
    const unmerged = Object.keys(repo.conflicts);
    if (unmerged.length) {
      throw new GitError(`${unmerged.map((f) => `${f}: needs merge\n`).join('')}You must edit all merge conflicts and then\nmark them as resolved using git add`, 1);
    }
    if (op.current) {
      commitPicked(g, repo, op.current, 'rebase (continue)');
      delete op.current;
    }
    return runRebase(g, repo);
  }
  let upstream = p.args[0];
  if (!upstream) {
    const b = currentBranch(repo);
    const cfg = b ? repo.branches[b] : undefined;
    if (!cfg) {
      throw new GitError(
        'There is no tracking information for the current branch.\nPlease specify which branch you want to rebase against.\nSee git-rebase(1) for details.\n\n    git rebase \'<branch>\'\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=origin/<branch> ' + (b ?? '<branch>'),
        1,
      );
    }
    upstream = `${cfg.remote}/${cfg.merge.replace(/^refs\/heads\//, '')}`;
  }
  return startRebase(g, repo, upstream);
}

// ------------------------------------------------------------------ cherry-pick / revert

function pickHints(kind: 'cherry-pick' | 'revert', s: string): string {
  return (
    `error: could not ${kind === 'revert' ? 'revert' : 'apply'} ${s}\nhint: After resolving the conflicts, mark them with\nhint: "git add/rm <pathspec>", then run\nhint: "git ${kind} --continue".\n` +
    `hint: You can instead skip this commit with "git ${kind} --skip".\nhint: To abort and get back to the state before "git ${kind}",\nhint: run "git ${kind} --abort".\nhint: Disable this message with "git config advice.mergeConflict false"\n`
  );
}

function pickLike(g: GitCtx, kind: 'cherry-pick' | 'revert'): number {
  const p = parseArgs(g.args, { bool: ['continue', 'abort', 'skip', 'quit', 'no-edit', 'n', 'no-commit', 'x', 'e', 'edit'], value: ['m', 'mainline'], alias: { mainline: 'm', 'no-commit': 'n' } }, `usage: git ${kind} [<options>] <commit-ish>...`);
  const repo = repoOf(g);
  const op = repo.op;
  if (p.flags.continue || p.flags.abort || p.flags.skip || p.flags.quit) {
    if (op?.kind !== kind) throw new GitError(`error: no ${kind} in progress\nfatal: ${kind} failed`);
    if (p.flags.abort || p.flags.skip) abortToHead(g, repo);
    if (p.flags.continue) {
      if (Object.keys(repo.conflicts).length) {
        throw new GitError(`error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\nU ${Object.keys(repo.conflicts).join('\nU ')}\nerror: ${kind} failed`);
      }
      const src = repo.objects.commits[op.commit];
      const sha = commitIndex(g.ctx, repo, op.message, [requireHead(repo)], `${kind}`, kind === 'cherry-pick' ? src.author : undefined);
      g.out(commitReport(repo, sha, { detail: kind === 'cherry-pick' ? ` Date: ${gitDate(new Date(src.author.time * 1000))}\n` : '' }));
    }
    delete repo.op;
    return 0;
  }
  if (!p.args.length) throw new GitError(`usage: git ${kind} [<options>] <commit-ish>...`, 129);
  refuseIfBusy(repo, kind === 'revert' ? 'Reverting' : 'Cherry-picking');
  const head0 = requireHead(repo);
  void head0;
  for (const rev of p.args) {
    const sha = mustResolve(repo, rev);
    const c = repo.objects.commits[sha];
    if (c.parents.length > 1 && p.flags.m === undefined) {
      throw new GitError(`error: commit ${sha} is a merge but no -m option was given.\nfatal: ${kind} failed`);
    }
    let outcome: MergeOutcome;
    if (c.parents.length > 1) {
      const parent = c.parents[Number(p.flags.m) - 1];
      if (!parent) throw new GitError(`error: commit ${sha} does not have parent ${p.flags.m}\nfatal: ${kind} failed`);
      const mine = commitTree(repo, sha);
      const par = commitTree(repo, parent);
      const label = `${shortSha(sha)} (${subject(c.message)})`;
      outcome = kind === 'revert' ? mergeTrees(repo, mine, headTree(repo), par, 'HEAD', `parent of ${label}`) : mergeTrees(repo, par, headTree(repo), mine, 'HEAD', label);
    } else outcome = pickOnto(repo, sha, kind === 'revert');
    guardLocalChanges(g.ctx.vfs, repo, outcome, kind);
    applyMergeOutcome(g.ctx.vfs, repo, outcome);
    const message =
      kind === 'revert'
        ? `Revert "${subject(c.message)}"\n\nThis reverts commit ${sha}.\n`
        : p.flags.x
          ? `${c.message.replace(/\n$/, '')}\n\n(cherry picked from commit ${sha})\n`
          : c.message;
    if (Object.keys(outcome.conflicts).length) {
      repo.op = { kind, commit: sha, message };
      g.out(outcome.messages.map((m) => m + '\n').join(''));
      g.err(pickHints(kind, describeCommit(repo, sha)));
      return 1;
    }
    if (outcome.messages.length) g.out(outcome.messages.map((m) => m + '\n').join(''));
    if (p.flags.n) continue;
    const head = requireHead(repo);
    const headT = commitTree(repo, head);
    if (Object.keys({ ...headT, ...repo.index }).every((f) => sameEntry(headT[f], repo.index[f]))) {
      g.err(`On branch ${currentBranch(repo) ?? 'HEAD'}\nnothing to commit, working tree clean\nThe previous ${kind} is now empty, possibly due to conflict resolution.\n`);
      return 1;
    }
    const newSha = commitIndex(g.ctx, repo, message, [head], kind === 'revert' ? 'revert' : 'cherry-pick', kind === 'cherry-pick' ? c.author : undefined);
    g.out(commitReport(repo, newSha, { detail: kind === 'cherry-pick' ? ` Date: ${gitDate(new Date(c.author.time * 1000))}\n` : '' }));
  }
  return 0;
}

export const gitCherryPick = (g: GitCtx) => pickLike(g, 'cherry-pick');
export const gitRevert = (g: GitCtx) => pickLike(g, 'revert');

// ------------------------------------------------------------------ stash

function stashRef(repo: Repo, arg?: string): number {
  if (!arg) return 0;
  const m = /^(?:stash@\{)?(\d+)\}?$/.exec(arg);
  if (!m || Number(m[1]) >= repo.stash.length) throw new GitError(`error: ${arg} is not a valid reference`, 1);
  return Number(m[1]);
}

function stashId(e: StashEntry): string {
  return sha1(utf8(JSON.stringify(e)));
}

export function gitStash(g: GitCtx): number {
  const [sub0, ...rest] = g.args;
  const known = ['push', 'save', 'list', 'pop', 'apply', 'drop', 'show', 'clear'];
  const sub = !sub0 || sub0.startsWith('-') ? 'push' : sub0;
  const args = !sub0 || sub0.startsWith('-') ? g.args : rest;
  if (!known.includes(sub)) {
    if (sub === 'branch') throw new GitError('devquest: git stash branch is not simulated yet', 1);
    throw new GitError(`error: unknown subcommand: \`${sub}'\nusage: git stash list [<log-options>]\n   or: git stash show [-u | --include-untracked | --only-untracked] [<diff-options>] [<stash>]`, 129);
  }
  const repo = repoOf(g);
  const vfs = g.ctx.vfs;
  switch (sub) {
    case 'push':
    case 'save': {
      const p = parseArgs(args, { bool: ['u', 'include-untracked', 'q', 'quiet', 'k', 'keep-index'], value: ['m', 'message'], alias: { 'include-untracked': 'u', message: 'm', quiet: 'q' } }, 'usage: git stash [push [-u] [-m <message>]]');
      const msg = sub === 'save' ? p.args.join(' ') || undefined : (p.flags.m as string | undefined);
      const head = headSha(repo);
      if (!head) throw new GitError('You do not have the initial commit yet');
      if (Object.keys(repo.conflicts).length) throw new GitError(`${Object.keys(repo.conflicts).map((f) => `${f}: needs merge\n`).join('')}error: could not write index`, 1);
      const headT = commitTree(repo, head);
      const st = computeStatus(vfs, repo, { collapseUntracked: false });
      const untracked = p.flags.u ? st.untracked : [];
      if (!st.staged.length && !st.unstaged.length && !untracked.length) {
        g.out('No local changes to save\n');
        return 0;
      }
      const work = st.worktree;
      const worktree: StashEntry['worktree'] = {};
      for (const f of Object.keys({ ...headT, ...repo.index })) worktree[f] = work[f] ? { content: work[f].content, mode: work[f].mode } : null;
      for (const f of untracked) worktree[f] = { content: work[f].content, mode: work[f].mode };
      const b = currentBranch(repo) ?? '(no branch)';
      const message = msg ? `On ${b}: ${msg}` : `WIP on ${b}: ${describeCommit(repo, head)}`;
      repo.stash.unshift({ message, branch: b, base: head, index: { ...repo.index }, worktree });
      checkoutTree(vfs, repo, headT, 'stash', true);
      for (const f of untracked) deleteWorkFile(vfs, repo, f);
      if (!p.flags.q) g.out(`Saved working directory and index state ${message}\n`);
      return 0;
    }
    case 'list':
      g.out(repo.stash.map((e, i) => `stash@{${i}}: ${e.message}\n`).join(''));
      return 0;
    case 'clear':
      repo.stash = [];
      return 0;
    case 'drop': {
      if (!repo.stash.length) throw new GitError('No stash entries found.', 1);
      const i = stashRef(repo, args[0]);
      const [e] = repo.stash.splice(i, 1);
      g.out(`Dropped stash@{${i}} (${stashId(e)})\n`);
      return 0;
    }
    case 'show': {
      const p = parseArgs(args, { bool: ['p', 'patch', 'stat'] }, 'usage: git stash show [-p] [<stash>]');
      if (!repo.stash.length) throw new GitError('No stash entries found.', 1);
      const e = repo.stash[stashRef(repo, p.args[0])];
      const base = commitTree(repo, e.base);
      const to: FlatTree = {};
      for (const [f, w] of Object.entries(e.worktree)) if (w && base[f] !== undefined) to[f] = { sha: writeBlob(repo.objects, w.content), mode: w.mode };
      for (const [f, w] of Object.entries(e.worktree)) if (w && !base[f] && e.index[f]) to[f] = { sha: writeBlob(repo.objects, w.content), mode: w.mode };
      const after: FlatTree = { ...base };
      for (const f of Object.keys(e.worktree)) {
        if (to[f]) after[f] = to[f];
        else if (e.worktree[f] === null) delete after[f];
      }
      if (p.flags.p || p.flags.patch) {
        g.out(treeDiff(repo, base, after));
      } else g.out(statsOutput(repo, base, after).replace(/ (create|delete) mode .*\n/g, ''));
      return 0;
    }
    case 'apply':
    case 'pop': {
      if (!repo.stash.length) throw new GitError('No stash entries found.', 1);
      const i = stashRef(repo, args.find((a) => !a.startsWith('-')));
      const e = repo.stash[i];
      const head = requireHead(repo);
      const headT = commitTree(repo, head);
      const base = commitTree(repo, e.base);
      const work = readWorktree(vfs, repo);
      const blocked: string[] = [];
      const conflicts: string[] = [];
      for (const [f, w] of Object.entries(e.worktree)) {
        const cur = work[f];
        const headE = headT[f];
        const unchangedLocally = headE ? !!cur && blobSha(cur.content) === headE.sha && sameEntry(repo.index[f], headE) : !cur || (w !== null && cur.content === w.content);
        if (!unchangedLocally) blocked.push(f);
      }
      if (blocked.length) {
        throw new GitError(
          `error: Your local changes to the following files would be overwritten by merge:\n${blocked.map((f) => `\t${f}\n`).join('')}Please commit your changes or stash them before you merge.\nAborting\nThe stash entry is kept in case you need it again.`,
          1,
        );
      }
      const messages: string[] = [];
      for (const [f, w] of Object.entries(e.worktree)) {
        const b = base[f];
        const h = headT[f];
        if (w === null) {
          if (h && sameEntry(h, b)) {
            deleteWorkFile(vfs, repo, f);
            delete repo.index[f];
          }
          continue;
        }
        let content = w.content;
        if (h && b && h.sha !== b.sha) {
          messages.push(`Auto-merging ${f}`);
          const m = merge3(blobText(repo, b.sha), blobText(repo, h.sha), w.content, 'Updated upstream', 'Stashed changes');
          content = m.text;
          if (m.conflicts) {
            conflicts.push(f);
            messages.push(`CONFLICT (content): Merge conflict in ${f}`);
            repo.conflicts[f] = { base: b, ours: h, theirs: { sha: writeBlob(repo.objects, w.content), mode: w.mode } };
            delete repo.index[f];
          }
        }
        writeWorkFile(vfs, repo, f, content, w.mode);
        // Files that were newly added in the stash are added back to the index.
        if (!h && e.index[f] && !b) repo.index[f] = { sha: writeBlob(repo.objects, w.content), mode: w.mode };
      }
      if (messages.length) g.out(messages.map((m) => m + '\n').join(''));
      if (conflicts.length) {
        g.out('On branch ' + (currentBranch(repo) ?? 'HEAD') + '\n');
        g.err('The stash entry is kept in case you need it again.\n');
        return 1;
      }
      g.out(longStatus(g, repo, computeStatus(vfs, repo)));
      if (sub === 'pop') {
        repo.stash.splice(i, 1);
        g.out(`Dropped refs/stash@{${i}} (${stashId(e)})\n`);
      }
      return 0;
    }
  }
  return 0;
}

