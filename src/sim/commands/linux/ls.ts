import { parseArgs } from '../../shell/args';
import type { CommandContext, CommandDef } from '../../shell/types';
import { joinPath } from '../../vfs/path';
import type { FsNode } from '../../vfs/types';
import { nodeSize } from '../../vfs/vfs';
import { alignRows, errText, formatLsDate, formatMode, humanSize } from './util';

interface Entry {
  name: string;
  node: FsNode;
}

interface Opts {
  all: boolean;
  almostAll: boolean;
  long: boolean;
  human: boolean;
  one: boolean;
  dirSelf: boolean;
  recursive: boolean;
  reverse: boolean;
  byTime: boolean;
  bySize: boolean;
}

const TERM_WIDTH = 80;

function linkCount(node: FsNode): number {
  if (node.type !== 'dir') return 1;
  return 2 + Object.values(node.children).filter((c) => c.type === 'dir').length;
}

function blocks(node: FsNode): number {
  return Math.ceil(nodeSize(node) / 4096) * 4;
}

function sortEntries(entries: Entry[], o: Opts): Entry[] {
  const sorted = [...entries].sort((a, b) => {
    if (o.byTime && a.node.mtime !== b.node.mtime) return b.node.mtime - a.node.mtime;
    if (o.bySize && nodeSize(a.node) !== nodeSize(b.node)) return nodeSize(b.node) - nodeSize(a.node);
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return o.reverse ? sorted.reverse() : sorted;
}

/** Column-major grid like GNU ls on a terminal. */
function grid(names: string[]): string {
  if (!names.length) return '';
  for (let cols = names.length; cols >= 1; cols--) {
    const rows = Math.ceil(names.length / cols);
    const widths: number[] = [];
    for (let c = 0; c < cols; c++) {
      const col = names.slice(c * rows, (c + 1) * rows);
      widths.push(col.length ? Math.max(...col.map((n) => n.length)) : 0);
    }
    const realCols = widths.filter((w) => w > 0).length;
    const total = widths.reduce((s, w) => s + w, 0) + 2 * (realCols - 1);
    if (total <= TERM_WIDTH || cols === 1) {
      const lines: string[] = [];
      for (let r = 0; r < rows; r++) {
        const cells: string[] = [];
        for (let c = 0; c < cols; c++) {
          const n = names[c * rows + r];
          if (n === undefined) continue;
          const isLastInRow = names[(c + 1) * rows + r] === undefined;
          cells.push(isLastInRow ? n : n.padEnd(widths[c] + 2));
        }
        lines.push(cells.join(''));
      }
      return lines.join('\n') + '\n';
    }
  }
  return '';
}

function render(ctx: CommandContext, entries: Entry[], o: Opts, withTotal: boolean): string {
  if (o.long) {
    const now = ctx.state.clock;
    const rows = entries.map((e) => [
      formatMode(e.node),
      String(linkCount(e.node)),
      e.node.owner,
      e.node.group,
      o.human ? humanSize(nodeSize(e.node)) : String(nodeSize(e.node)),
      formatLsDate(e.node.mtime, now),
      e.name,
    ]);
    let out = '';
    if (withTotal) {
      const total = entries.reduce((s, e) => s + blocks(e.node), 0);
      out += `total ${o.human ? humanSize(total * 1024) : total}\n`;
    }
    const lines = alignRows(rows, [2, 3, 6]).map((l) => l);
    return out + lines.map((l) => l + '\n').join('');
  }
  const names = entries.map((e) => e.name);
  if (o.one || !ctx.stdoutIsTTY) return names.map((n) => n + '\n').join('');
  return grid(names);
}

function listDir(ctx: CommandContext, path: string, display: string, o: Opts, header: boolean, first: boolean): number {
  let code = 0;
  let names: string[];
  let node: FsNode;
  try {
    node = ctx.vfs.lookup(path);
    names = ctx.vfs.readdir(path);
  } catch (e) {
    ctx.err(`ls: cannot open directory '${display}': ${errText(e)}\n`);
    return 2;
  }
  if (node.type !== 'dir') return 0;
  const dir = node;
  let entries: Entry[] = names
    .filter((n) => o.all || o.almostAll || !n.startsWith('.'))
    .map((n) => ({ name: n, node: dir.children[n] }));
  entries = sortEntries(entries, o);
  if (o.all) {
    const parent = path === '/' ? dir : ctx.vfs.lookup(path.replace(/\/[^/]+$/, '') || '/');
    entries = [{ name: '.', node: dir }, { name: '..', node: parent }, ...entries];
  }
  if (header) ctx.out(`${first ? '' : '\n'}${display}:\n`);
  ctx.out(render(ctx, entries, o, true));
  if (o.recursive) {
    for (const e of entries) {
      if (e.node.type !== 'dir' || e.name === '.' || e.name === '..') continue;
      const childDisplay = display === '/' ? '/' + e.name : `${display}/${e.name}`;
      code = Math.max(code, listDir(ctx, joinPath(path, e.name), childDisplay, o, true, false));
    }
  }
  return code;
}

export const ls: CommandDef = {
  name: 'ls',
  summary: 'list directory contents',
  run(ctx) {
    const p = parseArgs(ctx, {
      flags: 'aAlh1dRrtS',
      long: { all: 'a', 'almost-all': 'A', 'human-readable': 'h', directory: 'd', recursive: 'R', reverse: 'r' },
      usageExit: 2,
    });
    if (typeof p === 'number') return p;
    const f = p.flags;
    const o: Opts = {
      all: f.has('a'),
      almostAll: f.has('A'),
      long: f.has('l'),
      human: f.has('h'),
      one: f.has('1'),
      dirSelf: f.has('d'),
      recursive: f.has('R'),
      reverse: f.has('r'),
      byTime: f.has('t'),
      bySize: f.has('S'),
    };
    const operands = p.operands.length ? p.operands : ['.'];
    let code = 0;
    const files: Entry[] = [];
    const dirs: { path: string; display: string }[] = [];
    for (const op of operands) {
      const abs = ctx.resolve(op);
      try {
        const node = ctx.vfs.lookup(abs);
        if (node.type === 'dir' && !o.dirSelf) dirs.push({ path: abs, display: op });
        else files.push({ name: op, node });
      } catch (e) {
        ctx.err(`ls: cannot access '${op}': ${errText(e)}\n`);
        code = 2;
      }
    }
    if (files.length) ctx.out(render(ctx, sortEntries(files, o), o, false));
    const header = operands.length > 1 || o.recursive;
    dirs.sort((a, b) => (a.display < b.display ? -1 : 1));
    dirs.forEach((d, i) => {
      code = Math.max(code, listDir(ctx, d.path, d.display, o, header, i === 0 && files.length === 0));
    });
    return code;
  },
};
