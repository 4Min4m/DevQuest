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
