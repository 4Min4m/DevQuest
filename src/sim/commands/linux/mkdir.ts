import { parseArgs } from '../../shell/args';
import type { CommandDef } from '../../shell/types';
import { errText } from './util';

export const mkdir: CommandDef = {
  name: 'mkdir',
  summary: 'make directories',
  run(ctx) {
    const p = parseArgs(ctx, { flags: 'pv', long: { parents: 'p', verbose: 'v' } });
    if (typeof p === 'number') return p;
    if (!p.operands.length) {
      ctx.err("mkdir: missing operand\nTry 'mkdir --help' for more information.\n");
      return 1;
    }
    let code = 0;
    for (const op of p.operands) {
      try {
        ctx.vfs.mkdir(ctx.resolve(op), { parents: p.flags.has('p') });
        if (p.flags.has('v')) ctx.out(`mkdir: created directory '${op}'\n`);
      } catch (e) {
        ctx.err(`mkdir: cannot create directory '${op}': ${errText(e)}\n`);
        code = 1;
      }
    }
    return code;
  },
};
