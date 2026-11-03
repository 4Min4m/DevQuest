/** Git data model. Everything is plain JSON so it lives inside SimState. */

export type FileMode = '100644' | '100755';

export interface TreeEntry {
  name: string;
  mode: FileMode | '040000';
  sha: string;
}

export interface Person {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export interface AnnotatedTag {
  object: string;
  tag: string;
  tagger: Person;
  message: string;
}

export interface ObjectStore {
  blobs: Record<string, string>;
  trees: Record<string, TreeEntry[]>;
  commits: Record<string, Commit>;
  tags: Record<string, AnnotatedTag>;
}

/** A flattened tree or the index: path → blob. */
export type FlatTree = Record<string, { sha: string; mode: FileMode }>;

export type Head = { branch: string } | { detached: string };

export interface ReflogEntry {
  sha: string;
  message: string;
}

export interface StashEntry {
  /** "WIP on main: abc1234 message" or the -m message. */
  message: string;
  branch: string;
  base: string;
  index: FlatTree;
  /** Tracked working-tree content (and untracked files with -u). */
  worktree: Record<string, { content: string; mode: FileMode } | null>;
}

/** Three versions of a conflicted path (missing = deleted on that side). */
export interface Conflict {
  base?: { sha: string; mode: FileMode };
  ours?: { sha: string; mode: FileMode };
  theirs?: { sha: string; mode: FileMode };
}

export type Operation =
  | { kind: 'merge'; theirs: string; theirsName: string; message: string }
  | { kind: 'cherry-pick' | 'revert'; commit: string; message: string }
  | {
      kind: 'rebase';
      ontoName: string;
      onto: string;
      /** Branch being rebased (null when HEAD was detached). */
      branch: string | null;
      origHead: string;
      /** Commits still to apply, oldest first. */
      todo: string[];
      /** The commit currently being applied (stopped on conflict). */
      current?: string;
    };

export interface BranchConfig {
  remote: string;
  merge: string;
}

export interface Repo {
  /** Absolute path of the working tree (the directory containing .git). */
  root: string;
  bare?: boolean;
  objects: ObjectStore;
  heads: Record<string, string>;
  tags: Record<string, string>;
  /** Remote-tracking branches: "origin/main" → sha. */
  remoteRefs: Record<string, string>;
  head: Head;
  index: FlatTree;
  conflicts: Record<string, Conflict>;
  remotes: Record<string, { url: string }>;
  branches: Record<string, BranchConfig>;
  /** Repo-local `git config` values ("user.name" → "Ada"). */
  config: Record<string, string>;
  /** HEAD reflog, oldest first. */
  reflog: ReflogEntry[];
  stash: StashEntry[];
  op?: Operation;
  /** Branches a hosted remote refuses direct pushes to (like GitHub branch protection). */
  protectedBranches?: string[];
  /** Set by `git merge --squash` until the next commit. */
  squashMsg?: string;
}

export interface GitState {
  /** Working-tree repositories by root path. */
  repos: Record<string, Repo>;
  /** Simulated remotes by URL (or absolute path for local bare repos). */
  remotes: Record<string, Repo>;
}
