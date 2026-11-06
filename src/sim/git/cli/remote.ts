/** git clone, remote, fetch, pull, push — against simulated remotes (no network). */
import { basename, joinPath, resolvePath } from '../../vfs/path';
import { firePush, PushUpdate } from '../hooks';
import type { SimState } from '../../state';
import { copyReachable, shortSha } from '../objects';
import { checkoutTree } from '../ops';
import { commitTree, currentBranch, gitState, GitError, headSha, isAncestor, newRepo, revList, resolveRev } from '../repo';
import type { Repo } from '../types';
import { doMerge, startRebase } from './branch';
import { GitCtx, parseArgs, repoOf } from './common';

/** CI runs on the hosting side: pushes from a CI runner still belong to the learner's world. */
const hostState = (s: SimState): SimState => s.runner?.host ?? s;

const NOT_A_REPO = (name: string) =>
  `fatal: '${name}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`;

function isUrl(s: string): boolean {
  return /^[a-z+]+:\/\//.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);
}

/** Find the simulated repository behind a URL or local path. */
export function lookupRemote(g: GitCtx, url: string): Repo | null {
  const gs = gitState(g.ctx.state);
  if (isUrl(url)) {
    const norm = (u: string) => u.replace(/\/$/, '').replace(/\.git$/, '');
    const key = Object.keys(gs.remotes).find((k) => norm(k) === norm(url));
    return key ? gs.remotes[key] : null;
  }
  const abs = resolvePath(g.ctx.state.cwd, url);
  return gs.remotes[abs] ?? gs.remotes[abs + '.git'] ?? gs.repos[abs] ?? null;
}

