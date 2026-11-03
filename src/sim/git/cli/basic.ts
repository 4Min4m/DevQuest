/** git init, config, status, add, rm, mv, commit, restore, reset. */
import { joinPath, resolvePath } from '../../vfs/path';
import { blobSha, shortSha, subject, writeBlob } from '../objects';
import { checkoutTree, commitIndex, commitReport, requireHead, sameEntry, blobText } from '../ops';
import {
  ancestors,
  computeStatus,
  configValue,
  currentBranch,
  deleteWorkFile,
  displayPath,
  formatConfig,
  gitState,
  globalConfigPath,
  GitError,
  headSha,
  headTree,
  ignoreRules,
  inSpec,
  isClean,
  isIgnored,
  moveHead,
  mustResolve,
  newRepo,
  parseConfig,
  readWorktree,
  repoPath,
  resolveRev,
  revList,
  Status,
  commitTree,
  writeWorkFile,
  findRepo,
} from '../repo';
import type { FlatTree, Repo } from '../types';
import { GitCtx, parseArgs, repoOf } from './common';

// ------------------------------------------------------------------ init

const MASTER_HINT =
  "hint: Using 'master' as the name for the initial branch. This default branch name\n" +
  'hint: is subject to change. To configure the initial branch name to use in all\n' +
  'hint: of your new repositories, which will suppress this warning, call:\nhint:\n' +
  'hint: \tgit config --global init.defaultBranch <name>\nhint:\n' +
  "hint: Names commonly chosen instead of 'master' are 'main', 'trunk' and\n" +
  "hint: 'development'. The just-created branch can be renamed via this command:\nhint:\n" +
  'hint: \tgit branch -m <name>\n';

export function gitInit(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['bare', 'q', 'quiet'], value: ['b', 'initial-branch'], alias: { b: 'initial-branch', q: 'quiet' } }, 'usage: git init [-q | --quiet] [--bare] [-b <branch-name>] [<directory>]');
  const { ctx } = g;
  const dir = resolvePath(ctx.state.cwd, p.args[0] ?? '.');
  try {
    if (!ctx.vfs.exists(dir)) ctx.vfs.mkdir(dir, { parents: true });
  } catch (e) {
    throw new GitError(`fatal: cannot mkdir ${p.args[0] ?? dir}: ${(e as Error).message}`);
  }
  const bare = !!p.flags.bare;
  const gs = gitState(ctx.state);
  const gitDir = bare ? dir : joinPath(dir, '.git');
  const existing = bare ? gs.remotes[dir] : gs.repos[dir];
  if (existing && ctx.vfs.exists(gitDir)) {
    if (!p.flags.quiet) g.out(`Reinitialized existing Git repository in ${gitDir}/\n`);
    return 0;
  }
  let branch = p.flags['initial-branch'] as string | undefined;
  if (!branch) {
    branch = configValue(ctx, null, 'init.defaultBranch');
    if (!branch) {
      branch = 'master';
      g.note(MASTER_HINT);
    }
  }
  const repo = newRepo(dir, branch, bare);
  if (bare) gs.remotes[dir] = repo;
  else gs.repos[dir] = repo;
  ctx.vfs.mkdir(gitDir, { parents: true });
  if (!p.flags.quiet) g.out(`Initialized empty Git repository in ${gitDir}/\n`);
  return 0;
}

// ------------------------------------------------------------------ config

