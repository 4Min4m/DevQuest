import type { CommandDef } from '../../shell/types';
import { posixToJs } from './grep';
import { errText, splitLines } from './util';

/** A line address: number, last line, or regex. */
type Addr = { kind: 'line'; n: number } | { kind: 'last' } | { kind: 're'; re: RegExp };

interface SedCmd {
  a1?: Addr;
  a2?: Addr;
  negate: boolean;
  op: 's' | 'd' | 'p' | 'q';
  re?: RegExp;
  repl?: string;
  global?: boolean;
  nth?: number;
  print?: boolean;
  /** Range state: currently inside a1,a2. */
  active?: boolean;
}

class SedError extends Error {}

/** Parse a sed script (the subset devquest supports: s, d, p, q with addresses). */
export function parseScript(script: string, extended: boolean): SedCmd[] {
  const cmds: SedCmd[] = [];
  let i = 0;
  const peek = () => script[i];
  const skipWs = () => {
    while (i < script.length && /[\s;]/.test(script[i])) i++;
  };
  /** Read up to an unescaped delimiter; `\delim` becomes `delim`. */
  const readDelimited = (delim: string): string => {
    let out = '';
    while (i < script.length && script[i] !== delim) {
      if (script[i] === '\\' && i + 1 < script.length) {
        if (script[i + 1] === delim) out += delim;
        else out += script[i] + script[i + 1];
        i += 2;
      } else out += script[i++];
    }
    if (script[i] !== delim) throw new SedError(`unterminated address regex`);
    i++;
    return out;
  };
  const toRe = (src: string, flags = '') => {
    try {
      return new RegExp(posixToJs(src, extended), flags);
    } catch {
      throw new SedError(`invalid regular expression: ${src}`);
    }
  };
  const readAddr = (): Addr | undefined => {
    if (/\d/.test(peek() ?? '')) {
      let n = '';
      while (/\d/.test(peek() ?? '')) n += script[i++];
      return { kind: 'line', n: Number(n) };
    }
    if (peek() === '$') {
      i++;
      return { kind: 'last' };
    }
    if (peek() === '/') {
      i++;
      return { kind: 're', re: toRe(readDelimited('/')) };
    }
    return undefined;
  };

  skipWs();
  while (i < script.length) {
    const cmd: SedCmd = { negate: false, op: 'p' };
    cmd.a1 = readAddr();
    if (cmd.a1 && peek() === ',') {
      i++;
      cmd.a2 = readAddr();
      if (!cmd.a2) throw new SedError('unexpected `,\'');
    }
    while (peek() === ' ') i++;
    if (peek() === '!') {
      cmd.negate = true;
      i++;
    }
    const op = script[i++];
    if (op === 's') {
      const delim = script[i++];
      if (!delim || delim === '\\' || delim === '\n') throw new SedError('unterminated `s\' command');
      let pattern: string;
      let repl: string;
      try {
        pattern = readDelimited(delim);
        repl = readDelimited(delim);
      } catch {
        throw new SedError("unterminated `s' command");
      }
      let flags = '';
      while (i < script.length && /[gipI0-9]/.test(script[i])) flags += script[i++];
      cmd.op = 's';
      cmd.global = flags.includes('g');
      cmd.print = flags.includes('p');
      const nth = /\d+/.exec(flags);
      if (nth) cmd.nth = Number(nth[0]);
      cmd.re = toRe(pattern, flags.includes('i') || flags.includes('I') ? 'gi' : 'g');
      cmd.repl = repl;
    } else if (op === 'd' || op === 'p' || op === 'q') {
      cmd.op = op;
    } else if (op === undefined) {
      throw new SedError('missing command');
    } else {
      throw new SedError(`unknown command: \`${op}' (devquest supports s, d, p and q)`);
    }
    skipWs();
    cmds.push(cmd);
  }
  return cmds;
}

/** sed replacement text: & is the match, \1..\9 groups, \n newline. */
function expand(repl: string, m: RegExpExecArray): string {
  let out = '';
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i];
    if (c === '\\' && i + 1 < repl.length) {
      const n = repl[++i];
      if (/\d/.test(n)) out += m[Number(n)] ?? '';
      else if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else out += n;
    } else if (c === '&') out += m[0];
    else out += c;
  }
  return out;
}

function substitute(line: string, cmd: SedCmd): { text: string; changed: boolean } {
  const re = cmd.re!;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let count = 0;
  let changed = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    count++;
    const want = cmd.nth ? count === cmd.nth || (cmd.global && count > cmd.nth) : true;
    if (want) {
      out += line.slice(last, m.index) + expand(cmd.repl!, m);
      last = m.index + m[0].length;
      changed = true;
      if (!cmd.global) break;
    }
    if (m[0] === '') re.lastIndex++;
  }
  return { text: out + line.slice(last), changed };
}

function matches(a: Addr, line: string, n: number, isLast: boolean): boolean {
  if (a.kind === 'line') return n === a.n;
  if (a.kind === 'last') return isLast;
  a.re.lastIndex = 0;
  return a.re.test(line);
}

