/** Validator checks for Git missions: they inspect the simulated repositories directly. */
import { commitTree, computeStatus, currentBranch, resolveRev, revList } from '../sim/git';
import type { Repo } from '../sim/git/types';
import type { SimState } from '../sim/state';
import { normalize } from '../sim/vfs/path';
import { Vfs } from '../sim/vfs/vfs';
import type { Check } from './types';

export type GitCheck = Extract<
  Check,
  { type: 'gitRepo' | 'gitBranch' | 'gitHead' | 'gitClean' | 'gitCommit' | 'gitFile' | 'gitHistory' | 'gitTracked' | 'gitRemote' | 'gitStash' }
>;

const rootVfs = (state: SimState) => new Vfs(state.fs, { name: 'root', groups: ['root'] });

function repoAt(state: SimState, path: string): Repo | undefined {
  const root = normalize(path);
  const repo = state.git?.repos[root];
  if (!repo || !rootVfs(state).exists(root + '/.git')) return undefined;
  return repo;
}

function remoteAt(state: SimState, url: string): Repo | undefined {
  const norm = (u: string) => u.replace(/\/$/, '').replace(/\.git$/, '');
  const key = Object.keys(state.git?.remotes ?? {}).find((k) => norm(k) === norm(url));
  return key ? state.git!.remotes[key] : undefined;
}

function fileAt(repo: Repo, ref: string, file: string): string | undefined {
  const sha = resolveRev(repo, ref);
  if (!sha) return undefined;
  const e = commitTree(repo, sha)[file];
  return e ? repo.objects.blobs[e.sha] ?? '' : undefined;
}

function historyOf(repo: Repo, ref: string): string[] {
  const sha = resolveRev(repo, ref);
  return sha ? revList(repo, [sha]) : [];
}

function contentMatches(content: string | undefined, c: { text?: string; regex?: string; absent?: boolean }): boolean {
  if (c.absent) return content === undefined;
  if (content === undefined) return false;
  if (c.text !== undefined && !content.includes(c.text)) return false;
  if (c.regex !== undefined && !new RegExp(c.regex).test(content)) return false;
  return true;
}

export function evaluateGit(check: GitCheck, state: SimState): boolean {
  if (check.type === 'gitRemote') {
    const remote = remoteAt(state, check.url);
    if (!remote) return false;
    if (check.tag) {
      const t = remote.tags[check.tag];
      if (!t) return check.exists === false;
      if (check.exists === false) return false;
      if (check.branch) {
        const target = remote.objects.tags[t]?.object ?? t;
        return remote.heads[check.branch] === target;
      }
      return true;
    }
    const branch = check.branch ?? 'main';
    if (!remote.heads[branch]) return check.exists === false;
    if (check.exists === false) return false;
    const history = historyOf(remote, branch);
    if (check.pattern !== undefined && !history.some((s) => new RegExp(check.pattern!, 'm').test(remote.objects.commits[s].message))) return false;
    if (check.linear && history.some((s) => remote.objects.commits[s].parents.length > 1)) return false;
    if (check.file !== undefined && !contentMatches(fileAt(remote, branch, check.file), { text: check.text, regex: check.regex, absent: check.absent })) return false;
    return true;
  }
  const repo = repoAt(state, check.path);
  if (!repo) return false;
  switch (check.type) {
    case 'gitRepo':
      return true;
    case 'gitBranch':
      return (check.name in repo.heads) === (check.exists ?? true);
    case 'gitHead':
      return currentBranch(repo) === check.branch;
    case 'gitClean': {
      if (repo.op) return false;
      const st = computeStatus(rootVfs(state), repo);
      return !st.staged.length && !st.unstaged.length && !st.conflicted.length && (check.untracked !== false || !st.untracked.length);
    }
    case 'gitCommit': {
      const history = historyOf(repo, check.ref ?? 'HEAD');
      const shas = check.tipOnly ? history.slice(0, 1) : history;
      return shas.some((s) => new RegExp(check.pattern, 'm').test(repo.objects.commits[s].message));
    }
    case 'gitFile':
      return contentMatches(fileAt(repo, check.ref ?? 'HEAD', check.file), check);
    case 'gitHistory': {
      const history = historyOf(repo, check.ref ?? 'HEAD');
      const merges = history.filter((s) => repo.objects.commits[s].parents.length > 1).length;
      if (check.count !== undefined && history.length !== check.count) return false;
      if (check.minCount !== undefined && history.length < check.minCount) return false;
      if (check.linear && merges) return false;
      if (check.minMerges !== undefined && merges < check.minMerges) return false;
      return history.length > 0;
    }
    case 'gitTracked': {
      const inIndex = check.file in repo.index;
      const headSha = resolveRev(repo, 'HEAD');
      const inHead = headSha ? check.file in commitTree(repo, headSha) : false;
      return check.tracked === false ? !inIndex && !inHead : inIndex;
    }
    case 'gitStash':
      return repo.stash.length === check.count;
  }
}

export function describeGit(check: GitCheck): string {
  switch (check.type) {
    case 'gitRepo':
      return `\`${check.path}\` should be a Git repository`;
    case 'gitBranch':
      return `branch \`${check.name}\` should ${check.exists === false ? 'be deleted' : 'exist'}`;
    case 'gitHead':
      return `you should be on branch \`${check.branch}\``;
    case 'gitClean':
      return `the repository should be clean (\`git status\`: nothing to commit${check.untracked === false ? ', no untracked files' : ''})`;
    case 'gitCommit':
      return `${check.ref ?? 'HEAD'} should ${check.tipOnly ? 'be' : 'include'} a commit matching \`${check.pattern}\``;
    case 'gitFile':
      return check.absent ? `\`${check.file}\` should not exist at ${check.ref ?? 'HEAD'}` : `\`${check.file}\` at ${check.ref ?? 'HEAD'} should have the expected content`;
    case 'gitHistory':
      return `the history of ${check.ref ?? 'HEAD'} should ${check.linear ? 'be linear (no merge commits)' : 'have the expected shape'}`;
    case 'gitTracked':
      return `\`${check.file}\` should ${check.tracked === false ? 'not be tracked by Git' : 'be tracked by Git'}`;
    case 'gitRemote':
      return check.tag ? `the remote should have tag \`${check.tag}\`` : `the remote branch \`${check.branch ?? 'main'}\` should have the expected commits`;
    case 'gitStash':
      return `the stash should have ${check.count} entr${check.count === 1 ? 'y' : 'ies'}`;
  }
}

export const GIT_CHECK_TYPES = ['gitRepo', 'gitBranch', 'gitHead', 'gitClean', 'gitCommit', 'gitFile', 'gitHistory', 'gitTracked', 'gitRemote', 'gitStash'] as const;