export function gitConfig(g: GitCtx): number {
  const p = parseArgs(
    g.args,
    { bool: ['global', 'local', 'list', 'l', 'unset', 'get', 'show-origin'], alias: { l: 'list' } },
    'usage: git config [<options>]',
  );
  const { ctx } = g;
  const repo = findRepo(ctx.state, ctx.vfs, ctx.state.cwd);
  const path = globalConfigPath(ctx.state);
  const readGlobal = () => {
    try {
      return parseConfig(ctx.vfs.readFile(path));
    } catch {
      return {};
    }
  };
  if (p.flags.list) {
    const lines: string[] = [];
    if (!p.flags.local) for (const [k, v] of Object.entries(readGlobal())) lines.push(`${k}=${v}`);
    if (repo && !p.flags.global) {
      lines.push('core.repositoryformatversion=0', 'core.filemode=true', 'core.bare=false');
      for (const [k, v] of Object.entries(repo.config)) lines.push(`${k}=${v}`);
      for (const [n, r] of Object.entries(repo.remotes)) lines.push(`remote.${n}.url=${r.url}`, `remote.${n}.fetch=+refs/heads/*:refs/remotes/${n}/*`);
      for (const [n, b] of Object.entries(repo.branches)) lines.push(`branch.${n}.remote=${b.remote}`, `branch.${n}.merge=${b.merge}`);
    }
    g.out(lines.map((l) => l + '\n').join(''));
    return 0;
  }
  const [key, value] = p.args;
  if (!key) throw new GitError('usage: git config [<options>]\n\nConfig file location\n    --global              use global config file\n    --local               use repository config file', 129);
  if (!key.includes('.')) throw new GitError(`error: key does not contain a section: ${key}`, 2);
  const k = key.toLowerCase();
  const local = !p.flags.global && (p.flags.local || value !== undefined || p.flags.unset) ? true : false;
  if (local && !p.flags.global && !repo && (value !== undefined || p.flags.unset)) throw new GitError('fatal: not in a git directory', 128);
  if (value === undefined && !p.flags.unset) {
    const v = p.flags.global ? readGlobal()[k] : p.flags.local ? repo?.config[k] : configValue(ctx, repo, k);
    if (v === undefined) return 1;
    g.out(v + '\n');
    return 0;
  }
  if (p.flags.global) {
    const cfg = readGlobal();
    if (p.flags.unset) {
      if (!(k in cfg)) return 5;
      delete cfg[k];
    } else cfg[k] = value!;
    ctx.vfs.writeFile(path, formatConfig(cfg));
    return 0;
  }
  if (p.flags.unset) {
    if (!(k in repo!.config)) return 5;
    delete repo!.config[k];
  } else repo!.config[k] = value!;
  return 0;
}

// ------------------------------------------------------------------ status

