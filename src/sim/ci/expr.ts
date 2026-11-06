/** GitHub Actions expressions: `${{ github.ref == 'refs/heads/main' && success() }}`. */

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export interface ExprContext {
  contexts: Record<string, V>;
  /** Status functions: success(), failure(), always(), cancelled(). */
  status: { success: boolean; failure: boolean; cancelled: boolean };
  /** hashFiles(...) over the workspace. */
  hashFiles?: (patterns: string[]) => string;
}

export class ExprError extends Error {}

type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'punc'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) throw new ExprError(`Unexpected end of expression: '${src}'`);
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^-?(0x[0-9a-fA-F]+|\d+(\.\d+)?([eE][-+]?\d+)?)/.exec(src.slice(i));
    if (num && (/\d/.test(c) || (c === '-' && /\d/.test(src[i + 1] ?? '')))) {
      out.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const op = /^(==|!=|<=|>=|&&|\|\||[<>!])/.exec(src.slice(i));
    if (op) {
      out.push({ t: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    if ('()[].,*'.includes(c)) {
      out.push({ t: 'punc', v: c });
      i++;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new ExprError(`Unexpected symbol: '${c}'. Located at position ${i + 1} within expression: ${src}`);
  }
  return out;
}

export function truthy(v: V): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '' || Number.isNaN(v)) return false;
  return true;
}

/** Coercion GitHub uses for comparisons: numbers compare as numbers, strings case-insensitively. */
function toNum(v: V): number {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isNaN(n) ? NaN : n;
  }
  return NaN;
}

function equals(a: V, b: V): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b && (typeof a === 'object' || typeof a === 'boolean')) return a === b;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return toNum(a) === toNum(b);
}

function compare(a: V, b: V): number {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  return toNum(a) - toNum(b);
}

export function str(v: V): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

function getProp(obj: V, key: string): V {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj) && key === '*') return obj;
  if (typeof obj !== 'object') return null;
  // Property names are case-insensitive.
  if (key in obj) return obj[key];
  const k = Object.keys(obj).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? null : obj[k];
}

const FUNCS: Record<string, (ctx: ExprContext, args: V[]) => V> = {
  success: (c) => c.status.success,
  failure: (c) => c.status.failure,
  always: () => true,
  cancelled: (c) => c.status.cancelled,
  contains: (_c, [a, b]) => (Array.isArray(a) ? a.some((x) => equals(x, b)) : str(a).toLowerCase().includes(str(b).toLowerCase())),
  startswith: (_c, [a, b]) => str(a).toLowerCase().startsWith(str(b).toLowerCase()),
  endswith: (_c, [a, b]) => str(a).toLowerCase().endsWith(str(b).toLowerCase()),
  format: (_c, [f, ...rest]) => str(f).replace(/\{(\d+)\}/g, (_m, i) => str(rest[Number(i)])),
  join: (_c, [a, sep]) => (Array.isArray(a) ? a.map(str).join(sep === undefined ? ',' : str(sep)) : str(a)),
  tojson: (_c, [a]) => JSON.stringify(a ?? null, null, 2),
  fromjson: (_c, [a]) => {
    try {
      return JSON.parse(str(a));
    } catch {
      throw new ExprError(`Error parsing fromJson`);
    }
  },
  hashfiles: (c, args) => (c.hashFiles ? c.hashFiles(args.map(str)) : ''),
};

