import { homeOf } from '../../shell/identity';
import type { CommandDef } from '../../shell/types';
import { errText } from './util';

export const cd: CommandDef = {
  name: 'cd',
  summary: 'change the current directory',
  run(ctx) {
    const { state } = ctx;
    const args = ctx.args[0] === '--' ? ctx.args.slice(1) : ctx.args;
    if (args.length > 1) {
      ctx.err('bash: cd: too many arguments\n');
      return 1;
    }
    let target = args[0];
    if (target === undefined || target === '') {
      target = homeOf(state);
    } else if (target === '-') {
      if (!state.oldCwd) {
        ctx.err('bash: cd: OLDPWD not set\n');
        return 1;
      }
      target = state.oldCwd;
      ctx.out(target + '\n');
    }
    const abs = ctx.resolve(target);
    try {
      const node = ctx.vfs.lookup(abs);
      if (node.type !== 'dir') {
        ctx.err(`bash: cd: ${args[0]}: Not a directory\n`);
        return 1;
      }
      if (!ctx.vfs.can(node, 1)) {
        ctx.err(`bash: cd: ${args[0]}: Permission denied\n`);
        return 1;
      }
    } catch (e) {
      ctx.err(`bash: cd: ${args[0] ?? target}: ${errText(e)}\n`);
      return 1;
    }
    state.oldCwd = state.cwd;
    state.cwd = abs;
    state.vars.OLDPWD = state.oldCwd;
    state.vars.PWD = abs;
    return 0;
  },
};

export const pwd: CommandDef = {
  name: 'pwd',
  summary: 'print the current working directory',
  run(ctx) {
    ctx.out(ctx.state.cwd + '\n');
    return 0;
  },
};
