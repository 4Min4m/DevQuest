import type { CommandDef } from '../../shell/types';

export const help: CommandDef = {
  name: 'help',
  summary: 'list the commands available in this simulator',
  run(ctx) {
    ctx.out('DevQuest simulated shell. Available commands:\n\n');
    const cmds = ctx.shell.listCommands();
    const width = Math.max(...cmds.map((c) => c.name.length));
    for (const c of cmds) ctx.out(`  ${c.name.padEnd(width)}  ${c.summary}\n`);
    ctx.out("\nShell features: pipes |, redirects > >> < 2> 2>&1 &>, && || ;, quotes, $VARS, globs * ? [..]\n");
    ctx.out("Most commands accept --help to list the options devquest supports.\n");
    return 0;
  },
};

export const history: CommandDef = {
  name: 'history',
  summary: 'show the command history',
  run(ctx) {
    if (ctx.args[0] === '-c') {
      ctx.state.history = [];
      return 0;
    }
    const all = ctx.state.history;
    const n = ctx.args[0] !== undefined ? Number(ctx.args[0]) : all.length;
    if (!Number.isInteger(n) || n < 0) {
      ctx.err(`bash: history: ${ctx.args[0]}: numeric argument required\n`);
      return 1;
    }
    const start = Math.max(0, all.length - n);
    all.slice(start).forEach((line, i) => ctx.out(`${String(start + i + 1).padStart(5)}  ${line}\n`));
    return 0;
  },
};

export const clear: CommandDef = {
  name: 'clear',
  summary: 'clear the terminal screen',
  run(ctx) {
    ctx.shell.requestClear();
    return 0;
  },
};

export const trueCmd: CommandDef = { name: 'true', summary: 'do nothing, successfully', run: () => 0 };
export const falseCmd: CommandDef = { name: 'false', summary: 'do nothing, unsuccessfully', run: () => 1 };

const UNITS: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

/** `sleep` returns at once but advances the simulated clock (so `docker ps` uptimes move). */
export const sleep: CommandDef = {
  name: 'sleep',
  summary: 'delay for a specified amount of time (instantly, in simulated time)',
  run(ctx) {
    if (!ctx.args.length) {
      ctx.err("sleep: missing operand\nTry 'sleep --help' for more information.\n");
      return 1;
    }
    let total = 0;
    for (const a of ctx.args) {
      const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(a);
      if (!m && a !== 'infinity') {
        ctx.err(`sleep: invalid time interval '${a}'\nTry 'sleep --help' for more information.\n`);
        return 1;
      }
      if (a === 'infinity') {
        ctx.err("devquest: 'sleep infinity' would never return; skipping\n");
        return 0;
      }
      total += Number(m![1]) * UNITS[m![2]];
    }
    ctx.state.clock += Math.round(total * 1000);
    return 0;
  },
};

export const exit: CommandDef = {
  name: 'exit',
  summary: 'exit the shell (inside a container: return to the host)',
  run(ctx) {
    const code = ctx.args[0] !== undefined ? Number(ctx.args[0]) & 255 : ctx.state.lastExit;
    if (ctx.state.context) return code; // e.g. `sh -c "...; exit 3"` inside a container
    ctx.err("devquest: this is your main shell — there's nothing to exit to\n");
    return code;
  },
};
