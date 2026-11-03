import type { CommandContext, CommandDef } from '../../shell/types';
import { joinPath } from '../../vfs/path';
import type { FsNode } from '../../vfs/types';
import { UMASK } from '../../vfs/vfs';
import { errText, formatMode } from './util';

/** Apply an octal or symbolic mode (`755`, `u+x`, `go-w,a+r`, `+x`) to an existing mode. */
export function applyMode(spec: string, current: number, isDir: boolean): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8);
  let mode = current;
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)((?:[-+=][rwxXst]*)+)$/.exec(clause);
    if (!m) return null;
    const who = m[1] || '';
    const ops = m[2].match(/[-+=][rwxXst]*/g) ?? [];
    for (const op of ops) {
      const action = op[0];
      const perms = op.slice(1);
      let bits = 0;
      let special = 0;
      const targets = who === '' || who.includes('a') ? 'ugo' : who;
      for (const t of targets) {
        const shift = t === 'u' ? 6 : t === 'g' ? 3 : 0;
        for (const p of perms) {
          if (p === 'r') bits |= 4 << shift;
          if (p === 'w') bits |= 2 << shift;
          if (p === 'x') bits |= 1 << shift;
          if (p === 'X' && (isDir || (current & 0o111) !== 0)) bits |= 1 << shift;
          if (p === 's' && t === 'u') special |= 0o4000;
          if (p === 's' && t === 'g') special |= 0o2000;
          if (p === 't') special |= 0o1000;
        }
      }
      // Without an explicit "who", the umask limits which bits are added.
      if (who === '') bits &= ~UMASK;
      const allBits = bits | special;
      if (action === '+') mode |= allBits;
      else if (action === '-') mode &= ~allBits;
      else {
        let clear = 0;
        for (const t of targets) clear |= 7 << (t === 'u' ? 6 : t === 'g' ? 3 : 0);
        mode = (mode & ~clear) | allBits;
      }
    }
  }
  return mode;
}

function chmodOne(ctx: CommandContext, display: string, abs: string, spec: string, recursive: boolean, verbose: boolean): number {
  let node: FsNode;
  try {
    node = ctx.vfs.lookup(abs);
  } catch (e) {
    ctx.err(`chmod: cannot access '${display}': ${errText(e)}\n`);
    return 1;
  }
  const next = applyMode(spec, node.mode, node.type === 'dir');
  if (next === null) return 1;
  let code = 0;
  try {
    const before = node.mode;
    ctx.vfs.chmod(abs, next);
    if (verbose) {
      const oct = (n: number) => n.toString(8).padStart(4, '0');
      const after = { ...node, mode: next };
      ctx.out(
        before === next
          ? `mode of '${display}' retained as ${oct(next)} (${formatMode(after).slice(1)})\n`
          : `mode of '${display}' changed from ${oct(before)} (${formatMode({ ...node, mode: before }).slice(1)}) to ${oct(next)} (${formatMode(after).slice(1)})\n`,
      );
    }
  } catch (e) {
    ctx.err(`chmod: changing permissions of '${display}': ${errText(e)}\n`);
    code = 1;
  }
  if (recursive && node.type === 'dir') {
    for (const name of Object.keys(node.children).sort()) {
      code = Math.max(code, chmodOne(ctx, `${display}/${name}`, joinPath(abs, name), spec, true, verbose));
    }
  }
  return code;
}

export const chmod: CommandDef = {
  name: 'chmod',
  summary: 'change file mode bits',
  run(ctx) {
    let recursive = false;
    let verbose = false;
    const rest: string[] = [];
    for (const a of ctx.args) {
      if (a === '-R' || a === '--recursive') recursive = true;
      else if (a === '-v' || a === '--verbose') verbose = true;
      else if (a.startsWith('--')) {
        ctx.err(`chmod: unrecognized option '${a}'\nTry 'chmod --help' for more information.\n`);
        return 1;
      } else rest.push(a);
    }
    if (!rest.length) {
      ctx.err("chmod: missing operand\nTry 'chmod --help' for more information.\n");
      return 1;
    }
    const [spec, ...files] = rest;
    if (!files.length) {
      ctx.err(`chmod: missing operand after '${spec}'\nTry 'chmod --help' for more information.\n`);
      return 1;
    }
    if (applyMode(spec, 0, false) === null) {
      ctx.err(`chmod: invalid mode: '${spec}'\nTry 'chmod --help' for more information.\n`);
      return 1;
    }
    let code = 0;
    for (const f of files) code = Math.max(code, chmodOne(ctx, f, ctx.resolve(f), spec, recursive, verbose));
    return code;
  },
};
