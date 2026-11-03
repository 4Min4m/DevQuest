import type { CommandContext } from './types';

export interface ArgSpec {
  /** Short boolean flags, e.g. 'alh1'. */
  flags?: string;
  /** Short flags that take a value, e.g. 'n'. */
  valued?: string;
  /** Long boolean flags mapped to their short letter (or any key). */
  long?: Record<string, string>;
  /** Long flags taking a value (`--lines=5` or `--lines 5`) mapped to a key. */
  longValued?: Record<string, string>;
  /** Treat `-5` as `-<key> 5` (head/tail). */
  numericFlag?: string;
  /** Exit status for usage errors (GNU ls/grep use 2, most others 1). */
  usageExit?: number;
}

export interface ParsedArgs {
  flags: Set<string>;
  values: Record<string, string>;
  operands: string[];
}

function supportedList(spec: ArgSpec): string {
  const items = [
    ...(spec.flags ?? '').split('').map((f) => '-' + f),
    ...(spec.valued ?? '').split('').map((f) => `-${f} VALUE`),
    ...Object.keys(spec.long ?? {}).map((l) => '--' + l),
    ...Object.keys(spec.longValued ?? {}).map((l) => `--${l}=VALUE`),
  ].filter((s) => s !== '-');
  return items.join(' ');
}

/**
 * GNU-style option parsing: combined short flags (`-la`), attached values (`-n5`),
 * long options, `--` terminator, and options mixed with operands.
 * On error, prints a message and returns the exit code to use.
 */
export function parseArgs(ctx: CommandContext, spec: ArgSpec): ParsedArgs | number {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const operands: string[] = [];
  const usageExit = spec.usageExit ?? 1;
  const fail = (msg: string): number => {
    ctx.err(`${ctx.name}: ${msg}\n`);
    ctx.err(`Try '${ctx.name} --help' for more information.\n`);
    ctx.err(`(devquest supports: ${supportedList(spec) || 'no options'})\n`);
    return usageExit;
  };
  const args = ctx.args;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a === '--help') {
      const def = ctx.shell.listCommands().find((c) => c.name === ctx.name);
      ctx.out(`Usage: ${ctx.name} [OPTION]... — ${def?.summary ?? ''}\n`);
      ctx.out(`Options supported in devquest: ${supportedList(spec) || 'none'}\n`);
      return 0;
    }
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (spec.long && name in spec.long && inline === undefined) {
        flags.add(spec.long[name]);
      } else if (spec.longValued && name in spec.longValued) {
        const v = inline ?? args[++i];
        if (v === undefined) return fail(`option '--${name}' requires an argument`);
        values[spec.longValued[name]] = v;
      } else {
        return fail(`unrecognized option '${a}'`);
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (spec.numericFlag && /^-\d+$/.test(a)) {
        values[spec.numericFlag] = a.slice(1);
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (spec.valued?.includes(f)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
          if (v === undefined) return fail(`option requires an argument -- '${f}'`);
          values[f] = v;
          break;
        }
        if (!spec.flags?.includes(f)) return fail(`invalid option -- '${f}'`);
        flags.add(f);
      }
      continue;
    }
    operands.push(a);
  }
  return { flags, values, operands };
}
