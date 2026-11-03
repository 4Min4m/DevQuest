import { parseArgs } from '../../shell/args';
import type { CommandContext, CommandDef } from '../../shell/types';
import { errText } from './util';

/** Lines including their trailing newline (the last one may lack it). */
function rawLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

type Slicer = (content: string) => string;

function runHeadTail(ctx: CommandContext, makeSlicer: (n: string, bytes: boolean) => Slicer | string): number {
  const p = parseArgs(ctx, {
    flags: ctx.name === 'tail' ? 'qvf' : 'qv',
    valued: 'nc',
    long: { quiet: 'q', silent: 'q', verbose: 'v', ...(ctx.name === 'tail' ? { follow: 'f' } : {}) },
    longValued: { lines: 'n', bytes: 'c' },
    numericFlag: 'n',
  });
  if (typeof p === 'number') return p;
  const bytes = p.values.c !== undefined;
  const slicer = makeSlicer(bytes ? p.values.c : p.values.n ?? '10', bytes);
  if (typeof slicer === 'string') {
    ctx.err(`${ctx.name}: ${slicer}\n`);
    return 1;
  }
  if (p.flags.has('f')) {
    ctx.err('tail: note: -f (follow) is not supported in devquest; showing current content only\n');
  }
  const files = p.operands.length ? p.operands : ['-'];
  const headers = p.flags.has('v') || (files.length > 1 && !p.flags.has('q'));
  let code = 0;
  let first = true;
  for (const f of files) {
    let content: string;
    if (f === '-') {
      content = ctx.stdin;
    } else {
      const abs = ctx.resolve(f);
      try {
        if (ctx.vfs.isDir(abs)) {
          ctx.err(`${ctx.name}: error reading '${f}': Is a directory\n`);
          code = 1;
          continue;
        }
        content = ctx.vfs.readFile(abs);
      } catch (e) {
        ctx.err(`${ctx.name}: cannot open '${f}' for reading: ${errText(e)}\n`);
        code = 1;
        continue;
      }
    }
    if (headers) ctx.out(`${first ? '' : '\n'}==> ${f === '-' ? 'standard input' : f} <==\n`);
    first = false;
    ctx.out(slicer(content));
  }
  return code;
}

export const head: CommandDef = {
  name: 'head',
  summary: 'output the first part of files',
  run(ctx) {
    return runHeadTail(ctx, (raw, bytes) => {
      if (!/^-?\d+$/.test(raw)) return `invalid number of ${bytes ? 'bytes' : 'lines'}: '${raw}'`;
      const n = Number(raw);
      if (bytes) return (c) => (n >= 0 ? c.slice(0, n) : c.slice(0, Math.max(0, c.length + n)));
      return (c) => {
        const lines = rawLines(c);
        return (n >= 0 ? lines.slice(0, n) : lines.slice(0, Math.max(0, lines.length + n))).join('');
      };
    });
  },
};

export const tail: CommandDef = {
  name: 'tail',
  summary: 'output the last part of files',
  run(ctx) {
    return runHeadTail(ctx, (raw, bytes) => {
      if (!/^[+-]?\d+$/.test(raw)) return `invalid number of ${bytes ? 'bytes' : 'lines'}: '${raw}'`;
      const fromStart = raw.startsWith('+');
      const n = Math.abs(Number(raw));
      if (bytes) return (c) => (fromStart ? c.slice(Math.max(0, n - 1)) : n === 0 ? '' : c.slice(-n));
      return (c) => {
        const lines = rawLines(c);
        if (fromStart) return lines.slice(Math.max(0, n - 1)).join('');
        return n === 0 ? '' : lines.slice(-n).join('');
      };
    });
  },
};
