import { parseArgs } from '../../shell/args';
import { findUser } from '../../shell/identity';
import type { CommandContext, CommandDef } from '../../shell/types';
import { joinPath } from '../../vfs/path';
import { errText } from './util';

function chownOne(
  ctx: CommandContext,
  display: string,
  abs: string,
  owner: string | undefined,
  group: string | undefined,
  recursive: boolean,
): number {
  let node;
  try {
    node = ctx.vfs.lookup(abs);
  } catch (e) {
    ctx.err(`chown: cannot access '${display}': ${errText(e)}\n`);
    return 1;
  }
  let code = 0;
  try {
    ctx.vfs.chown(abs, owner, group);
  } catch (e) {
    ctx.err(`chown: changing ownership of '${display}': ${errText(e)}\n`);
    code = 1;
  }
  if (recursive && node.type === 'dir') {
    for (const name of Object.keys(node.children).sort()) {
      code = Math.max(code, chownOne(ctx, `${display}/${name}`, joinPath(abs, name), owner, group, true));
    }
  }
  return code;
}

export const chown: CommandDef = {
  name: 'chown',
  summary: 'change file owner and group',
  run(ctx) {
    const p = parseArgs(ctx, { flags: 'R', long: { recursive: 'R' } });
    if (typeof p === 'number') return p;
    if (!p.operands.length) {
      ctx.err("chown: missing operand\nTry 'chown --help' for more information.\n");
      return 1;
    }
    const [spec, ...files] = p.operands;
    if (!files.length) {
      ctx.err(`chown: missing operand after '${spec}'\nTry 'chown --help' for more information.\n`);
      return 1;
    }
    const [userPart, groupPart] = spec.split(':', 2) as [string, string | undefined];
    const owner: string | undefined = userPart || undefined;
    let group: string | undefined = groupPart || undefined;
    if (owner !== undefined) {
      const u = findUser(ctx.state, owner);
      if (!u) {
        ctx.err(`chown: invalid user: '${spec}'\n`);
        return 1;
      }
      // `user:` means "user and their login group".
      if (groupPart === '') group = ctx.state.groups.find((g) => g.gid === u.gid)?.name;
    }
    if (group !== undefined && !ctx.state.groups.some((g) => g.name === group)) {
      ctx.err(`chown: invalid group: '${spec}'\n`);
      return 1;
    }
    let code = 0;
    for (const f of files) code = Math.max(code, chownOne(ctx, f, ctx.resolve(f), owner, group, p.flags.has('R')));
    return code;
  },
};