function notFound(url: string): GitError {
  if (/^https?:\/\//.test(url)) return new GitError(`remote: Repository not found.\nfatal: repository '${url.replace(/\/?$/, '/')}' not found`);
  if (isUrl(url)) return new GitError('ERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.');
  return new GitError(NOT_A_REPO(url));
}

function remoteHeadBranch(remote: Repo): string | null {
  if ('branch' in remote.head && remote.heads[remote.head.branch]) return remote.head.branch;
  const names = Object.keys(remote.heads);
  return names.includes('main') ? 'main' : names[0] ?? null;
}

function progress(count: number, verb: 'Receiving' | 'Writing'): string {
  const n = Math.max(3, count * 3);
  return verb === 'Receiving'
    ? `remote: Enumerating objects: ${n}, done.\nremote: Counting objects: 100% (${n}/${n}), done.\nremote: Compressing objects: 100% (${Math.ceil(n / 2)}/${Math.ceil(n / 2)}), done.\nremote: Total ${n} (delta 0), reused ${n} (delta 0), pack-reused 0\nReceiving objects: 100% (${n}/${n}), done.\n`
    : `Enumerating objects: ${n}, done.\nCounting objects: 100% (${n}/${n}), done.\nDelta compression using up to 2 threads\nCompressing objects: 100% (${Math.ceil(n / 2)}/${Math.ceil(n / 2)}), done.\nWriting objects: 100% (${n}/${n}), ${n * 97} bytes | ${n * 97} KiB/s, done.\nTotal ${n} (delta 0), reused 0 (delta 0), pack-reused 0\n`;
}

// ------------------------------------------------------------------ clone

export function gitClone(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['q', 'quiet', 'bare'], value: ['b', 'branch', 'depth', 'o', 'origin'], alias: { branch: 'b', quiet: 'q', origin: 'o' } }, 'usage: git clone [<options>] [--] <repo> [<dir>]');
  const [url, dirArg] = p.args;
  if (!url) throw new GitError('fatal: You must specify a repository to clone.\n\nusage: git clone [<options>] [--] <repo> [<dir>]', 129);
  const { ctx } = g;
  const dirName = dirArg ?? basename(url.replace(/\/$/, '').replace(/^.*[:/]/, '')).replace(/\.git$/, '');
  const dir = resolvePath(ctx.state.cwd, dirName);
  if (ctx.vfs.exists(dir) && (!ctx.vfs.isDir(dir) || ctx.vfs.readdir(dir).length)) {
    throw new GitError(`fatal: destination path '${dirArg ?? dirName}' already exists and is not an empty directory.`);
  }
  const remote = lookupRemote(g, url);
  if (!p.flags.q) g.note(`Cloning into '${dirArg ?? dirName}'...\n`);
  if (!remote) throw notFound(url);
  const remoteName = (p.flags.o as string) ?? 'origin';
  const head = p.flags.b ? (p.flags.b as string) : remoteHeadBranch(remote);
  if (p.flags.b && !remote.heads[head!]) throw new GitError(`warning: Could not find remote branch ${head} to clone.\nfatal: Remote branch ${head} not found in upstream ${remoteName}`);
  const repo = newRepo(dir, head ?? 'main');
  for (const sha of [...Object.values(remote.heads), ...Object.values(remote.tags)]) copyReachable(remote.objects, repo.objects, sha);
  for (const [b, sha] of Object.entries(remote.heads)) repo.remoteRefs[`${remoteName}/${b}`] = sha;
  if (head) repo.remoteRefs[`${remoteName}/HEAD`] = remote.heads[head];
  repo.tags = { ...remote.tags };
  // Local clones remember the absolute path, like real git.
  repo.remotes[remoteName] = { url: isUrl(url) ? url : resolvePath(ctx.state.cwd, url) };
  ctx.vfs.mkdir(dir, { parents: true });
  ctx.vfs.mkdir(joinPath(dir, '.git'));
  gitState(ctx.state).repos[dir] = repo;
  if (head && remote.heads[head]) {
    repo.heads[head] = remote.heads[head];
    repo.branches[head] = { remote: remoteName, merge: `refs/heads/${head}` };
    checkoutTree(ctx.vfs, repo, commitTree(repo, remote.heads[head]), 'checkout', true);
    repo.reflog.push({ sha: remote.heads[head], message: `clone: from ${url}` });
    if (!p.flags.q && isUrl(url)) g.note(progress(Object.keys(repo.objects.commits).length, 'Receiving'));
    else if (!p.flags.q) g.note('done.\n');
  } else if (!p.flags.q) g.note('warning: You appear to have cloned an empty repository.\n');
  return 0;
}

// ------------------------------------------------------------------ remote

export function gitRemote(g: GitCtx): number {
  const repo = repoOf(g);
  const [sub, ...rest] = g.args;
  if (!sub || sub === '-v' || sub === '--verbose') {
    for (const [name, r] of Object.entries(repo.remotes)) g.out(sub ? `${name}\t${r.url} (fetch)\n${name}\t${r.url} (push)\n` : `${name}\n`);
    return 0;
  }
  switch (sub) {
    case 'add': {
      const [name, url] = rest;
      if (!name || !url) throw new GitError('usage: git remote add [<options>] <name> <url>', 129);
      if (repo.remotes[name]) throw new GitError(`error: remote ${name} already exists.`, 3);
      repo.remotes[name] = { url };
      return 0;
    }
    case 'remove':
    case 'rm': {
      const [name] = rest;
      if (!repo.remotes[name]) throw new GitError(`error: No such remote: '${name}'`, 2);
      delete repo.remotes[name];
      for (const r of Object.keys(repo.remoteRefs)) if (r.startsWith(name + '/')) delete repo.remoteRefs[r];
      for (const [b, cfg] of Object.entries(repo.branches)) if (cfg.remote === name) delete repo.branches[b];
      return 0;
    }
    case 'rename': {
      const [from, to] = rest;
      if (!repo.remotes[from]) throw new GitError(`error: No such remote: '${from}'`, 2);
      if (repo.remotes[to]) throw new GitError(`error: remote ${to} already exists.`, 3);
      repo.remotes[to] = repo.remotes[from];
      delete repo.remotes[from];
      for (const r of Object.keys(repo.remoteRefs)) {
        if (r.startsWith(from + '/')) {
          repo.remoteRefs[to + r.slice(from.length)] = repo.remoteRefs[r];
          delete repo.remoteRefs[r];
        }
      }
      for (const cfg of Object.values(repo.branches)) if (cfg.remote === from) cfg.remote = to;
      return 0;
    }
    case 'set-url':
    case 'get-url': {
      const [name, url] = rest;
      if (!repo.remotes[name]) throw new GitError(`error: No such remote '${name}'`, 2);
      if (sub === 'get-url') g.out(repo.remotes[name].url + '\n');
      else repo.remotes[name].url = url;
      return 0;
    }
    case 'show': {
      const [name] = rest;
      const r = repo.remotes[name];
      if (!r) throw new GitError(NOT_A_REPO(name));
      const remote = lookupRemote(g, r.url);
      g.out(`* remote ${name}\n  Fetch URL: ${r.url}\n  Push  URL: ${r.url}\n  HEAD branch: ${remote ? remoteHeadBranch(remote) ?? '(unknown)' : '(unknown)'}\n`);
      return 0;
    }
  }
  throw new GitError(`error: unknown subcommand: \`${sub}'\nusage: git remote [-v | --verbose]\n   or: git remote add [-t <branch>] [-m <master>] [-f] [--tags | --no-tags] [--mirror=<fetch|push>] <name> <url>`, 129);
}

