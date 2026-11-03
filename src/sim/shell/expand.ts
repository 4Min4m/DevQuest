import type { Word } from './ast';
import { expandGlob, GlobFs, hasGlob, MaskedString } from './glob';

export interface ExpandContext {
  getVar(name: string): string | undefined;
  home: string;
  cwd: string;
  fs: GlobFs;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Expand a `$...` reference starting at `text[i]` (which is `$`).
 * Returns the substituted value and how many characters were consumed,
 * or null when the `$` should be kept literally.
 */
function expandDollar(text: string, i: number, ctx: ExpandContext): { value: string; len: number } | null {
  const rest = text.slice(i + 1);
  if (rest[0] === '?' || rest[0] === '$' || rest[0] === '#' || /^\d/.test(rest)) {
    return { value: ctx.getVar(rest[0]) ?? '', len: 2 };
  }
  if (rest[0] === '{') {
    const close = rest.indexOf('}');
    if (close < 0) return null;
    const inner = rest.slice(1, close);
    const m = /^([A-Za-z_][A-Za-z0-9_]*|[?$#0-9])(?::?-(.*))?$/.exec(inner);
    if (!m) return { value: '', len: close + 2 };
    const val = ctx.getVar(m[1]);
    const useDefault = m[2] !== undefined && (val === undefined || (inner.includes(':-') && val === ''));
    return { value: useDefault ? m[2] : val ?? '', len: close + 2 };
  }
  const m = NAME_RE.exec(rest);
  if (!m) return null;
  return { value: ctx.getVar(m[0]) ?? '', len: m[0].length + 1 };
}

/** Expand variables in a plain string (used for double-quoted text and assignments). */
export function expandVars(text: string, ctx: ExpandContext): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$') {
      const r = expandDollar(text, i, ctx);
      if (r) {
        out += r.value;
        i += r.len - 1;
        continue;
      }
    }
    out += text[i];
  }
  return out;
}

interface Field extends MaskedString {
  /** True once anything quoted contributed, so `""` yields an empty argument. */
  keep: boolean;
}

/**
 * Full word expansion: tilde, variables, word splitting of unquoted expansions,
 * then pathname expansion (globbing). One word may become zero or many fields.
 */
export function expandWord(word: Word, ctx: ExpandContext, opts: { split?: boolean; glob?: boolean } = {}): string[] {
  const split = opts.split ?? true;
  const glob = opts.glob ?? true;
  const fields: Field[] = [];
  let cur: Field = { text: '', active: [], keep: false };
  const add = (s: string, active: boolean) => {
    cur.text += s;
    for (let k = 0; k < s.length; k++) cur.active.push(active);
  };
  const breakField = () => {
    if (cur.text.length || cur.keep) fields.push(cur);
    cur = { text: '', active: [], keep: false };
  };

  word.parts.forEach((part, idx) => {
    if (part.quote === 'literal') {
      add(part.text, false);
      cur.keep = true;
      return;
    }
    if (part.quote === 'double') {
      add(expandVars(part.text, ctx), false);
      cur.keep = true;
      return;
    }
    let text = part.text;
    if (idx === 0 && (text === '~' || text.startsWith('~/'))) {
      add(ctx.home, false);
      text = text.slice(1);
    }
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '$') {
        const r = expandDollar(text, i, ctx);
        if (r) {
          i += r.len - 1;
          if (!split) {
            add(r.value, false);
            continue;
          }
          // Unquoted expansion: split on whitespace (default IFS).
          const pieces = r.value.split(/[ \t\n]+/);
          pieces.forEach((piece, k) => {
            if (k > 0) breakField();
            add(piece, true);
          });
          continue;
        }
      }
      add(text[i], true);
    }
  });
  breakField();

  const out: string[] = [];
  for (const f of fields) {
    if (glob && hasGlob(f)) {
      const matches = expandGlob(f, ctx.cwd, ctx.fs);
      if (matches.length) {
        out.push(...matches);
        continue;
      }
    }
    out.push(f.text);
  }
  return out;
}
