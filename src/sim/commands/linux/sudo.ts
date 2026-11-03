import { groupsOf } from '../../shell/identity';
import type { CommandContext, CommandDef } from '../../shell/types';
import type { SimState } from '../../state';

/** Shell builtins can't be run by sudo: it executes programs, not shell features. */
const BUILTINS = new Set(['cd', 'export', 'unset', 'history', 'exit', 'ulimit', 'alias', 'source', '.']);

function quote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/**
 * The same machine, seen by another user. Only the per-session fields (user, environment,
 * cwd, history, $?) are separate; everything else — files, processes, services, PIDs,
 * the clock — is the live shared state, so changes made with sudo stick.
 */
export function asUser(state: SimState, user: string): SimState {
  const entry = state.users.find((u) => u.name === user)!;
  const local: Partial<SimState> = {
    user,
    vars: { ...state.vars, USER: user, LOGNAME: user, HOME: entry.home, SUDO_USER: state.user },
    exported: [...new Set([...state.exported, 'SUDO_USER'])],
    history: [],
    cwd: state.cwd,
    oldCwd: undefined,
    lastExit: 0,
  };
  return new Proxy(state, {
    get: (target, key) => (key in local ? local[key as keyof SimState] : target[key as keyof SimState]),
    set: (target, key, value) => {
      if (key in local) (local as Record<string | symbol, unknown>)[key] = value;
      else (target as unknown as Record<string | symbol, unknown>)[key] = value;
      return true;
    },
  });
}

export const sudo: CommandDef = {
  name: 'sudo',
  summary: 'run a command as root (you are in the sudo group)',
  run(ctx: CommandContext) {
    const { state } = ctx;
    const args = [...ctx.args];
    let target = 'root';
    let login = false;
    while (args[0]?.startsWith('-')) {
      const a = args.shift()!;
      if (a === '-u') {
        target = args.shift() ?? '';
      } else if (a === '-i' || a === '-s') {
        login = true;
      } else if (a === '--') {
        break;
      } else {
        ctx.err(`sudo: devquest supports -u USER, -i and -s (got ${a})\n`);
        return 1;
      }
    }
    if (!args.length && !login) {
      ctx.err('usage: sudo -h | -K | -k | -V\nusage: sudo [-u user] [-i | -s] [command [arg ...]]\n');
      return 1;
    }
    if (state.user !== 'root' && !groupsOf(state, state.user).includes('sudo')) {
      ctx.err(`${state.user} is not in the sudoers file.\n`);
      return 1;
    }
    if (!state.users.some((u) => u.name === target)) {
      ctx.err(`sudo: unknown user ${target}\nsudo: error initializing audit plugin sudoers_audit\n`);
      return 1;
    }
    if (state.context) {
      ctx.err('bash: sudo: command not found\n');
      return 127;
    }
    const other = asUser(state, target);
    if (login && !args.length) {
      other.cwd = other.vars.HOME;
      ctx.shell.attach(other, () => {});
      return 0;
    }
    if (BUILTINS.has(args[0])) {
      ctx.err(`sudo: ${args[0]}: command not found\n`);
      return 1;
    }
    const r = ctx.shell.spawn(other).run(args.map(quote).join(' '), ctx.stdin);
    for (const chunk of r.output) {
      if (chunk.stream === 'stdout') ctx.out(chunk.text);
      else if (chunk.note) ctx.note(chunk.text);
      else ctx.err(chunk.text);
    }
    if (r.edit) ctx.shell.edit(r.edit);
    if (r.clear) ctx.shell.requestClear();
    return r.exitCode;
  },
};