function upstreamInfo(repo: Repo): { name: string; ahead: number; behind: number } | null | 'gone' {
  const b = currentBranch(repo);
  if (!b || !repo.branches[b]) return null;
  const cfg = repo.branches[b];
  const name = `${cfg.remote}/${cfg.merge.replace(/^refs\/heads\//, '')}`;
  const up = repo.remoteRefs[name];
  const local = repo.heads[b];
  if (!up) return 'gone';
  if (!local) return { name, ahead: 0, behind: 0 };
  return { name, ahead: revList(repo, [local], [up]).length, behind: revList(repo, [up], [local]).length };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function trackingText(repo: Repo): string {
  const u = upstreamInfo(repo);
  if (!u) return '';
  if (u === 'gone') {
    const b = currentBranch(repo)!;
    const cfg = repo.branches[b];
    return `Your branch is based on '${cfg.remote}/${cfg.merge.replace(/^refs\/heads\//, '')}', but the upstream is gone.\n  (use "git branch --unset-upstream" to fixup)\n`;
  }
  if (!u.ahead && !u.behind) return `Your branch is up to date with '${u.name}'.\n`;
  if (u.ahead && !u.behind) return `Your branch is ahead of '${u.name}' by ${plural(u.ahead, 'commit')}.\n  (use "git push" to publish your local commits)\n`;
  if (!u.ahead) return `Your branch is behind '${u.name}' by ${plural(u.behind, 'commit')}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)\n`;
  return `Your branch and '${u.name}' have diverged,\nand have ${u.ahead} and ${u.behind} different commits each, respectively.\n  (use "git pull" if you want to integrate the remote branch with yours)\n`;
}

export function longStatus(g: GitCtx, repo: Repo, st: Status): string {
  const cwd = g.ctx.state.cwd;
  const d = (p: string) => displayPath(repo, cwd, p);
  let out = '';
  const b = currentBranch(repo);
  const op = repo.op;
  if (b) out += `On branch ${b}\n`;
  else if (op?.kind === 'rebase') out += `interactive rebase in progress; onto ${shortSha(op.onto)}\n`.replace('interactive ', '');
  else out += `HEAD detached at ${shortSha(headSha(repo)!)}\n`;
  if (b) {
    const tracking = trackingText(repo);
    out += tracking;
    if (tracking && op) out += '\n';
  }
  if (op?.kind === 'rebase' && !b) {
    out = `rebase in progress; onto ${shortSha(op.onto)}\n`;
    out += `You are currently rebasing ${op.branch ? `branch '${op.branch}'` : 'detached HEAD'} on '${shortSha(op.onto)}'.\n`;
    out += st.conflicted.length
      ? '  (fix conflicts and then run "git rebase --continue")\n  (use "git rebase --skip" to skip this patch)\n  (use "git rebase --abort" to check out the original branch)\n'
      : '  (all conflicts fixed: run "git rebase --continue")\n';
    out += '\n';
  } else if (op?.kind === 'merge') {
    out += st.conflicted.length
      ? 'You have unmerged paths.\n  (fix conflicts and run "git commit")\n  (use "git merge --abort" to abort the merge)\n\n'
      : 'All conflicts fixed but you are still merging.\n  (use "git commit" to conclude merge)\n\n';
  } else if (op?.kind === 'cherry-pick' || op?.kind === 'revert') {
    const verb = op.kind === 'cherry-pick' ? 'cherry-picking' : 'reverting';
    out += `You are currently ${verb} commit ${shortSha(op.commit)}.\n`;
    out += st.conflicted.length
      ? `  (fix conflicts and run "git ${op.kind} --continue")\n  (use "git ${op.kind} --skip" to skip this patch)\n  (use "git ${op.kind} --abort" to cancel the ${op.kind} operation)\n\n`
      : `  (all conflicts fixed: run "git ${op.kind} --continue")\n  (use "git ${op.kind} --skip" to skip this patch)\n  (use "git ${op.kind} --abort" to cancel the ${op.kind} operation)\n\n`;
  } else if (b && repo.branches[b]) out += '\n';
  const unborn = !headSha(repo);
  if (unborn) out += '\nNo commits yet\n\n';
  if (st.staged.length) {
    out += `Changes to be committed:\n  (use "git ${unborn ? 'rm --cached' : 'restore --staged'} <file>..." to unstage)\n`;
    for (const s of st.staged) out += `\t${(s.kind + ':').padEnd(12)}${s.from ? `${d(s.from)} -> ` : ''}${d(s.path)}\n`;
    out += '\n';
  }
  if (st.conflicted.length) {
    out += 'Unmerged paths:\n  (use "git add <file>..." to mark resolution)\n';
    for (const c of st.conflicted) out += `\t${(c.kind + ':').padEnd(17)}${d(c.path)}\n`;
    out += '\n';
  }
  if (st.unstaged.length) {
    const anyDeleted = st.unstaged.some((u) => u.kind === 'deleted');
    out += `Changes not staged for commit:\n  (use "git ${anyDeleted ? 'add/rm' : 'add'} <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n`;
    for (const u of st.unstaged) out += `\t${(u.kind + ':').padEnd(12)}${d(u.path)}\n`;
    out += '\n';
  }
  if (st.untracked.length) {
    out += 'Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n';
    for (const u of st.untracked) out += `\t${d(u)}\n`;
    out += '\n';
  }
  if (st.conflicted.length) return out;
  if (!st.staged.length) {
    if (st.unstaged.length) out += 'no changes added to commit (use "git add" and/or "git commit -a")\n';
    else if (st.untracked.length) out += 'nothing added to commit but untracked files present (use "git add" to track)\n';
    else if (unborn) out += 'nothing to commit (create/copy files and use "git add" to track)\n';
    else out += 'nothing to commit, working tree clean\n';
  }
  return out;
}

function shortStatus(g: GitCtx, repo: Repo, st: Status, branch: boolean): string {
  const d = (p: string) => displayPath(repo, g.ctx.state.cwd, p);
  let out = '';
  if (branch) {
    const b = currentBranch(repo);
    if (!b) out += '## HEAD (no branch)\n';
    else if (!headSha(repo)) out += `## No commits yet on ${b}\n`;
    else {
      const u = upstreamInfo(repo);
      let line = `## ${b}`;
      if (u && u !== 'gone') {
        line += `...${u.name}`;
        const parts = [u.ahead ? `ahead ${u.ahead}` : '', u.behind ? `behind ${u.behind}` : ''].filter(Boolean);
        if (parts.length) line += ` [${parts.join(', ')}]`;
      } else if (u === 'gone') line += ` [gone]`;
      out += line + '\n';
    }
  }
  const rows = new Map<string, [string, string, string]>();
  for (const s of st.staged) {
    const code = s.kind === 'new file' ? 'A' : s.kind === 'deleted' ? 'D' : s.kind === 'renamed' ? 'R' : 'M';
    rows.set(s.path, [code, ' ', s.from ? `${d(s.from)} -> ${d(s.path)}` : d(s.path)]);
  }
  for (const u of st.unstaged) {
    const r = rows.get(u.path) ?? [' ', ' ', d(u.path)];
    r[1] = u.kind === 'deleted' ? 'D' : 'M';
    rows.set(u.path, r);
  }
  for (const c of st.conflicted) {
    const code = c.kind === 'both modified' ? 'UU' : c.kind === 'both added' ? 'AA' : c.kind === 'deleted by them' ? 'UD' : 'DU';
    rows.set(c.path, [code[0], code[1], d(c.path)]);
  }
  for (const [, r] of [...rows].sort(([a], [b]) => (a < b ? -1 : 1))) out += `${r[0]}${r[1]} ${r[2]}\n`;
  for (const u of st.untracked) out += `?? ${d(u)}\n`;
  return out;
}

export function gitStatus(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['s', 'short', 'b', 'branch', 'porcelain', 'u', 'untracked-files'], alias: { s: 'short', b: 'branch' } }, 'usage: git status [<options>] [--] [<pathspec>...]');
  const repo = repoOf(g);
  const st = computeStatus(g.ctx.vfs, repo, { collapseUntracked: !p.flags.u });
  if (p.flags.short || p.flags.porcelain) g.out(shortStatus(g, repo, st, !!p.flags.branch));
  else g.out(longStatus(g, repo, st));
  return 0;
}

