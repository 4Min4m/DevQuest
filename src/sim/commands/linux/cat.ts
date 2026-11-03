import { parseArgs } from '../../shell/args';
import type { CommandDef } from '../../shell/types';
import { readInputs } from './util';

export const cat: CommandDef = {
  name: 'cat',
  summary: 'concatenate files and print them',
  run(ctx) {
    const p = parseArgs(ctx, { flags: 'n', long: { number: 'n' } });
    if (typeof p === 'number') return p;
    let lineNo = 0;
    const ok = readInputs(
      ctx,
      p.operands,
      (_name, content) => {
        if (!p.flags.has('n')) {
          ctx.out(content);
          return;
        }
        const lines = content.split('\n');
        const trailing = content.endsWith('\n');
        if (trailing) lines.pop();
        ctx.out(lines.map((l) => `${String(++lineNo).padStart(6)}\t${l}`).join('\n') + (trailing ? '\n' : ''));
      },
      (name, msg) => ctx.err(`cat: ${name}: ${msg}\n`),
    );
    return ok ? 0 : 1;
  },
};
