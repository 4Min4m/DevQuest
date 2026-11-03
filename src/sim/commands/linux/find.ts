import { segmentToRegExp } from '../../shell/glob';
import type { CommandContext, CommandDef } from '../../shell/types';
import { basename, joinPath } from '../../vfs/path';
import type { FsNode } from '../../vfs/types';
import { nodeSize } from '../../vfs/vfs';
import { errText } from './util';

type Test = (path: string, node: FsNode, depth: number) => boolean;

interface FindPlan {
  tests: Test[];
  maxDepth: number;
  minDepth: number;
  del: boolean;
}

const UNSUPPORTED = new Set(['-exec', '-execdir', '-ok', '-o', '-or', '-a', '-and', '-prune', '-printf', '-newer', '-mtime', '-mmin', '-regex', '(', ')']);

function globRe(pattern: string, ignoreCase: boolean): RegExp {
  const re = segmentToRegExp({ text: pattern, active: [...pattern].map(() => true) });
  return ignoreCase ? new RegExp(re.source, 'i') : re;
}

function sizeTest(spec: string): Test | string {
  const m = /^([+-]?)(\d+)([ckMGb]?)$/.exec(spec);
  if (!m) return `invalid -size argument: '${spec}'`;
  const unit = { c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3, b: 512, '': 512 }[m[3]] as number;
  const n = Number(m[2]);
  return (_p, node) => {
    // find rounds sizes up to whole units before comparing.
    const units = Math.ceil(nodeSize(node) / unit);
    return m[1] === '+' ? units > n : m[1] === '-' ? units < n : units === n;
  };
}

function parseExpr(ctx: CommandContext, args: string[]): FindPlan | number {
  const plan: FindPlan = { tests: [], maxDepth: Infinity, minDepth: 0, del: false };
  let negateNext = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const need = (): string | undefined => {
      const v = args[++i];
      if (v === undefined) ctx.err(`find: missing argument to '${a}'\n`);
      return v;
    };
    let test: Test | null = null;
    if (a === '!' || a === '-not') {
      negateNext = !negateNext;
      continue;
    }
    if (UNSUPPORTED.has(a)) {
      ctx.err(`find: '${a}' is not supported in devquest yet (supported: -name -iname -path -type -size -empty -user -maxdepth -mindepth -not -print -delete)\n`);
      return 1;
    }
    switch (a) {
      case '-name':
      case '-iname': {
        const v = need();
        if (v === undefined) return 1;
        const re = globRe(v, a === '-iname');
        test = (path) => re.test(basename(path));
        break;
      }
      case '-path': {
        const v = need();
        if (v === undefined) return 1;
        const re = globRe(v, false);
        test = (path) => re.test(path);
        break;
      }
      case '-type': {
        const v = need();
        if (v === undefined) return 1;
        if (v !== 'f' && v !== 'd') {
          ctx.err(`find: Unknown argument to -type: ${v}\n`);
          return 1;
        }
        test = (_p, node) => (v === 'd' ? node.type === 'dir' : node.type === 'file');
        break;
      }
      case '-size': {
        const v = need();
        if (v === undefined) return 1;
        const t = sizeTest(v);
        if (typeof t === 'string') {
          ctx.err(`find: ${t}\n`);
          return 1;
        }
        test = t;
        break;
      }
      case '-user': {
        const v = need();
        if (v === undefined) return 1;
        if (!ctx.state.users.some((u) => u.name === v)) {
          ctx.err(`find: '${v}' is not the name of a known user\n`);
          return 1;
        }
        test = (_p, node) => node.owner === v;
        break;
      }
      case '-empty':
        test = (_p, node) => (node.type === 'dir' ? Object.keys(node.children).length === 0 : node.content.length === 0);
        break;
      case '-maxdepth':
      case '-mindepth': {
        const v = need();
        if (v === undefined) return 1;
        if (!/^\d+$/.test(v)) {
          ctx.err(`find: Expected a positive decimal integer argument to ${a}, but got '${v}'\n`);
          return 1;
        }
        if (a === '-maxdepth') plan.maxDepth = Number(v);
        else plan.minDepth = Number(v);
        continue;
      }
      case '-print':
        continue;
      case '-delete':
        plan.del = true;
        continue;
      default:
        if (a.startsWith('-')) ctx.err(`find: unknown predicate '${a}'\n`);
        else ctx.err(`find: paths must precede expression: '${a}'\n`);
        return 1;
    }
    if (negateNext) {
      const inner = test;
      test = (p, n, d) => !inner(p, n, d);
      negateNext = false;
    }
    plan.tests.push(test);
  }
  return plan;
}

export const find: CommandDef = {
  name: 'find',
  summary: 'search for files in a directory hierarchy',
  run(ctx) {
    const args = ctx.args;
    let i = 0;
    const starts: string[] = [];
    while (i < args.length && !args[i].startsWith('-') && args[i] !== '!' && args[i] !== '(') starts.push(args[i++]);
    const plan = parseExpr(ctx, args.slice(i));
    if (typeof plan === 'number') return plan;
    if (!starts.length) starts.push('.');

    let code = 0;
    const matches: { display: string; abs: string }[] = [];
    const visit = (display: string, abs: string, node: FsNode, depth: number) => {
      if (depth >= plan.minDepth && plan.tests.every((t) => t(display, node, depth))) {
        matches.push({ display, abs });
        if (!plan.del) ctx.out(display + '\n');
      }
      if (node.type !== 'dir' || depth >= plan.maxDepth) return;
      let names: string[];
      try {
        names = ctx.vfs.readdir(abs);
      } catch (e) {
        ctx.err(`find: '${display}': ${errText(e)}\n`);
        code = 1;
        return;
      }
      for (const n of names) {
        const childDisplay = display.endsWith('/') ? display + n : `${display}/${n}`;
        visit(childDisplay, joinPath(abs, n), node.children[n], depth + 1);
      }
    };

    for (const start of starts) {
      const abs = ctx.resolve(start);
      try {
        visit(start, abs, ctx.vfs.lookup(abs), 0);
      } catch (e) {
        ctx.err(`find: '${start}': ${errText(e)}\n`);
        code = 1;
      }
    }
    if (plan.del) {
      // -delete works depth-first, so children go before their parents.
      for (const m of matches.reverse()) {
        if (m.display === '.' || m.abs === '/') continue;
        try {
          ctx.vfs.remove(m.abs, { dirOnlyIfEmpty: true });
        } catch (e) {
          ctx.err(`find: cannot delete '${m.display}': ${errText(e)}\n`);
          code = 1;
        }
      }
    }
    return code;
  },
};
