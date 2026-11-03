import { parseArgs } from '../../shell/args';
import type { CommandDef } from '../../shell/types';
import { errText, splitLines } from './util';

export const uniq: CommandDef = {
  name: 'uniq',
  summary: 'report or omit repeated adjacent lines',
  run(ctx) {
    const p = parseArgs(ctx, {
      flags: 'cdui',
      long: { count: 'c', repeated: 'd', unique: 'u', 'ignore-case': 'i' },
    });
    if (typeof p === 'number') return p;
    const f = p.flags;
    const [input, output] = p.operands;
    let text = ctx.stdin;
    if (input !== undefined && input !== '-') {
      try {
        text = ctx.vfs.readFile(ctx.resolve(input));
      } catch (e) {
        ctx.err(`uniq: ${input}: ${errText(e)}\n`);
        return 1;
      }
    }
    const same = (a: string, b: string) => (f.has('i') ? a.toLowerCase() === b.toLowerCase() : a === b);
    const groups: { line: string; n: number }[] = [];
    for (const line of splitLines(text)) {
      const last = groups[groups.length - 1];
      if (last && same(last.line, line)) last.n++;
      else groups.push({ line, n: 1 });
    }
    let out = '';
    for (const g of groups) {
      if (f.has('d') && g.n < 2) continue;
      if (f.has('u') && g.n > 1) continue;
      out += (f.has('c') ? `${String(g.n).padStart(7)} ` : '') + g.line + '\n';
    }
    if (output !== undefined) {
      try {
        ctx.vfs.writeFile(ctx.resolve(output), out);
      } catch (e) {
        ctx.err(`uniq: ${output}: ${errText(e)}\n`);
        return 1;
      }
      return 0;
    }
    ctx.out(out);
    return 0;
  },
};
