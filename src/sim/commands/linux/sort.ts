import { parseArgs } from '../../shell/args';
import type { CommandDef } from '../../shell/types';
import { joinLines, readInputs, splitLines } from './util';

/** Leading numeric value like GNU `sort -n` (non-numbers sort as 0). */
function numericPrefix(s: string): number {
  const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(s);
  return m ? Number(m[1]) : 0;
}

const HUMAN_UNITS: Record<string, number> = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5 };

function humanValue(s: string): number {
  const m = /^\s*(-?\d+(?:\.\d+)?)([KMGTP]?)/i.exec(s);
  if (!m) return 0;
  return Number(m[1]) * 1024 ** HUMAN_UNITS[m[2].toUpperCase()];
}

/** Byte-order compare (LC_ALL=C), which is what `sort` does with LANG=C.UTF-8. */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const sort: CommandDef = {
  name: 'sort',
  summary: 'sort lines of text',
  run(ctx) {
    const p = parseArgs(ctx, {
      flags: 'rnufh',
      valued: 'kto',
      long: { reverse: 'r', 'numeric-sort': 'n', unique: 'u', 'ignore-case': 'f', 'human-numeric-sort': 'h' },
      longValued: { key: 'k', 'field-separator': 't', output: 'o' },
      usageExit: 2,
    });
    if (typeof p === 'number') return p;
    const f = p.flags;
    let lines: string[] = [];
    const ok = readInputs(
      ctx,
      p.operands,
      (_n, content) => lines.push(...splitLines(content)),
      (name, msg) => ctx.err(`sort: cannot read: ${name}: ${msg}\n`),
    );
    if (!ok) return 2;

    let keyField: number | null = null;
    if (p.values.k !== undefined) {
      const m = /^(\d+)/.exec(p.values.k);
      if (!m || Number(m[1]) === 0) {
        ctx.err(`sort: invalid number at field start: invalid count at start of '${p.values.k}'\n`);
        return 2;
      }
      keyField = Number(m[1]);
    }
    const sep = p.values.t;
    const key = (line: string): string => {
      if (keyField === null) return line;
      const parts = sep !== undefined ? line.split(sep) : line.trim().split(/\s+/);
      return parts.slice(keyField - 1).join(sep ?? ' ');
    };
    const norm = (s: string) => (f.has('f') ? s.toUpperCase() : s);
    const compare = (a: string, b: string): number => {
      const ka = key(a);
      const kb = key(b);
      let r: number;
      if (f.has('n')) r = numericPrefix(ka) - numericPrefix(kb);
      else if (f.has('h')) r = humanValue(ka) - humanValue(kb);
      else r = cmpStr(norm(ka), norm(kb));
      // GNU sort falls back to comparing whole lines when keys are equal.
      if (r === 0 && !f.has('u')) r = cmpStr(a, b);
      return r;
    };
    lines.sort(compare);
    if (f.has('r')) lines.reverse();
    if (f.has('u')) lines = lines.filter((l, i) => i === 0 || compare(lines[i - 1], l) !== 0);
    const out = joinLines(lines);
    if (p.values.o !== undefined) {
      try {
        ctx.vfs.writeFile(ctx.resolve(p.values.o), out);
      } catch (e) {
        ctx.err(`sort: open failed: ${p.values.o}: ${(e as Error).message}\n`);
        return 2;
      }
      return 0;
    }
    ctx.out(out);
    return 0;
  },
};