export function evaluate(src: string, ctx: ExprContext): V {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const expect = (v: string) => {
    const t = take();
    if (!t || t.v !== v) throw new ExprError(`Unexpected end of expression: '${src}'. Located at position ${src.length} within expression: ${src}`);
  };
  const primary = (): V => {
    const t = take();
    if (!t) throw new ExprError(`Unexpected end of expression: '${src}'. Located at position ${src.length} within expression: ${src}`);
    let v: V;
    if (t.t === 'str') v = t.v;
    else if (t.t === 'num') v = Number(t.v);
    else if (t.v === '(') {
      v = or();
      expect(')');
    } else if (t.t === 'op' && t.v === '!') return !truthy(primary());
    else if (t.t === 'id') {
      const name = t.v;
      if (name === 'true' || name === 'false') v = name === 'true';
      else if (name === 'null') v = null;
      else if (peek()?.v === '(') {
        take();
        const args: V[] = [];
        if (peek()?.v !== ')') {
          for (;;) {
            args.push(or());
            if (peek()?.v === ',') {
              take();
              continue;
            }
            break;
          }
        }
        expect(')');
        const fn = FUNCS[name.toLowerCase()];
        if (!fn) throw new ExprError(`Unrecognized function: '${name}'. Located at position ${src.indexOf(name) + 1} within expression: ${src}`);
        v = fn(ctx, args);
      } else {
        const key = Object.keys(ctx.contexts).find((k) => k.toLowerCase() === name.toLowerCase());
        if (key === undefined) throw new ExprError(`Unrecognized named-value: '${name}'. Located at position ${src.indexOf(name) + 1} within expression: ${src}`);
        v = ctx.contexts[key];
      }
    } else throw new ExprError(`Unexpected symbol: '${t.v}'. Located at position ${src.indexOf(t.v) + 1} within expression: ${src}`);
    // Property access: a.b, a['b'], a.*.b (the `*` filter maps over every element)
    let spread = false;
    for (;;) {
      const n = peek();
      if (n?.v === '.') {
        take();
        const k = take();
        if (!k) throw new ExprError(`Unexpected end of expression: '${src}'`);
        if (k.v === '*') {
          v = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [];
          spread = true;
        } else v = spread ? (v as V[]).map((x) => getProp(x, k.v)) : getProp(v, k.v);
      } else if (n?.v === '[') {
        take();
        const k = or();
        expect(']');
        v = Array.isArray(v) && typeof k === 'number' ? v[k] ?? null : getProp(v, str(k));
      } else break;
    }
    return v;
  };
  const cmp = (): V => {
    let a = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !['==', '!=', '<', '>', '<=', '>='].includes(t.v)) return a;
      take();
      const b = primary();
      switch (t.v) {
        case '==':
          a = equals(a, b);
          break;
        case '!=':
          a = !equals(a, b);
          break;
        case '<':
          a = compare(a, b) < 0;
          break;
        case '>':
          a = compare(a, b) > 0;
          break;
        case '<=':
          a = compare(a, b) <= 0;
          break;
        default:
          a = compare(a, b) >= 0;
      }
    }
  };
  const and = (): V => {
    let a = cmp();
    while (peek()?.v === '&&') {
      take();
      const b = cmp();
      a = truthy(a) ? b : a;
    }
    return a;
  };
  const or = (): V => {
    let a = and();
    while (peek()?.v === '||') {
      take();
      const b = and();
      a = truthy(a) ? a : b;
    }
    return a;
  };
  const v = or();
  if (i < toks.length) throw new ExprError(`Unexpected symbol: '${toks[i].v}'. Located at position ${src.indexOf(toks[i].v) + 1} within expression: ${src}`);
  return v;
}

/** Does an `if:` use a status function? If not, GitHub wraps it in `success() && (...)`. */
export function hasStatusCheck(src: string): boolean {
  return /\b(success|failure|always|cancelled)\s*\(/i.test(src);
}

/** Replace every `${{ … }}` in a string. */
export function interpolate(text: string, ctx: ExprContext): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_m, e: string) => str(evaluate(e.trim(), ctx)));
}

/** Evaluate an `if:` condition the way the runner does. */
export function condition(src: string | boolean | undefined, ctx: ExprContext): boolean {
  if (src === undefined) return ctx.status.success;
  if (typeof src === 'boolean') return src && ctx.status.success;
  let e = src.trim();
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(e);
  if (m) e = m[1].trim();
  if (!hasStatusCheck(e)) return ctx.status.success && truthy(evaluate(e, ctx));
  return truthy(evaluate(e, ctx));
}
