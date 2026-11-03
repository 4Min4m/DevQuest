import { parseArgs } from '../../shell/args';
import type { CommandDef } from '../../shell/types';
import { errText } from './util';

interface Counts {
  lines: number;
  words: number;
  chars: number;
  bytes: number;
}

function count(text: string): Counts {
  return {
    lines: (text.match(/\n/g) ?? []).length,
    words: text.split(/\s+/).filter(Boolean).length,
    chars: [...text].length,
    bytes: new TextEncoder().encode(text).length,
  };
}

export const wc: CommandDef = {
  name: 'wc',
  summary: 'print newline, word, and byte counts',
  run(ctx) {
    const p = parseArgs(ctx, {
      flags: 'lwcm',
      long: { lines: 'l', words: 'w', bytes: 'c', chars: 'm' },
    });
    if (typeof p === 'number') return p;
    const f = p.flags;
    const none = !f.has('l') && !f.has('w') && !f.has('c') && !f.has('m');
    const fields: (keyof Counts)[] = [];
    if (none || f.has('l')) fields.push('lines');
    if (none || f.has('w')) fields.push('words');
    if (f.has('m')) fields.push('chars');
    if (none || f.has('c')) fields.push('bytes');

    const names = p.operands.length ? p.operands : ['-'];
    const rows: { name: string; c: Counts }[] = [];
    let code = 0;
    let usesStdin = false;
    for (const name of names) {
      if (name === '-') {
        usesStdin = true;
        rows.push({ name: p.operands.length ? '-' : '', c: count(ctx.stdin) });
        continue;
      }
      const abs = ctx.resolve(name);
      try {
        if (ctx.vfs.isDir(abs)) {
          ctx.err(`wc: ${name}: Is a directory\n`);
          rows.push({ name, c: { lines: 0, words: 0, chars: 0, bytes: 0 } });
          code = 1;
          continue;
        }
        rows.push({ name, c: count(ctx.vfs.readFile(abs)) });
      } catch (e) {
        ctx.err(`wc: ${name}: ${errText(e)}\n`);
        code = 1;
      }
    }
    if (rows.length > 1) {
      const total: Counts = { lines: 0, words: 0, chars: 0, bytes: 0 };
      for (const r of rows) for (const k of Object.keys(total) as (keyof Counts)[]) total[k] += r.c[k];
      rows.push({ name: 'total', c: total });
    }
    // GNU wc: one count for one input prints unpadded; stdin uses width 7;
    // otherwise the width fits the largest number.
    let width: number;
    if (fields.length === 1 && rows.length === 1) width = 1;
    else if (usesStdin) width = 7;
    else width = Math.max(1, ...rows.map((r) => String(r.c.bytes).length));
    for (const r of rows) {
      const cells = fields.map((k) => String(r.c[k]).padStart(width)).join(' ');
      ctx.out(cells + (r.name ? ' ' + r.name : '') + '\n');
    }
    return code;
  },
};
