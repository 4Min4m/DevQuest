import { parseArgs } from '../../shell/args';
import type { CommandContext, CommandDef } from '../../shell/types';
import { joinPath } from '../../vfs/path';
import { errText, splitLines } from './util';

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\s',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
};

/** Convert a POSIX basic (BRE) or extended (ERE) regex into a JavaScript regex source. */
export function posixToJs(pattern: string, extended: boolean): string {
  const src = pattern.replace(/\[:(\w+):\]/g, (m, name: string) => POSIX_CLASSES[name] ?? m);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      const n = src[++i];
      if (n === '<' || n === '>') out += '\\b';
      else if (!extended && '(){}|+?'.includes(n)) out += n;
      else out += '\\' + n;
      continue;
    }
    if (c === '[') {
      // Copy bracket expressions verbatim (a leading ']' is literal).
      let j = i + 1;
      if (src[j] === '^') j++;
      if (src[j] === ']') j++;
      while (j < src.length && src[j] !== ']') j++;
      out += src.slice(i, j + 1).replace(/^\[\^?\]/, (m) => m.replace(']', '\\]'));
      i = j;
      continue;
    }
    // In basic regexes `$` / `^` only anchor at the end / start; elsewhere they're literal characters.
    if (!extended && c === '$' && i !== src.length - 1 && !src.startsWith('\\)', i + 1)) out += '\\$';
    else if (!extended && c === '^' && i !== 0 && !src.slice(0, i).endsWith('\\(')) out += '\\^';
    else if (!extended && '(){}|+?'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

interface Input {
  name: string;
  content: string;
}

function collectRecursive(ctx: CommandContext, display: string, abs: string, into: Input[]): boolean {
  let ok = true;
  const node = ctx.vfs.lookup(abs);
  if (node.type === 'file') {
    try {
      into.push({ name: display, content: ctx.vfs.readFile(abs) });
    } catch (e) {
      ctx.err(`grep: ${display}: ${errText(e)}\n`);
      ok = false;
    }
    return ok;
  }
  let names: string[];
  try {
    names = ctx.vfs.readdir(abs);
  } catch (e) {
    ctx.err(`grep: ${display}: ${errText(e)}\n`);
    return false;
  }
  for (const n of names) {
    const childDisplay = display.endsWith('/') ? display + n : `${display}/${n}`;
    ok = collectRecursive(ctx, childDisplay, joinPath(abs, n), into) && ok;
  }
  return ok;
}

export const grep: CommandDef = {
  name: 'grep',
  summary: 'print lines that match patterns',
  run(ctx) {
    const p = parseArgs(ctx, {
      flags: 'ivnclLrRwxEFohHqs',
      valued: 'eABC',
      long: {
        'ignore-case': 'i',
        'invert-match': 'v',
        'line-number': 'n',
        count: 'c',
        'files-with-matches': 'l',
        'files-without-match': 'L',
        recursive: 'r',
        'word-regexp': 'w',
        'line-regexp': 'x',
        'extended-regexp': 'E',
        'fixed-strings': 'F',
        'only-matching': 'o',
        'no-filename': 'h',
        'with-filename': 'H',
        quiet: 'q',
        silent: 'q',
        'no-messages': 's',
      },
      longValued: { regexp: 'e', 'after-context': 'A', 'before-context': 'B', context: 'C' },
      usageExit: 2,
    });
    if (typeof p === 'number') return p;
    const f = p.flags;
    const operands = [...p.operands];
    const pattern = p.values.e ?? operands.shift();
    if (pattern === undefined) {
      ctx.err("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n");
      return 2;
    }
    let source = f.has('F') ? escapeRe(pattern) : posixToJs(pattern, f.has('E'));
    if (f.has('w')) source = `(?<![\\w])(?:${source})(?![\\w])`;
    if (f.has('x')) source = `^(?:${source})$`;
    let re: RegExp;
    try {
      re = new RegExp(source, f.has('i') ? 'gi' : 'g');
    } catch {
      ctx.err('grep: Invalid regular expression\n');
      return 2;
    }
    const recursive = f.has('r') || f.has('R');
    const errOut = (msg: string) => {
      if (!f.has('s')) ctx.err(msg);
    };

    let hadError = false;
    const inputs: Input[] = [];
    const names = operands.length ? operands : [recursive ? '.' : '-'];
    for (const name of names) {
      if (name === '-') {
        inputs.push({ name: '(standard input)', content: ctx.stdin });
        continue;
      }
      const abs = ctx.resolve(name);
      try {
        const node = ctx.vfs.lookup(abs);
        if (node.type === 'dir' && !recursive) {
          errOut(`grep: ${name}: Is a directory\n`);
          hadError = true;
          continue;
        }
        if (recursive) {
          hadError = !collectRecursive(ctx, name, abs, inputs) || hadError;
          continue;
        }
        inputs.push({ name, content: ctx.vfs.readFile(abs) });
      } catch (e) {
        errOut(`grep: ${name}: ${errText(e)}\n`);
        hadError = true;
      }
    }

    const showName = !f.has('h') && (f.has('H') || inputs.length > 1 || recursive);
    let anyMatch = false;
    let listedWithoutMatch = false;
    const num = (k: string) => {
      const v = p.values[k] ?? p.values.C;
      return v === undefined ? 0 : Math.max(0, Number(v) || 0);
    };
    const after = num('A');
    const before = num('B');
    const context = after > 0 || before > 0;
    let printedAny = false;
    for (const input of inputs) {
      let count = 0;
      const lines = splitLines(input.content);
      let lastPrinted = -1;
      let afterLeft = 0;
      lines.forEach((line, idx) => {
        re.lastIndex = 0;
        const matched = re.test(line) !== f.has('v');
        const quiet = f.has('q') || f.has('l') || f.has('L') || f.has('c');
        const emit = (i: number, sep: string) => {
          if (context && lastPrinted >= 0 && i > lastPrinted + 1) ctx.out('--\n');
          else if (context && lastPrinted < 0 && printedAny && i >= 0) ctx.out('--\n');
          ctx.out((showName ? input.name + sep : '') + (f.has('n') ? `${i + 1}${sep}` : '') + lines[i] + '\n');
          lastPrinted = i;
          printedAny = true;
        };
        if (!matched) {
          if (!quiet && afterLeft > 0) {
            emit(idx, '-');
            afterLeft--;
          }
          return;
        }
        count++;
        anyMatch = true;
        if (quiet) return;
        if (context) {
          for (let b = Math.max(lastPrinted + 1, idx - before); b < idx; b++) emit(b, '-');
          afterLeft = after;
        }
        const prefix = (showName ? input.name + ':' : '') + (f.has('n') ? `${idx + 1}:` : '');
        if (f.has('o') && !f.has('v')) {
          re.lastIndex = 0;
          for (const m of line.matchAll(re)) if (m[0]) ctx.out(prefix + m[0] + '\n');
        } else if (context) emit(idx, ':');
        else ctx.out(prefix + line + '\n');
      });
      if (f.has('q')) continue;
      if (f.has('c')) ctx.out((showName ? input.name + ':' : '') + count + '\n');
      else if (f.has('l') && count > 0) ctx.out(input.name + '\n');
      else if (f.has('L') && count === 0) {
        ctx.out(input.name + '\n');
        listedWithoutMatch = true;
      }
    }
    if (f.has('q') && anyMatch) return 0;
    if (hadError) return 2;
    if (f.has('L')) return listedWithoutMatch ? 0 : 1;
    return anyMatch ? 0 : 1;
  },
};
