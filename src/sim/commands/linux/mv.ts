import { parseArgs } from '../../shell/args';
import type { CommandDef } from '../../shell/types';
import { isWithin } from '../../vfs/path';
import { planTransfer } from './cp';
import { errText } from './util';

export const mv: CommandDef = {
  name: 'mv',
  summary: 'move or rename files',
  run(ctx) {
    const p = parseArgs(ctx, { flags: 'vf', long: { verbose: 'v', force: 'f' } });
    if (typeof p === 'number') return p;
    const plan = planTransfer(ctx, p.operands);
    if (typeof plan === 'number') return plan;
    let code = 0;
    for (const { src, srcAbs, dest, destAbs } of plan.pairs) {
      let node;
      try {
        node = ctx.vfs.lookup(srcAbs);
      } catch (e) {
        ctx.err(`mv: cannot stat '${src}': ${errText(e)}\n`);
        code = 1;
        continue;
      }
      if (srcAbs === destAbs) {
        ctx.err(`mv: '${src}' and '${dest}' are the same file\n`);
        code = 1;
        continue;
      }
      if (node.type === 'dir' && isWithin(destAbs, srcAbs)) {
        ctx.err(`mv: cannot move '${src}' to a subdirectory of itself, '${dest}'\n`);
        code = 1;
        continue;
      }
      const destIsDir = ctx.vfs.isDir(destAbs);
      if (node.type === 'dir' && ctx.vfs.exists(destAbs) && !destIsDir) {
        ctx.err(`mv: cannot overwrite non-directory '${dest}' with directory '${src}'\n`);
        code = 1;
        continue;
      }
      if (node.type === 'file' && destIsDir) {
        ctx.err(`mv: cannot overwrite directory '${dest}' with non-directory\n`);
        code = 1;
        continue;
      }
      try {
        ctx.vfs.move(srcAbs, destAbs);
        if (p.flags.has('v')) ctx.out(`renamed '${src}' -> '${dest}'\n`);
      } catch (e) {
        ctx.err(`mv: cannot move '${src}' to '${dest}': ${errText(e)}\n`);
        code = 1;
      }
    }
    return code;
  },
};