// ------------------------------------------------------------------ add / rm / mv

export function gitAdd(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['A', 'all', 'u', 'update', 'f', 'force', 'v', 'verbose', 'n', 'dry-run', 'p', 'patch'], alias: { A: 'all', u: 'update', f: 'force', v: 'verbose', n: 'dry-run' } }, 'usage: git add [<options>] [--] <pathspec>...');
  if (p.flags.p) throw new GitError('devquest: interactive staging (git add -p) is not simulated; stage whole files with git add <file>', 1);
  const repo = repoOf(g);
  const cwd = g.ctx.state.cwd;
  let specs = [...p.args, ...p.paths].map((a) => repoPath(repo, cwd, a));
  if (!specs.length) {
    if (p.flags.all || p.flags.update) specs = [''];
    else {
      g.out("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\nhint: Disable this message with \"git config advice.addEmptyPathspec false\"\n");
      return 0;
    }
  }
  const work = readWorktree(g.ctx.vfs, repo);
  const rules = ignoreRules(work);
  const ignoredNamed: string[] = [];
  for (const [i, spec] of specs.entries()) {
    const raw = [...p.args, ...p.paths][i] ?? '.';
    const wPaths = Object.keys(work).filter((f) => inSpec(f, spec));
    const tracked = Object.keys(repo.index).filter((f) => inSpec(f, spec));
    const conflicted = Object.keys(repo.conflicts).filter((f) => inSpec(f, spec));
    if (!wPaths.length && !tracked.length && !conflicted.length) throw new GitError(`fatal: pathspec '${raw}' did not match any files`);
    let matched = 0;
    for (const f of wPaths) {
      const ignored = !(f in repo.index) && !(f in repo.conflicts) && isIgnored(rules, f);
      if (ignored && !p.flags.force) {
        if (f === spec) ignoredNamed.push(raw);
        continue;
      }
      if (p.flags.update && !(f in repo.index) && !(f in repo.conflicts)) continue;
      matched++;
      if (p.flags['dry-run']) {
        g.out(`add '${displayPath(repo, cwd, f)}'\n`);
        continue;
      }
      const sha = writeBlob(repo.objects, work[f].content);
      if (p.flags.verbose && repo.index[f]?.sha !== sha) g.out(`add '${displayPath(repo, cwd, f)}'\n`);
      repo.index[f] = { sha, mode: work[f].mode };
      delete repo.conflicts[f];
    }
    for (const f of [...tracked, ...conflicted]) {
      if (!work[f]) {
        matched++;
        if (p.flags['dry-run']) continue;
        delete repo.index[f];
        delete repo.conflicts[f];
      }
    }
    if (!matched && wPaths.length && !ignoredNamed.length && spec !== '' && !p.flags.update) {
      // Everything matching was ignored (e.g. `git add logs/`).
      ignoredNamed.push(raw);
    }
  }
  if (ignoredNamed.length) {
    g.err(`The following paths are ignored by one of your .gitignore files:\n${ignoredNamed.join('\n')}\nhint: Use -f if you really want to add them.\nhint: Disable this message with "git config advice.addIgnoredFile false"\n`);
    return 1;
  }
  return 0;
}