// ------------------------------------------------------------------ fetch

function defaultRemote(repo: Repo): string {
  const b = currentBranch(repo);
  if (b && repo.branches[b]) return repo.branches[b].remote;
  if (repo.remotes.origin) return 'origin';
  const names = Object.keys(repo.remotes);
  if (names.length === 1) return names[0];
  throw new GitError('fatal: No remote repository specified.  Please, specify either a URL or a\nremote name from which new revisions should be fetched.');
}

function connect(g: GitCtx, repo: Repo, name: string): { url: string; remote: Repo } {
  const cfg = repo.remotes[name];
  const url = cfg?.url ?? name;
  const remote = lookupRemote(g, url);
  if (!cfg && !remote) throw new GitError(NOT_A_REPO(name));
  if (!remote) throw notFound(url);
  return { url, remote };
}

/** Update remote-tracking refs from a remote; returns the report lines. */
export function fetchFrom(g: GitCtx, repo: Repo, name: string, prune = false): void {
  const { url, remote } = connect(g, repo, name);
  const lines: string[] = [];
  const width = Math.max(10, ...Object.keys(remote.heads).map((b) => b.length), ...Object.keys(remote.tags).map((t) => t.length));
  const pad = (s: string) => s.padEnd(width);
  let newCommits = 0;
  for (const [b, sha] of Object.entries(remote.heads).sort()) {
    const ref = `${name}/${b}`;
    const old = repo.remoteRefs[ref];
    if (old === sha) continue;
    newCommits += revList(remote, [sha], old && remote.objects.commits[old] ? [old] : []).length;
    copyReachable(remote.objects, repo.objects, sha);
    if (!old) lines.push(` * [new branch]      ${pad(b)} -> ${ref}`);
    else if (isAncestor(repo, old, sha)) lines.push(`   ${shortSha(old)}..${shortSha(sha)}  ${pad(b)} -> ${ref}`);
    else lines.push(` + ${shortSha(old)}...${shortSha(sha)} ${pad(b)} -> ${ref}  (forced update)`);
    repo.remoteRefs[ref] = sha;
  }
  for (const [t, sha] of Object.entries(remote.tags)) {
    if (repo.tags[t]) continue;
    copyReachable(remote.objects, repo.objects, sha);
    repo.tags[t] = sha;
    lines.push(` * [new tag]         ${pad(t)} -> ${t}`);
  }
  if (prune) {
    for (const r of Object.keys(repo.remoteRefs)) {
      if (!r.startsWith(name + '/') || r.endsWith('/HEAD')) continue;
      if (!remote.heads[r.slice(name.length + 1)]) {
        lines.push(` - [deleted]         ${pad('(none)')} -> ${r}`);
        delete repo.remoteRefs[r];
      }
    }
  }
  const head = remoteHeadBranch(remote);
  if (head) repo.remoteRefs[`${name}/HEAD`] = remote.heads[head];
  if (lines.length) g.note((newCommits ? progress(newCommits, 'Receiving').replace(/Receiving.*\n/, '') + `Unpacking objects: 100% (${newCommits * 3}/${newCommits * 3}), done.\n` : '') + `From ${url}\n${lines.join('\n')}\n`);
}

