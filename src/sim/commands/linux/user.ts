import { parseArgs } from '../../shell/args';
import { findUser, groupsOf } from '../../shell/identity';
import type { CommandDef } from '../../shell/types';

export const whoami: CommandDef = {
  name: 'whoami',
  summary: 'print the current user name',
  run(ctx) {
    if (ctx.args.length) {
      ctx.err(`whoami: extra operand '${ctx.args[0]}'\nTry 'whoami --help' for more information.\n`);
      return 1;
    }
    ctx.out(ctx.state.user + '\n');
    return 0;
  },
};

export const id: CommandDef = {
  name: 'id',
  summary: 'print user and group IDs',
  run(ctx) {
    const p = parseArgs(ctx, { flags: 'ugGn', long: { user: 'u', group: 'g', groups: 'G', name: 'n' } });
    if (typeof p === 'number') return p;
    const name = p.operands[0] ?? ctx.state.user;
    const user = findUser(ctx.state, name);
    if (!user) {
      ctx.err(`id: '${name}': no such user\n`);
      return 1;
    }
    const groups = groupsOf(ctx.state, name).map((g) => ctx.state.groups.find((x) => x.name === g)!);
    const f = p.flags;
    const named = f.has('n');
    if (f.has('u')) ctx.out((named ? user.name : String(user.uid)) + '\n');
    else if (f.has('g')) ctx.out((named ? groups[0].name : String(groups[0].gid)) + '\n');
    else if (f.has('G')) ctx.out(groups.map((g) => (named ? g.name : String(g.gid))).join(' ') + '\n');
    else {
      if (named) {
        ctx.err('id: cannot print only names or real IDs in default format\n');
        return 1;
      }
      ctx.out(
        `uid=${user.uid}(${user.name}) gid=${groups[0].gid}(${groups[0].name}) groups=` +
          groups.map((g) => `${g.gid}(${g.name})`).join(',') +
          '\n',
      );
    }
    return 0;
  },
};