export function gitRm(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['cached', 'r', 'f', 'force', 'q', 'quiet', 'n', 'dry-run'], alias: { f: 'force', q: 'quiet', n: 'dry-run' } }, 'usage: git rm [<options>] [--] <file>...');
  const repo = repoOf(g);
  const cwd = g.ctx.state.cwd;
  const raw = [...p.args, ...p.paths];
  if (!raw.length) throw new GitError('usage: git rm [<options>] [--] <file>...', 129);
  const head = headTree(repo);
  const work = readWorktree(g.ctx.vfs, repo);
  const targets: string[] = [];
  for (const a of raw) {
    const spec = repoPath(repo, cwd, a);
    const hits = Object.keys(repo.index).filter((f) => inSpec(f, spec));
    if (!hits.length) throw new GitError(`fatal: pathspec '${a}' did not match any files`);
    if (!p.flags.r && !hits.includes(spec)) throw new GitError(`fatal: not removing '${a}' recursively without -r`);
    targets.push(...hits);
  }
  if (!p.flags.force) {
    const staged = targets.filter((f) => head[f] && !sameEntry(head[f], repo.index[f]) && work[f] && blobSha(work[f].content) !== repo.index[f].sha);
    const local = targets.filter((f) => work[f] && blobSha(work[f].content) !== repo.index[f].sha && !staged.includes(f));
    const stagedOnly = targets.filter((f) => !sameEntry(head[f], repo.index[f]) && !local.includes(f) && !staged.includes(f));
    if (!p.flags.cached && (local.length || staged.length)) {
      const list = local.length ? local : staged;
      throw new GitError(
        `error: the following file${list.length > 1 ? 's have' : ' has'} ${local.length ? 'local modifications' : 'staged content different from both the\nfile and the HEAD'}:\n${list.map((f) => `    ${displayPath(repo, cwd, f)}\n`).join('')}(use --cached to keep the file, or -f to force removal)`,
        1,
      );
    }
    if (!p.flags.cached && stagedOnly.length) {
      throw new GitError(
        `error: the following file${stagedOnly.length > 1 ? 's have' : ' has'} changes staged in the index:\n${stagedOnly.map((f) => `    ${displayPath(repo, cwd, f)}\n`).join('')}(use --cached to keep the file, or -f to force removal)`,
        1,
      );
    }
  }
  for (const f of targets) {
    if (!p.flags.quiet) g.out(`rm '${f}'\n`);
    if (p.flags['dry-run']) continue;
    delete repo.index[f];
    if (!p.flags.cached) deleteWorkFile(g.ctx.vfs, repo, f);
  }
  return 0;
}

export function gitMv(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['f', 'force', 'n', 'dry-run'] }, 'usage: git mv [<options>] <source>... <destination>');
  const repo = repoOf(g);
  const cwd = g.ctx.state.cwd;
  if (p.args.length !== 2) throw new GitError('usage: git mv [<options>] <source>... <destination>', 129);
  const [srcArg, dstArg] = p.args;
  const src = repoPath(repo, cwd, srcArg);
  let dst = repoPath(repo, cwd, dstArg);
  const vfs = g.ctx.vfs;
  const dstAbs = joinPath(repo.root, dst);
  if (vfs.exists(dstAbs) && vfs.isDir(dstAbs)) dst = dst ? `${dst}/${src.split('/').pop()}` : src.split('/').pop()!;
  const moved = Object.keys(repo.index).filter((f) => inSpec(f, src));
  if (!moved.length) throw new GitError(`fatal: not under version control, source=${src}, destination=${dst}`);
  if (repo.index[dst] && !p.flags.f) throw new GitError(`fatal: destination exists, source=${src}, destination=${dst}`);
  const work = readWorktree(vfs, repo);
  for (const f of moved) {
    const to = dst + f.slice(src.length);
    repo.index[to] = repo.index[f];
    delete repo.index[f];
    const w = work[f];
    if (w) {
      writeWorkFile(vfs, repo, to, w.content, w.mode);
      deleteWorkFile(vfs, repo, f);
    }
  }
  return 0;
}

