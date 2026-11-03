import { parseArgs } from '../../shell/args';
import type { CommandContext, CommandDef } from '../../shell/types';
import { basename, isWithin, joinPath } from '../../vfs/path';
import { UMASK } from '../../vfs/vfs';
import { errText } from './util';

/**
 * Shared operand handling for cp and mv: validates the operand count and
 * works out the final destination path of each source.
 */
export function planTransfer(
  ctx: CommandContext,
  operands: string[],
): { pairs: { src: string; srcAbs: string; dest: string; destAbs: string }[] } | number {
  if (operands.length === 0) {
    ctx.err(`${ctx.name}: missing file operand\nTry '${ctx.name} --help' for more information.\n`);
    return 1;
  }
  if (operands.length === 1) {
    ctx.err(`${ctx.name}: missing destination file operand after '${operands[0]}'\nTry '${ctx.name} --help' for more information.\n`);
    return 1;
  }
  const target = operands[operands.length - 1];
  const targetAbs = ctx.resolve(target);
  const targetIsDir = ctx.vfs.isDir(targetAbs);
  const sources = operands.slice(0, -1);
  if (sources.length > 1 && !targetIsDir) {
    ctx.err(`${ctx.name}: target '${target}' is not a directory\n`);
    return 1;
  }
  return {
    pairs: sources.map((src) => {
      const name = basename(src);
      return {
        src,
        srcAbs: ctx.resolve(src),
        dest: targetIsDir ? (target.endsWith('/') ? target + name : `${target}/${name}`) : target,
        destAbs: targetIsDir ? joinPath(targetAbs, name) : targetAbs,
      };
    }),
  };
}

function copyTree(ctx: CommandContext, srcAbs: string, destAbs: string): void {
  const node = ctx.vfs.lookup(srcAbs);
  if (node.type === 'file') {
    const content = ctx.vfs.readFile(srcAbs);
    const existed = ctx.vfs.exists(destAbs);
    ctx.vfs.writeFile(destAbs, content);
    if (!existed) ctx.vfs.chmod(destAbs, node.mode & ~UMASK);
    return;
  }
  if (!ctx.vfs.exists(destAbs)) ctx.vfs.mkdir(destAbs);
  for (const name of ctx.vfs.readdir(srcAbs)) {
    copyTree(ctx, joinPath(srcAbs, name), joinPath(destAbs, name));
  }
}

export const cp: CommandDef = {
  name: 'cp',
  summary: 'copy files and directories',
  run(ctx) {
    const p = parseArgs(ctx, { flags: 'rRv', long: { recursive: 'r', verbose: 'v' } });
    if (typeof p === 'number') return p;
    const plan = planTransfer(ctx, p.operands);
    if (typeof plan === 'number') return plan;
    const recursive = p.flags.has('r') || p.flags.has('R');
    let code = 0;
    for (const { src, srcAbs, dest, destAbs } of plan.pairs) {
      let node;
      try {
        node = ctx.vfs.lookup(srcAbs);
      } catch (e) {
        ctx.err(`cp: cannot stat '${src}': ${errText(e)}\n`);
        code = 1;
        continue;
      }
      if (node.type === 'dir' && !recursive) {
        ctx.err(`cp: -r not specified; omitting directory '${src}'\n`);
        code = 1;
        continue;
      }
      if (srcAbs === destAbs) {
        ctx.err(`cp: '${src}' and '${dest}' are the same file\n`);
        code = 1;
        continue;
      }
      if (node.type === 'dir' && isWithin(destAbs, srcAbs)) {
        ctx.err(`cp: cannot copy a directory, '${src}', into itself, '${dest}'\n`);
        code = 1;
        continue;
      }
      if (node.type === 'dir' && ctx.vfs.exists(destAbs) && !ctx.vfs.isDir(destAbs)) {
        ctx.err(`cp: cannot overwrite non-directory '${dest}' with directory '${src}'\n`);
        code = 1;
        continue;
      }
      if (node.type === 'file' && ctx.vfs.isDir(destAbs)) {
        ctx.err(`cp: cannot overwrite directory '${dest}' with non-directory\n`);
        code = 1;
        continue;
      }
      try {
        if (node.type === 'file') {
          try {
            ctx.vfs.readFile(srcAbs);
          } catch (e) {
            ctx.err(`cp: cannot open '${src}' for reading: ${errText(e)}\n`);
            code = 1;
            continue;
          }
        }
        copyTree(ctx, srcAbs, destAbs);
        if (p.flags.has('v')) ctx.out(`'${src}' -> '${dest}'\n`);
      } catch (e) {
        ctx.err(`cp: cannot create regular file '${dest}': ${errText(e)}\n`);
        code = 1;
      }
    }
    return code;
  },
};