function selected(cmd: SedCmd, line: string, n: number, isLast: boolean): boolean {
  let hit: boolean;
  if (!cmd.a1) hit = true;
  else if (!cmd.a2) hit = matches(cmd.a1, line, n, isLast);
  else if (cmd.active) {
    hit = true;
    const end = cmd.a2.kind === 'line' ? n >= cmd.a2.n : matches(cmd.a2, line, n, isLast);
    if (end) cmd.active = false;
  } else if (matches(cmd.a1, line, n, isLast)) {
    hit = true;
    // A numeric end address at or before the start line closes the range at once.
    cmd.active = !(cmd.a2.kind === 'line' && cmd.a2.n <= n);
  } else hit = false;
  return cmd.negate ? !hit : hit;
}

/** Run a parsed script over text. */
export function runSed(cmds: SedCmd[], text: string, quiet: boolean): string {
  for (const c of cmds) c.active = false;
  const lines = splitLines(text);
  const trailingNl = text.endsWith('\n') || text === '';
  let out = '';
  for (let idx = 0; idx < lines.length; idx++) {
    let line = lines[idx];
    const n = idx + 1;
    const isLast = idx === lines.length - 1;
    let deleted = false;
    let quit = false;
    for (const cmd of cmds) {
      if (!selected(cmd, line, n, isLast)) continue;
      if (cmd.op === 's') {
        const r = substitute(line, cmd);
        line = r.text;
        if (r.changed && cmd.print) out += line + '\n';
      } else if (cmd.op === 'd') {
        deleted = true;
        break;
      } else if (cmd.op === 'p') out += line + '\n';
      else if (cmd.op === 'q') {
        quit = true;
        break;
      }
    }
    if (!deleted && !quiet) out += line + (isLast && !trailingNl ? '' : '\n');
    if (quit) break;
  }
  return out;
}

export const sed: CommandDef = {
  name: 'sed',
  summary: 'stream editor (s///, d, p, q; -n, -i, -E)',
  run(ctx) {
    let quiet = false;
    let inPlace: string | null = null;
    let extended = false;
    const scripts: string[] = [];
    const files: string[] = [];
    const args = ctx.args;
    let opts = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (opts && a === '--') opts = false;
      else if (opts && a === '-e') {
        if (args[i + 1] === undefined) {
          ctx.err("sed: option requires an argument -- 'e'\n");
          return 1;
        }
        scripts.push(args[++i]);
      } else if (opts && (a === '-i' || a.startsWith('-i'))) inPlace = a.slice(2);
      else if (opts && a === '--in-place') inPlace = '';
      else if (opts && /^-[nEr]+$/.test(a)) {
        if (a.includes('n')) quiet = true;
        if (a.includes('E') || a.includes('r')) extended = true;
      } else if (opts && a === '--quiet') quiet = true;
      else if (opts && a.startsWith('-') && a !== '-') {
        ctx.err(`sed: unsupported option in devquest: ${a} (supported: -n -i -E -e)\n`);
        return 1;
      } else if (!scripts.length && !args.slice(0, i).includes('-e')) scripts.push(a);
      else files.push(a);
    }
    if (!scripts.length) {
      ctx.err('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n');
      return 1;
    }
    let cmds: SedCmd[];
    try {
      cmds = parseScript(scripts.join('\n'), extended);
    } catch (e) {
      ctx.err(`sed: -e expression #1, char ${scripts[0].length}: ${(e as Error).message}\n`);
      return 1;
    }
    if (inPlace !== null) {
      if (!files.length) {
        ctx.err('sed: no input files\n');
        return 1;
      }
      let code = 0;
      for (const f of files) {
        const abs = ctx.resolve(f);
        try {
          const before = ctx.vfs.readFile(abs);
          if (inPlace) ctx.vfs.writeFile(abs + inPlace, before);
          ctx.vfs.writeFile(abs, runSed(cmds, before, quiet));
        } catch (e) {
          ctx.err(`sed: can't read ${f}: ${errText(e)}\n`);
          code = 2;
        }
      }
      return code;
    }
    let text = '';
    let code = 0;
    if (!files.length) text = ctx.stdin;
    for (const f of files) {
      try {
        text += f === '-' ? ctx.stdin : ctx.vfs.readFile(ctx.resolve(f));
      } catch (e) {
        ctx.err(`sed: can't read ${f}: ${errText(e)}\n`);
        code = 2;
      }
    }
    ctx.out(runSed(cmds, text, quiet));
    return code;
  },
};

export const tee: CommandDef = {
  name: 'tee',
  summary: 'copy stdin to stdout and to files (-a to append)',
  run(ctx) {
    let append = false;
    const files: string[] = [];
    for (const a of ctx.args) {
      if (a === '-a' || a === '--append') append = true;
      else if (a.startsWith('-') && a !== '-') {
        ctx.err(`tee: unsupported option in devquest: ${a}\n`);
        return 1;
      } else files.push(a);
    }
    let code = 0;
    for (const f of files) {
      try {
        ctx.vfs.writeFile(ctx.resolve(f), ctx.stdin, { append });
      } catch (e) {
        ctx.err(`tee: ${f}: ${errText(e)}\n`);
        code = 1;
      }
    }
    ctx.out(ctx.stdin);
    return code;
  },
};
