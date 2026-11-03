import type { CommandContext } from '../../shell/types';
import { findRepo, GitError, notARepo } from '../repo';
import type { Repo } from '../types';

export interface ParsedArgs {
  flags: Record<string, string | true>;
  /** Repeatable value flags (e.g. -m twice). */
  multi: Record<string, string[]>;
  args: string[];
  /** Arguments after `--`. */
  paths: string[];
  dashdash: boolean;
}

export interface ArgSpec {
  /** Boolean flags, short ("a") or long ("amend"). */
  bool?: string[];
  /** Flags taking a value. */
  value?: string[];
  /** Aliases: "-b" → "branch" style mapping of short to long names. */
  alias?: Record<string, string>;
}

/** getopt-style parsing for git subcommands: -am "msg", --message=x, --, combined short flags. */
export function parseArgs(argv: string[], spec: ArgSpec, usage: string): ParsedArgs {
  const bool = new Set(spec.bool ?? []);
  const value = new Set(spec.value ?? []);
  const alias = spec.alias ?? {};
  const out: ParsedArgs = { flags: {}, multi: {}, args: [], paths: [], dashdash: false };
  const set = (name: string, v: string | true) => {
    const key = alias[name] ?? name;
    out.flags[key] = v;
    if (typeof v === 'string') (out.multi[key] ??= []).push(v);
  };
  const unknown = (name: string): never => {
    throw new GitError(`error: unknown ${name.length === 1 ? 'switch' : 'option'} \`${name}'\n${usage}`, 129);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (out.dashdash) {
      out.paths.push(a);
      continue;
    }
    if (a === '--') {
      out.dashdash = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (value.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new GitError(`error: option \`${name}' requires a value\n${usage}`, 129);
        set(name, v);
      } else if (bool.has(name) && eq < 0) set(name, true);
      else unknown(name);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (value.has(c)) {
          const rest = a.slice(k + 1);
          const v = rest || argv[++i];
          if (v === undefined) throw new GitError(`error: switch \`${c}' requires a value\n${usage}`, 129);
          set(c, v);
          break;
        }
        if (bool.has(c)) set(c, true);
        else unknown(c);
      }
      continue;
    }
    if (/^-\d+$/.test(a) && value.has('n')) {
      set('n', a.slice(1));
      continue;
    }
    out.args.push(a);
  }
  return out;
}

export interface GitCtx {
  ctx: CommandContext;
  args: string[];
  out: (t: string) => void;
  err: (t: string) => void;
  note: (t: string) => void;
}

export function repoOf(g: GitCtx): Repo {
  const repo = findRepo(g.ctx.state, g.ctx.vfs, g.ctx.state.cwd);
  if (!repo) throw notARepo();
  return repo;
}

/** Commands that need a working tree (not a bare repo, not mid-way through an unfinished operation). */
export function opInProgress(repo: Repo): string | null {
  if (!repo.op) return null;
  switch (repo.op.kind) {
    case 'merge':
      return 'You have not concluded your merge (MERGE_HEAD exists).';
    case 'rebase':
      return 'It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.';
    case 'cherry-pick':
      return 'cherry-pick is already in progress';
    case 'revert':
      return 'revert is already in progress';
  }
}
