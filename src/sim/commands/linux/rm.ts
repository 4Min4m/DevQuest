import { parseArgs } from '../../shell/args';
import type { CommandDef } from '../../shell/types';
import { basename } from '../../vfs/path';
import { errText } from './util';

export const rm: CommandDef = {
  name: 'rm',
  summary: 'remove files or directories',
  run(ctx) {
    const p = parseArgs(ctx, {
      flags: 'rRfvd',
      long: { recursive: 'r', force: 'f', verbose: 'v', dir: 'd', 'no-preserve-root': 'P' },
    });
    if (typeof p === 'number') return p;
    const recursive = p.flags.has('r') || p.flags.has('R');
    const force = p.flags.has('f');
    if (!p.operands.length) {
      if (force) return 0;
      ctx.err("rm: missing operand\nTry 'rm --help' for more information.\n");
      return 1;
    }
    let code = 0;
    for (const op of p.operands) {
      const base = basename(op);
      if (base === '.' || base === '..') {
        ctx.err(`rm: refusing to remove '.' or '..' directory: skipping '${op}'\n`);
        code = 1;
        continue;
      }
      const abs = ctx.resolve(op);
      if (abs === '/' && !p.flags.has('P')) {
        ctx.err("rm: it is dangerous to operate recursively on '/'\n");
        ctx.err('rm: use --no-preserve-root to override this failsafe\n');
        code = 1;
        continue;
      }
      let node;
      try {
        node = ctx.vfs.lookup(abs);
      } catch (e) {
        if (force && errText(e) === 'No such file or directory') continue;
        ctx.err(`rm: cannot remove '${op}': ${errText(e)}\n`);
        code = 1;
        continue;
      }
      try {
        if (node.type === 'dir' && !recursive && !p.flags.has('d')) {
          ctx.err(`rm: cannot remove '${op}': Is a directory\n`);
          code = 1;
          continue;
        }
        ctx.vfs.remove(abs, { recursive, dirOnlyIfEmpty: !recursive && p.flags.has('d') });
        if (p.flags.has('v')) ctx.out(`removed ${node.type === 'dir' ? 'directory ' : ''}'${op}'\n`);
      } catch (e) {
        ctx.err(`rm: cannot remove '${op}': ${errText(e)}\n`);
        code = 1;
      }
    }
    return code;
  },
};
