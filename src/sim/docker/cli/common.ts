import { groupsOf } from '../../shell/identity';
import type { CommandContext } from '../../shell/types';
import { DockerEngine, DockerError } from '../engine';

export interface FlagSpec {
  /** Flag key → whether it takes a value. Aliases map to the same key via `alias`. */
  flags: Record<string, { value?: boolean; multi?: boolean; key?: string }>;
  /** Stop parsing at the first positional argument (docker run / exec). */
  stopAtPositional?: boolean;
}

export interface Parsed {
  opts: Record<string, string | boolean>;
  multi: Record<string, string[]>;
  args: string[];
}

export class UsageError extends Error {
  constructor(
    message: string,
    public readonly usageLine?: string,
    public readonly exitCode = 125,
  ) {
    super(message);
  }
}

/** pflag-style parsing: `-it`, `-p8080:80`, `--name=x`, `--name x`, repeated flags. */
export function parseFlags(argv: string[], spec: FlagSpec): Parsed {
  const opts: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  const args: string[] = [];
  const set = (name: string, value: string | boolean) => {
    const def = spec.flags[name];
    const key = def.key ?? name.replace(/^-+/, '');
    if (def.multi) (multi[key] ??= []).push(String(value));
    else opts[key] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      const def = spec.flags[name];
      if (!def) throw new UsageError(`unknown flag: ${name}`);
      if (def.value) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new UsageError(`flag needs an argument: ${name}`);
        set(name, v);
      } else set(name, true);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const name = '-' + a[j];
        const def = spec.flags[name];
        if (!def) throw new UsageError(`unknown shorthand flag: '${a[j]}' in ${a}`);
        if (def.value) {
          const v = j + 1 < a.length ? a.slice(j + 1) : argv[++i];
          if (v === undefined) throw new UsageError(`flag needs an argument: '${a[j]}' in ${a}`);
          set(name, v);
          break;
        }
        set(name, true);
      }
      continue;
    }
    if (spec.stopAtPositional) {
      args.push(...argv.slice(i));
      break;
    }
    args.push(a);
  }
  return { opts, multi, args };
}

/** Connect to the daemon the way the CLI does: checks the daemon and socket permissions. */
export function connect(ctx: CommandContext): DockerEngine | number {
  const docker = ctx.state.docker;
  if (!docker || !docker.daemonRunning) {
    ctx.err('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
    return 1;
  }
  if (ctx.state.user !== 'root' && !groupsOf(ctx.state, ctx.state.user).includes('docker')) {
    ctx.err(
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: ' +
        'Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": dial unix /var/run/docker.sock: connect: permission denied\n',
    );
    return 1;
  }
  const names = new Set(ctx.shell.listCommands().map((c) => c.name));
  return new DockerEngine(ctx.state, { spawn: (s) => ctx.shell.spawn(s), hasCommand: (n) => names.has(n) && n !== 'docker' });
}

/** Print a daemon error like the CLI ("Error response from daemon: ..."). Rethrows anything else. */
export function daemonError(ctx: CommandContext, e: unknown, prefix = ''): number {
  if (e instanceof DockerError) {
    ctx.err(`${prefix}Error response from daemon: ${e.message}\n`);
    return e.exitCode;
  }
  throw e;
}

export function usage(ctx: CommandContext, cmd: string, e: unknown): number {
  if (e instanceof UsageError) {
    ctx.err(`${e.message}\nSee 'docker ${cmd} --help'.\n`);
    if (e.usageLine) ctx.err(`\nUsage:  docker ${cmd} ${e.usageLine}\n`);
    return e.exitCode;
  }
  throw e;
}

/** Run `fn` for each container reference, reporting errors per item like the CLI. */
export function forEachRef(ctx: CommandContext, refs: string[], fn: (ref: string) => void): number {
  let code = 0;
  for (const ref of refs) {
    try {
      fn(ref);
      ctx.out(ref + '\n');
    } catch (e) {
      code = daemonError(ctx, e) && 1;
    }
  }
  return code;
}

export function requireArgs(cmd: string, args: string[], min: number, what: string): void {
  if (args.length < min) {
    throw new UsageError(`"docker ${cmd}" requires at least ${min} argument${min === 1 ? '' : 's'}.`, what, 1);
  }
}
