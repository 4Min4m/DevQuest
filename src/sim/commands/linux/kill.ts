import type { CommandDef } from '../../shell/types';

export const SIGNALS: Record<string, number> = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  KILL: 9,
  USR1: 10,
  USR2: 12,
  TERM: 15,
  CONT: 18,
  STOP: 19,
};

const SHELL_PID = 1001;

function parseSignal(spec: string): number | null {
  if (/^\d+$/.test(spec)) {
    const n = Number(spec);
    return n === 0 || Object.values(SIGNALS).includes(n) ? n : null;
  }
  const name = spec.toUpperCase().replace(/^SIG/, '');
  return SIGNALS[name] ?? null;
}

/** bash's builtin kill. Terminating signals remove the process unless it ignores them. */
export const kill: CommandDef = {
  name: 'kill',
  summary: 'send a signal to a process',
  run(ctx) {
    const { state } = ctx;
    const args = [...ctx.args];
    if (args[0] === '-l' || args[0] === '-L') {
      const entries = Object.entries(SIGNALS).map(([n, v]) => `${String(v).padStart(2)}) SIG${n}`);
      ctx.out(entries.join('\t') + '\n');
      return 0;
    }
    let signal = SIGNALS.TERM;
    if (args[0] === '-s' || args[0] === '-n') {
      const spec = args[1];
      args.splice(0, 2);
      const sig = spec === undefined ? null : parseSignal(spec);
      if (sig === null) {
        ctx.err(`bash: kill: ${spec ?? ''}: invalid signal specification\n`);
        return 1;
      }
      signal = sig;
    } else if (args[0]?.startsWith('-') && args[0] !== '--') {
      const spec = args.shift()!.slice(1);
      const sig = parseSignal(spec);
      if (sig === null) {
        ctx.err(`bash: kill: ${spec}: invalid signal specification\n`);
        return 1;
      }
      signal = sig;
    }
    if (args[0] === '--') args.shift();
    if (!args.length) {
      ctx.err('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n');
      return 2;
    }
    let code = 0;
    for (const a of args) {
      if (!/^-?\d+$/.test(a)) {
        ctx.err(`bash: kill: ${a}: arguments must be process or job IDs\n`);
        code = 1;
        continue;
      }
      const pid = Number(a);
      const idx = state.processes.findIndex((p) => p.pid === pid);
      if (idx < 0) {
        ctx.err(`bash: kill: (${pid}) - No such process\n`);
        code = 1;
        continue;
      }
      const proc = state.processes[idx];
      if (state.user !== 'root' && proc.user !== state.user) {
        ctx.err(`bash: kill: (${pid}) - Operation not permitted\n`);
        code = 1;
        continue;
      }
      if (signal === 0) continue;
      if (signal === SIGNALS.STOP) {
        proc.stat = 'T' + proc.stat.slice(1);
      } else if (signal === SIGNALS.CONT) {
        proc.stat = 'S' + proc.stat.slice(1);
      } else if (pid === SHELL_PID) {
        // An interactive bash ignores SIGTERM; we never let the learner kill their own shell.
        continue;
      } else if (signal === SIGNALS.KILL || !proc.ignoresTerm) {
        state.processes.splice(idx, 1);
      }
    }
    return code;
  },
};
