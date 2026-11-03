import { parseArgs } from '../../shell/args';
import type { CommandDef } from '../../shell/types';
import { errText } from './util';

export const touch: CommandDef = {
  name: 'touch',
  summary: 'create empty files or update timestamps',
  run(ctx) {
    const p = parseArgs(ctx, { flags: 'c', long: { 'no-create': 'c' } });
    if (typeof p === 'number') return p;
    if (!p.operands.length) {
      ctx.err("touch: missing file operand\nTry 'touch --help' for more information.\n");
      return 1;
    }
    let code = 0;
    for (const op of p.operands) {
      const abs = ctx.resolve(op);
      if (p.flags.has('c') && !ctx.vfs.exists(abs)) continue;
      try {
        ctx.vfs.touch(abs);
      } catch (e) {
        ctx.err(`touch: cannot touch '${op}': ${errText(e)}\n`);
        code = 1;
      }
    }
    return code;
  },
};