// ------------------------------------------------------------------ commit

const NO_EDITOR = 'devquest: the commit message editor is not simulated — use git commit -m "your message"';

export function gitCommit(g: GitCtx): number {
  const p = parseArgs(
    g.args,
    { bool: ['a', 'all', 'amend', 'no-edit', 'allow-empty', 'q', 'quiet', 'v', 'verbose'], value: ['m', 'message', 'F', 'C'], alias: { a: 'all', m: 'message', q: 'quiet' } },
    'usage: git commit [<options>] [--] <pathspec>...',
  );
  const { ctx } = g;
  const repo = repoOf(g);
  const vfs = ctx.vfs;
  if (Object.keys(repo.conflicts).length) {
    throw new GitError(
      'error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add/rm <file>\'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.',
    );
  }
  if (p.flags.all) {
    const work = readWorktree(vfs, repo);
    for (const f of Object.keys(repo.index)) {
      const w = work[f];
      if (!w) delete repo.index[f];
      else repo.index[f] = { sha: writeBlob(repo.objects, w.content), mode: w.mode };
    }
  }
  const head = headSha(repo);
  const msgs = p.multi.message ?? [];
  let message = msgs.length ? msgs.join('\n\n') : undefined;
  const op = repo.op;
  if (p.flags.amend) {
    if (!head) throw new GitError('fatal: You have nothing to amend.');
    if (op?.kind === 'merge') throw new GitError('fatal: You are in the middle of a merge -- cannot amend.');
    const old = repo.objects.commits[head];
    if (message === undefined) {
      if (!p.flags['no-edit']) throw new GitError(NO_EDITOR + ' (or --amend --no-edit to keep the message)', 1);
      message = old.message;
    }
    if (!message.trim()) throw new GitError('Aborting commit due to empty commit message.', 1);
    const sha = commitIndex(ctx, repo, message, old.parents, 'commit (amend)', old.author);
    if (!p.flags.quiet) {
      const d = new Date(old.author.time * 1000);
      g.out(commitReport(repo, sha, { root: !old.parents.length, detail: ` Date: ${gitDate(d)}\n` }));
    }
    return 0;
  }
  if (message === undefined) {
    if (op?.kind === 'merge' || op?.kind === 'cherry-pick' || op?.kind === 'revert') message = op.message;
    else if (repo.squashMsg) message = repo.squashMsg;
    else throw new GitError(NO_EDITOR, 1);
  }
  if (!message.trim()) throw new GitError('Aborting commit due to empty commit message.', 1);
  const headT = headTree(repo);
  const changed = Object.keys({ ...headT, ...repo.index }).some((f) => !sameEntry(headT[f], repo.index[f]));
  if (!changed && !p.flags['allow-empty'] && op?.kind !== 'merge') {
    const st = computeStatus(vfs, repo);
    g.out(longStatus(g, repo, st));
    return 1;
  }
  let parents = head ? [head] : [];
  let kind = head ? 'commit' : 'commit (initial)';
  if (op?.kind === 'merge') {
    parents = [head!, op.theirs];
    kind = 'commit (merge)';
  }
  const sha = commitIndex(ctx, repo, message, parents, kind);
  if (op && op.kind !== 'rebase') delete repo.op;
  delete repo.squashMsg;
  if (!p.flags.quiet) g.out(commitReport(repo, sha, { root: !head }));
  return 0;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Git's default date format: "Tue Nov 3 09:00:01 2026 +0000". */
export function gitDate(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()} +0000`;
}

// ------------------------------------------------------------------ restore / reset

function matchPaths(repo: Repo, cwd: string, raw: string[], universe: string[]): string[] {
  const out = new Set<string>();
  for (const a of raw) {
    const spec = repoPath(repo, cwd, a);
    const hits = universe.filter((f) => inSpec(f, spec));
    if (!hits.length) throw new GitError(`error: pathspec '${a}' did not match any file(s) known to git`, 1);
    hits.forEach((h) => out.add(h));
  }
  return [...out];
}

export function gitRestore(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['staged', 'S', 'worktree', 'W', 'ours', 'theirs'], value: ['source', 's'], alias: { S: 'staged', W: 'worktree', s: 'source' } }, 'usage: git restore [<options>] [--source=<branch>] <file>...');
  const repo = repoOf(g);
  const vfs = g.ctx.vfs;
  const raw = [...p.args, ...p.paths];
  if (!raw.length) throw new GitError('fatal: you must specify path(s) to restore');
  const staged = !!p.flags.staged;
  const worktree = !!p.flags.worktree || !staged;
  const sourceRev = p.flags.source as string | undefined;
  const source: FlatTree | null = sourceRev ? commitTree(repo, mustResolve(repo, sourceRev)) : staged ? headTree(repo) : null;
  const universe = Object.keys({ ...repo.index, ...headTree(repo), ...(source ?? {}), ...repo.conflicts });
  const paths = matchPaths(repo, g.ctx.state.cwd, raw, universe);
  for (const f of paths) {
    if (staged) {
      const e = source![f];
      if (e) repo.index[f] = e;
      else delete repo.index[f];
    }
    if (worktree) {
      const c = repo.conflicts[f];
      if (c && (p.flags.ours || p.flags.theirs)) {
        const side = p.flags.ours ? c.ours : c.theirs;
        if (side) writeWorkFile(vfs, repo, f, blobText(repo, side.sha), side.mode);
        continue;
      }
      if (c) throw new GitError(`error: path '${f}' is unmerged`, 1);
      const e = (sourceRev ? source! : repo.index)[f];
      if (e) writeWorkFile(vfs, repo, f, blobText(repo, e.sha), e.mode);
      else deleteWorkFile(vfs, repo, f);
    }
  }
  return 0;
}

export function gitReset(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['soft', 'mixed', 'hard', 'merge', 'keep', 'q', 'quiet'], alias: { q: 'quiet' } }, 'usage: git reset [--mixed | --soft | --hard | --merge | --keep] [-q] [<commit>]');
  const { ctx } = g;
  const repo = repoOf(g);
  const vfs = ctx.vfs;
  let rev = 'HEAD';
  let paths = [...p.paths];
  const rest = [...p.args];
  if (rest.length && (p.dashdash || resolveRev(repo, rest[0]))) rev = rest.shift()!;
  paths = [...rest, ...paths];
  if (paths.length) {
    if (p.flags.soft || p.flags.hard) throw new GitError(`fatal: Cannot do ${p.flags.soft ? 'soft' : 'hard'} reset with paths.`);
    const tree = headSha(repo) ? commitTree(repo, mustResolve(repo, rev)) : {};
    const universe = Object.keys({ ...repo.index, ...tree });
    for (const f of matchPaths(repo, ctx.state.cwd, paths, universe)) {
      if (tree[f]) repo.index[f] = tree[f];
      else delete repo.index[f];
    }
    printUnstaged(g, repo);
    return 0;
  }
  const target = mustResolve(repo, rev);
  const tree = commitTree(repo, target);
  if (p.flags.hard) {
    checkoutTree(vfs, repo, tree, 'reset', true);
  } else if (!p.flags.soft) {
    repo.index = { ...tree };
    repo.conflicts = {};
  }
  moveHead(repo, target, `reset: moving to ${rev}`);
  if (repo.op && repo.op.kind !== 'rebase') delete repo.op;
  delete repo.squashMsg;
  if (p.flags.hard) {
    if (!p.flags.quiet) g.out(`HEAD is now at ${shortSha(target)} ${subject(repo.objects.commits[target].message)}\n`);
  } else if (!p.flags.soft && !p.flags.quiet) printUnstaged(g, repo);
  return 0;
}

function printUnstaged(g: GitCtx, repo: Repo): void {
  const st = computeStatus(g.ctx.vfs, repo);
  if (!st.unstaged.length) return;
  g.out('Unstaged changes after reset:\n' + st.unstaged.map((u) => `${u.kind === 'deleted' ? 'D' : 'M'}\t${displayPath(repo, g.ctx.state.cwd, u.path)}\n`).join(''));
}

/** Commits reachable from HEAD that no branch or tag points at (for detached-HEAD warnings). */
export function orphanedCommits(repo: Repo, from: string): string[] {
  const reachable = new Set<string>();
  for (const s of [...Object.values(repo.heads), ...Object.values(repo.tags), ...Object.values(repo.remoteRefs)]) for (const a of ancestors(repo, s)) reachable.add(a);
  return revList(repo, [from]).filter((s) => !reachable.has(s));
}

export { requireHead, isClean };
