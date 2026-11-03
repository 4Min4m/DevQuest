import type { CommandContext, CommandDef } from '../shell/types';
import { resolvePath } from '../vfs/path';
import { gitAdd, gitCommit, gitConfig, gitInit, gitMv, gitReset, gitRestore, gitRm, gitStatus } from './cli/basic';
import { gitBranch, gitCheckout, gitCherryPick, gitMerge, gitRebase, gitRevert, gitStash, gitSwitch } from './cli/branch';
import type { GitCtx } from './cli/common';
import { gitCatFile, gitClean, gitDiff, gitHashObject, gitLog, gitLsFiles, gitReflog, gitRevParse, gitShow, gitTag } from './cli/history';
import { gitClone, gitFetch, gitPull, gitPush, gitRemote } from './cli/remote';
import { isVfsError } from '../vfs/types';
import { findRepo, GitError, setConfigOverrides, syncGitDir } from './repo';

export type * from './types';
export { findRepo, resolveRev, commitTree, headSha, currentBranch, computeStatus, gitState, isAncestor, revList, newRepo } from './repo';

const COMMANDS: Record<string, (g: GitCtx) => number> = {
  init: gitInit,
  config: gitConfig,
  status: gitStatus,
  add: gitAdd,
  rm: gitRm,
  mv: gitMv,
  commit: gitCommit,
  restore: gitRestore,
  reset: gitReset,
  log: gitLog,
  show: gitShow,
  diff: gitDiff,
  reflog: gitReflog,
  tag: gitTag,
  clean: gitClean,
  branch: gitBranch,
  switch: gitSwitch,
  checkout: gitCheckout,
  merge: gitMerge,
  rebase: gitRebase,
  'cherry-pick': gitCherryPick,
  revert: gitRevert,
  stash: gitStash,
  clone: gitClone,
  remote: gitRemote,
  fetch: gitFetch,
  pull: gitPull,
  push: gitPush,
  'cat-file': gitCatFile,
  'hash-object': gitHashObject,
  'rev-parse': gitRevParse,
  'ls-files': gitLsFiles,
};

const NOT_SIMULATED = new Set([
  'bisect', 'submodule', 'worktree', 'blame', 'filter-branch', 'filter-repo', 'gc', 'fsck', 'bundle', 'am', 'apply',
  'format-patch', 'notes', 'sparse-checkout', 'lfs', 'grep', 'describe', 'shortlog', 'archive', 'request-pull', 'gui',
  'citool', 'difftool', 'mergetool', 'range-diff', 'maintenance', 'prune', 'repack', 'switch-branch', 'show-branch', 'whatchanged',
]);

const HELP = `usage: git [-v | --version] [-h | --help] <command> [<args>]

These are common Git commands used in various situations:

start a working area
   clone     Clone a repository into a new directory
   init      Create an empty Git repository or reinitialize an existing one

work on the current change
   add       Add file contents to the index
   mv        Move or rename a file, a directory, or a symlink
   restore   Restore working tree files
   rm        Remove files from the working tree and from the index

examine the history and state
   diff      Show changes between commits, commit and working tree, etc
   log       Show commit logs
   show      Show various types of objects
   status    Show the working tree status

grow, mark and tweak your common history
   branch    List, create, or delete branches
   commit    Record changes to the repository
   merge     Join two or more development histories together
   rebase    Reapply commits on top of another base tip
   reset     Reset current HEAD to the specified state
   switch    Switch branches
   tag       Create, list, delete or verify a tag object signed with GPG

collaborate
   fetch     Download objects and refs from another repository
   pull      Fetch from and integrate with another repository or a local branch
   push      Update remote refs along with associated objects

also simulated: checkout, cherry-pick, revert, stash, reflog, remote, config, clean,
cat-file, hash-object, rev-parse, ls-files
`;

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
}

export const git: CommandDef = {
  name: 'git',
  summary: 'the version control system (simulated, offline)',
  run(ctx) {
    const argv = [...ctx.args];
    const cfg: Record<string, string> = {};
    let dir: string | undefined;
    while (argv[0] === '-c' || argv[0] === '-C') {
      const flag = argv.shift();
      const v = argv.shift();
      if (v === undefined) {
        ctx.err(`error: switch \`${flag!.slice(1)}' requires a value\n`);
        return 129;
      }
      if (flag === '-C') dir = resolvePath(ctx.state.cwd, v);
      else {
        const eq = v.indexOf('=');
        cfg[(eq < 0 ? v : v.slice(0, eq)).toLowerCase()] = eq < 0 ? 'true' : v.slice(eq + 1);
      }
    }
    if (dir !== undefined) {
      if (!ctx.vfs.exists(dir) || !ctx.vfs.isDir(dir)) {
        ctx.err(`fatal: cannot change to '${dir}': No such file or directory\n`);
        return 128;
      }
      const saved = ctx.state.cwd;
      ctx.state.cwd = dir;
      try {
        return runGit(ctx, argv, cfg);
      } finally {
        ctx.state.cwd = saved;
      }
    }
    return runGit(ctx, argv, cfg);
  },
};

function runGit(ctx: CommandContext, argv: string[], cfg: Record<string, string>): number {
  const [sub, ...args] = argv;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    ctx.out(HELP);
    return sub ? 0 : 1;
  }
  if (sub === '--version' || sub === '-v' || sub === 'version') {
    ctx.out('git version 2.43.0\n');
    return 0;
  }
  const handler = COMMANDS[sub];
  if (!handler) {
    if (NOT_SIMULATED.has(sub)) {
      ctx.err(`devquest: 'git ${sub}' is a real git command, but it is not simulated yet\n`);
      return 1;
    }
    const near = Object.keys(COMMANDS).filter((c) => distance(c, sub) <= 2);
    ctx.err(`git: '${sub}' is not a git command. See 'git --help'.\n${near.length ? `\nThe most similar command${near.length > 1 ? 's are' : ' is'}\n${near.map((n) => `\t${n}\n`).join('')}` : ''}`);
    return 1;
  }
  const g: GitCtx = { ctx, args, out: ctx.out, err: ctx.err, note: ctx.note };
  let code: number;
  setConfigOverrides(cfg);
  try {
    code = handler(g);
  } catch (e) {
    if (isVfsError(e)) {
      ctx.err(`fatal: ${e.path ? `could not write '${e.path}'` : 'filesystem error'}: ${e.message}\n`);
      code = 128;
    } else {
      if (!(e instanceof GitError)) throw e;
      ctx.err(e.message.endsWith('\n') ? e.message : e.message + '\n');
      code = e.code;
    }
  }
  setConfigOverrides({});
  const repo = findRepo(ctx.state, ctx.vfs, ctx.state.cwd);
  if (repo) syncGitDir(ctx.vfs, repo);
  return code;
}

export const gitCommands = [git];
