import { parseArgs } from '../../shell/args';
import type { CommandContext, CommandDef } from '../../shell/types';
import type { Disk } from '../../state';
import { isWithin, joinPath } from '../../vfs/path';
import { nodeSize } from '../../vfs/vfs';
import { alignRows, errText, humanSize } from './util';

function mountFor(disks: Disk[], abs: string): Disk | undefined {
  return [...disks].sort((a, b) => b.mount.length - a.mount.length).find((d) => isWithin(abs, d.mount));
}

export const df: CommandDef = {
  name: 'df',
  summary: 'report file system disk space usage',
  run(ctx) {
    const p = parseArgs(ctx, { flags: 'h', long: { 'human-readable': 'h' } });
    if (typeof p === 'number') return p;
    const human = p.flags.has('h');
    let disks = ctx.state.disks;
    let code = 0;
    if (p.operands.length) {
      disks = [];
      for (const op of p.operands) {
        const abs = ctx.resolve(op);
        if (!ctx.vfs.exists(abs)) {
          ctx.err(`df: ${op}: No such file or directory\n`);
          code = 1;
          continue;
        }
        const d = mountFor(ctx.state.disks, abs);
        if (d) disks.push(d);
      }
      if (!disks.length) return code;
    }
    const fmt = (kb: number) => (human ? humanSize(kb * 1024) : String(kb));
    const rows = [
      // GNU df gives the first column at least 14 chars and -h sizes at least 5.
      ['Filesystem'.padEnd(14), human ? ' Size' : '1K-blocks', human ? ' Used' : 'Used', human ? 'Avail' : 'Available', 'Use%', 'Mounted on'],
      ...disks.map((d) => {
        const avail = Math.max(0, d.size - d.used);
        const pct = d.size === 0 ? '-' : `${Math.ceil((d.used / d.size) * 100)}%`;
        return [d.filesystem, fmt(d.size), fmt(d.used), fmt(avail), pct, d.mount];
      }),
    ];
    for (const line of alignRows(rows, [0, 5])) ctx.out(line + '\n');
    return code;
  },
};

/** Disk usage in 1K blocks, like `du` (each file occupies whole 4K blocks). */
function usage(ctx: CommandContext, abs: string, display: string, depth: number, o: DuOpts, lines: string[]): number {
  const node = ctx.vfs.lookup(abs);
  if (node.type === 'file') {
    const kb = Math.ceil(nodeSize(node) / 4096) * 4;
    if (depth === 0 || (o.all && depth <= o.maxDepth && !o.summarize)) lines.push(`${o.fmt(kb)}\t${display}`);
    return kb;
  }
  let total = 4;
  let names: string[] = [];
  try {
    names = ctx.vfs.readdir(abs);
  } catch (e) {
    ctx.err(`du: cannot read directory '${display}': ${errText(e)}\n`);
    o.failed = true;
  }
  for (const n of names) {
    const childDisplay = display.endsWith('/') ? display + n : `${display}/${n}`;
    total += usage(ctx, joinPath(abs, n), childDisplay, depth + 1, o, lines);
  }
  if (depth === 0 || (!o.summarize && depth <= o.maxDepth)) lines.push(`${o.fmt(total)}\t${display}`);
  return total;
}

interface DuOpts {
  all: boolean;
  summarize: boolean;
  maxDepth: number;
  fmt: (kb: number) => string;
  failed: boolean;
}

export const du: CommandDef = {
  name: 'du',
  summary: 'estimate file space usage',
  run(ctx) {
    const p = parseArgs(ctx, {
      flags: 'shac',
      valued: 'd',
      long: { summarize: 's', 'human-readable': 'h', all: 'a', total: 'c' },
      longValued: { 'max-depth': 'd' },
    });
    if (typeof p === 'number') return p;
    const human = p.flags.has('h');
    if (p.values.d !== undefined && !/^\d+$/.test(p.values.d)) {
      ctx.err(`du: invalid maximum depth '${p.values.d}'\n`);
      return 1;
    }
    const o: DuOpts = {
      all: p.flags.has('a'),
      summarize: p.flags.has('s'),
      maxDepth: p.values.d !== undefined ? Number(p.values.d) : Infinity,
      fmt: (kb) => (human ? humanSize(kb * 1024) : String(kb)),
      failed: false,
    };
    let grand = 0;
    let code = 0;
    for (const op of p.operands.length ? p.operands : ['.']) {
      const lines: string[] = [];
      try {
        grand += usage(ctx, ctx.resolve(op), op, 0, o, lines);
      } catch (e) {
        ctx.err(`du: cannot access '${op}': ${errText(e)}\n`);
        code = 1;
        continue;
      }
      for (const l of lines) ctx.out(l + '\n');
    }
    if (p.flags.has('c')) ctx.out(`${o.fmt(grand)}\ttotal\n`);
    return o.failed ? 1 : code;
  },
};
