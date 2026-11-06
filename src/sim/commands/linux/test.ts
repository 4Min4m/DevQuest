import type { CommandContext, CommandDef } from '../../shell/types';

/** `test EXPR` / `[ EXPR ]`: file tests, string and integer comparisons, !, -a, -o. */
function evaluate(ctx: CommandContext, args: string[]): boolean | string {
  let i = 0;
  const fileTest = (op: string, path: string): boolean => {
    const abs = ctx.resolve(path);
    if (!ctx.vfs.exists(abs)) return false;
    const node = ctx.vfs.stat(abs);
    switch (op) {
      case '-e':
        return true;
      case '-f':
        return node.type === 'file';
      case '-d':
        return node.type === 'dir';
      case '-s':
        return node.type === 'file' ? node.content.length > 0 : true;
      case '-r':
        return ctx.vfs.can(node, 4);
      case '-w':
        return ctx.vfs.can(node, 2);
      case '-x':
        return ctx.vfs.can(node, 1);
      default:
        return false;
    }
  };
  const primary = (): boolean | string => {
    const a = args[i];
    if (a === '!') {
      i++;
      const v = primary();
      return typeof v === 'string' ? v : !v;
    }
    if (a === '(') {
      i++;
      const v = or();
      i++;
      return v;
    }
    if (/^-[efdsrwx]$/.test(a) && i + 1 < args.length) {
      i += 2;
      return fileTest(a, args[i - 1]);
    }
    if ((a === '-z' || a === '-n') && i + 1 < args.length) {
      i += 2;
      return a === '-z' ? args[i - 1] === '' : args[i - 1] !== '';
    }
    const op = args[i + 1];
    if (op !== undefined && ['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(op) && i + 2 < args.length) {
      const b = args[i + 2];
      i += 3;
      if (op === '=' || op === '==') return a === b;
      if (op === '!=') return a !== b;
      const x = Number(a);
      const y = Number(b);
      if (!/^-?\d+$/.test(a)) return `integer expression expected: ${a}`;
      if (!/^-?\d+$/.test(b)) return `integer expression expected: ${b}`;
      return op === '-eq' ? x === y : op === '-ne' ? x !== y : op === '-lt' ? x < y : op === '-le' ? x <= y : op === '-gt' ? x > y : x >= y;
    }
    i++;
    return a !== undefined && a !== '';
  };
  const and = (): boolean | string => {
    let v = primary();
    while (args[i] === '-a') {
      i++;
      const r = primary();
      if (typeof v === 'string') return v;
      if (typeof r === 'string') return r;
      v = v && r;
    }
    return v;
  };
  const or = (): boolean | string => {
    let v = and();
    while (args[i] === '-o') {
      i++;
      const r = and();
      if (typeof v === 'string') return v;
      if (typeof r === 'string') return r;
      v = v || r;
    }
    return v;
  };
  if (!args.length) return false;
  const v = or();
  if (typeof v === 'boolean' && i < args.length) return `too many arguments`;
  return v;
}

function run(ctx: CommandContext, args: string[], name: string): number {
  const v = evaluate(ctx, args);
  if (typeof v === 'string') {
    ctx.err(`bash: ${name}: ${v}\n`);
    return 2;
  }
  return v ? 0 : 1;
}

export const testCmd: CommandDef = {
  name: 'test',
  summary: 'evaluate a conditional expression (-f, -d, -z, =, -eq, …)',
  run: (ctx) => run(ctx, ctx.args, 'test'),
};

export const bracket: CommandDef = {
  name: '[',
  summary: 'same as test (needs a closing ])',
  run(ctx) {
    if (ctx.args[ctx.args.length - 1] !== ']') {
      ctx.err("bash: [: missing `]'\n");
      return 2;
    }
    return run(ctx, ctx.args.slice(0, -1), '[');
  },
};