export function gitFetch(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['all', 'p', 'prune', 'q', 'quiet', 'tags', 'v'], alias: { prune: 'p', quiet: 'q' } }, 'usage: git fetch [<options>] [<repository> [<refspec>...]]');
  const repo = repoOf(g);
  const names = p.flags.all ? Object.keys(repo.remotes) : [p.args[0] ?? defaultRemote(repo)];
  for (const n of names) fetchFrom(g, repo, n, !!p.flags.p);
  return 0;
}

// ------------------------------------------------------------------ pull

const DIVERGENT =
  'hint: You have divergent branches and need to specify how to reconcile them.\nhint: You can do so by running one of the following commands sometime before\nhint: your next pull:\nhint:\n' +
  'hint:   git config pull.rebase false  # merge\nhint:   git config pull.rebase true   # rebase\nhint:   git config pull.ff only       # fast-forward only\nhint:\n' +
  'hint: You can replace "git config" with "git config --global" to set a default\nhint: preference for all repositories. You can also pass --rebase, --no-rebase,\nhint: or --ff-only on the command line to override the configured default per\nhint: invocation.\nfatal: Need to specify how to reconcile divergent branches.';

export function gitPull(g: GitCtx): number {
  const p = parseArgs(g.args, { bool: ['rebase', 'r', 'no-rebase', 'ff-only', 'no-ff', 'q', 'quiet', 'no-edit'], alias: { r: 'rebase', quiet: 'q' } }, 'usage: git pull [<options>] [<repository> [<refspec>...]]');
  const { ctx } = g;
  const repo = repoOf(g);
  const b = currentBranch(repo);
  let remoteName = p.args[0];
  let branch = p.args[1];
  if (!remoteName) {
    const cfg = b ? repo.branches[b] : undefined;
    if (!cfg) {
      throw new GitError(
        `There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.\n\n    git pull <remote> <branch>\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=origin/<branch> ${b ?? '<branch>'}\n`,
        1,
      );
    }
    remoteName = cfg.remote;
    branch = cfg.merge.replace(/^refs\/heads\//, '');
  }
  if (!branch) throw new GitError('devquest: specify the branch too, e.g. git pull origin main', 1);
  fetchFrom(g, repo, remoteName, false);
  const upstream = `${remoteName}/${branch}`;
  const theirs = resolveRev(repo, upstream);
  if (!theirs) throw new GitError(`fatal: couldn't find remote ref ${branch}`);
  const head = headSha(repo);
  const cfgRebase = ctx.state && (repo.config['pull.rebase'] ?? undefined);
  const wantRebase = p.flags.rebase || (!p.flags['no-rebase'] && cfgRebase === 'true');
  if (head && !isAncestor(repo, theirs, head) && !isAncestor(repo, head, theirs)) {
    if (wantRebase) return startRebase(g, repo, upstream);
    if (p.flags['ff-only'] || repo.config['pull.ff'] === 'only') {
      throw new GitError('hint: Diverging branches can\'t be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nhint: or:\nhint:\nhint: \tgit rebase\nhint:\nhint: Disable this message with "git config advice.diverging false"\nfatal: Not possible to fast-forward, aborting.');
    }
    if (!p.flags['no-rebase'] && cfgRebase === undefined) throw new GitError(DIVERGENT);
  }
  if (wantRebase && head) return startRebase(g, repo, upstream);
  return doMerge(g, repo, upstream, { noFf: !!p.flags['no-ff'], message: `Merge branch '${branch}' of ${repo.remotes[remoteName]?.url ?? remoteName}${b && b !== 'main' && b !== 'master' ? ` into ${b}` : ''}` });
}

// ------------------------------------------------------------------ push

export function gitPush(g: GitCtx): number {
  const p = parseArgs(
    g.args,
    { bool: ['u', 'set-upstream', 'f', 'force', 'force-with-lease', 'tags', 'all', 'd', 'delete', 'q', 'quiet', 'n', 'dry-run'], alias: { 'set-upstream': 'u', force: 'f', delete: 'd', quiet: 'q', 'dry-run': 'n' } },
    'usage: git push [<options>] [<repository> [<refspec>...]]',
  );
  const repo = repoOf(g);
  const b = currentBranch(repo);
  let remoteName = p.args[0];
  let refspecs = p.args.slice(1);
  if (!remoteName) {
    if (!Object.keys(repo.remotes).length) {
      throw new GitError(
        'fatal: No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    git remote add <name> <url>\n\nand then push using the remote name\n\n    git push <name>\n',
      );
    }
    const cfg = b ? repo.branches[b] : undefined;
    if (!cfg && !p.flags.tags && !p.flags.all) {
      if (!b) throw new GitError('fatal: You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)\nstate now, use\n\n    git push origin HEAD:<name-of-remote-branch>\n');
      throw new GitError(
        `fatal: The current branch ${b} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin ${b}\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.\n`,
      );
    }
    remoteName = cfg?.remote ?? defaultRemote(repo);
    if (cfg) refspecs = [`${b}:${cfg.merge.replace(/^refs\/heads\//, '')}`];
  }
  const { url, remote } = connect(g, repo, remoteName);
  if (!refspecs.length) {
    if (p.flags.all) refspecs = Object.keys(repo.heads);
    else if (!p.flags.tags) {
      const cfg = b ? repo.branches[b] : undefined;
      if (!b) throw new GitError('fatal: You are not currently on a branch.');
      refspecs = [cfg && cfg.remote === remoteName ? `${b}:${cfg.merge.replace(/^refs\/heads\//, '')}` : b];
    }
  }
  if (p.flags.tags) refspecs.push(...Object.keys(repo.tags).map((t) => `refs/tags/${t}`));
  const lines: string[] = [];
  const rejected: { line: string; why: 'fetch first' | 'non-fast-forward' | 'stale info' | 'protected' }[] = [];
  let sent = 0;
  const upstreamSet: string[] = [];
  const updates: PushUpdate[] = [];
  for (const spec of refspecs) {
    const force = p.flags.f || spec.startsWith('+');
    const [srcRaw, dstRaw] = spec.replace(/^\+/, '').split(':');
    const isTag = srcRaw.startsWith('refs/tags/') || (!!repo.tags[srcRaw] && !repo.heads[srcRaw]);
    const src = srcRaw.replace(/^refs\/(heads|tags)\//, '');
    const dst = (dstRaw ?? (srcRaw === 'HEAD' ? b ?? '' : src)).replace(/^refs\/(heads|tags)\//, '');
    if (p.flags.d || (srcRaw === '' && dstRaw)) {
      const target = p.flags.d ? src : dst;
      if (!remote.heads[target]) throw new GitError(`error: unable to delete '${target}': remote ref does not exist\nerror: failed to push some refs to '${url}'`, 1);
      delete remote.heads[target];
      delete repo.remoteRefs[`${remoteName}/${target}`];
      lines.push(` - [deleted]         ${target}`);
      continue;
    }
    if (isTag) {
      const sha = repo.tags[src];
      if (!sha) throw new GitError(`error: src refspec ${src} does not match any\nerror: failed to push some refs to '${url}'`, 1);
      if (remote.tags[src] === sha) continue;
      copyReachable(repo.objects, remote.objects, sha);
      remote.tags[src] = sha;
      if (!p.flags['dry-run']) updates.push({ tag: src, after: sha });
      lines.push(` * [new tag]         ${src} -> ${src}`);
      sent++;
      continue;
    }
    const sha = srcRaw === 'HEAD' ? headSha(repo) : repo.heads[src] ?? resolveRev(repo, src);
    if (!sha) throw new GitError(`error: src refspec ${src} does not match any\nerror: failed to push some refs to '${url}'`, 1);
    const old = remote.heads[dst];
    const label = `${src === 'HEAD' ? 'HEAD' : src} -> ${dst}`;
    if (old === sha) continue;
    if (remote.protectedBranches?.includes(dst) && !p.flags['dry-run']) {
      rejected.push({ line: ` ! [remote rejected] ${label} (protected branch hook declined)`, why: 'protected' });
      continue;
    }
    if (old && p.flags['force-with-lease'] && repo.remoteRefs[`${remoteName}/${dst}`] !== old) {
      rejected.push({ line: ` ! [rejected]        ${label} (stale info)`, why: 'stale info' });
      continue;
    }
    if (old && !force && !p.flags['force-with-lease'] && !(repo.objects.commits[old] && isAncestor(repo, old, sha))) {
      const known = !!repo.objects.commits[old];
      rejected.push({ line: ` ! [rejected]        ${label} (${known ? 'non-fast-forward' : 'fetch first'})`, why: known ? 'non-fast-forward' : 'fetch first' });
      continue;
    }
    sent += revList(repo, [sha], old && repo.objects.commits[old] ? [old] : []).length;
    if (!p.flags['dry-run']) {
      copyReachable(repo.objects, remote.objects, sha);
      remote.heads[dst] = sha;
      repo.remoteRefs[`${remoteName}/${dst}`] = sha;
      updates.push({ branch: dst, before: old, after: sha });
    }
    if (!old) lines.push(` * [new branch]      ${label}`);
    else if (isAncestor(repo, old, sha)) lines.push(`   ${shortSha(old)}..${shortSha(sha)}  ${label}`);
    else lines.push(` + ${shortSha(old)}...${shortSha(sha)} ${label} (forced update)`);
    if (p.flags.u && src !== 'HEAD') upstreamSet.push(src);
    else if (p.flags.u && b) upstreamSet.push(b);
    if (p.flags.u) repo.branches[upstreamSet[upstreamSet.length - 1]] = { remote: remoteName, merge: `refs/heads/${dst}` };
  }
  if (!lines.length && !rejected.length) {
    g.note('Everything up-to-date\n');
    return 0;
  }
  if (rejected.length) {
    const why = rejected[0].why;
    let hint = '';
    if (why === 'fetch first') {
      hint =
        "hint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: 'git pull' before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.\n";
    } else if (why === 'non-fast-forward') {
      hint =
        "hint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. If you want to integrate the remote changes,\nhint: use 'git pull' before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.\n";
    }
    const pre = why === 'protected' ? 'remote: error: GH006: Protected branch update failed for refs/heads/' + rejected[0].line.split('-> ')[1].split(' ')[0] + '.\nremote: error: Changes must be made through a pull request.\n' : '';
    g.err(`${pre}To ${url}\n${[...lines, ...rejected.map((r) => r.line)].join('\n')}\nerror: failed to push some refs to '${url}'\n${hint}`);
    firePush(hostState(g.ctx.state), url, remote, updates);
    return 1;
  }
  g.note(`${sent ? progress(sent, 'Writing') : ''}To ${url}\n${lines.join('\n')}\n`);
  for (const u of upstreamSet) g.out(`branch '${u}' set up to track '${remoteName}/${repo.branches[u].merge.replace(/^refs\/heads\//, '')}'.\n`);
  firePush(hostState(g.ctx.state), url, remote, updates);
  return 0;
}
