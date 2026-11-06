/** A JMESPath subset for `aws --query`: fields, indexes, [] / [*] / [?filter] projections, multiselect, pipes, a few functions. */

export class JmesError extends Error {}

type Tok = { t: string; v?: unknown };

function lex(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '[]', '[?', '[*'].includes(two)) {
      if (two === '[*') {
        if (s[i + 2] !== ']') throw new JmesError(`Bad jmespath expression: Unknown token '*'`);
        out.push({ t: '[*]' });
        i += 3;
        continue;
      }
      out.push({ t: two });
      i += 2;
      continue;
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw new JmesError('Bad jmespath expression: Unclosed \' delimiter');
      out.push({ t: 'lit', v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j < 0) throw new JmesError('Bad jmespath expression: Unclosed ` delimiter');
      const raw = s.slice(i + 1, j).trim();
      let v: unknown;
      try {
        v = JSON.parse(raw);
      } catch {
        v = raw;
      }
      out.push({ t: 'lit', v });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      out.push({ t: 'id', v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+/.exec(s.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][\w-]*/.exec(s.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0].replace(/-$/, '') });
      i += id[0].replace(/-$/, '').length;
      continue;
    }
    if ('.[]{}(),:|<>!@*'.includes(c)) {
      out.push({ t: c });
      i++;
      continue;
    }
    throw new JmesError(`Bad jmespath expression: Unknown token '${c}'`);
  }
  return out;
}

type Ast =
  | { k: 'field'; name: string }
  | { k: 'index'; n: number }
  | { k: 'lit'; v: unknown }
  | { k: 'cur' }
  | { k: 'chain'; base: Ast; ops: Op[] }
  | { k: 'pipe'; l: Ast; r: Ast }
  | { k: 'or' | 'and'; l: Ast; r: Ast }
  | { k: 'not'; e: Ast }
  | { k: 'cmp'; op: string; l: Ast; r: Ast }
  | { k: 'list'; items: Ast[] }
  | { k: 'hash'; items: [string, Ast][] }
  | { k: 'fn'; name: string; args: Ast[] };

type Op = { k: 'field'; name: string } | { k: 'index'; n: number } | { k: 'flatten' } | { k: 'wild' } | { k: 'filter'; e: Ast } | { k: 'select'; e: Ast };

class P {
  i = 0;
  constructor(private t: Tok[]) {}
  peek(t?: string) {
    return this.t[this.i] && (t === undefined || this.t[this.i].t === t);
  }
  take(t: string) {
    if (!this.peek(t)) throw new JmesError(`Bad jmespath expression: expected '${t}'`);
    return this.t[this.i++];
  }
  expr(): Ast {
    let l = this.or();
    while (this.peek('|')) {
      this.i++;
      l = { k: 'pipe', l, r: this.or() };
    }
    return l;
  }
  or(): Ast {
    let l = this.and();
    while (this.peek('||')) {
      this.i++;
      l = { k: 'or', l, r: this.and() };
    }
    return l;
  }
  and(): Ast {
    let l = this.not();
    while (this.peek('&&')) {
      this.i++;
      l = { k: 'and', l, r: this.not() };
    }
    return l;
  }
  not(): Ast {
    if (this.peek('!')) {
      this.i++;
      return { k: 'not', e: this.not() };
    }
    return this.cmp();
  }
  cmp(): Ast {
    const l = this.chain();
    const t = this.t[this.i]?.t;
    if (t && ['==', '!=', '<', '>', '<=', '>='].includes(t)) {
      this.i++;
      return { k: 'cmp', op: t, l, r: this.chain() };
    }
    return l;
  }
  chain(): Ast {
    let base: Ast;
    const ops: Op[] = [];
    const t = this.t[this.i];
    if (!t) throw new JmesError('Bad jmespath expression: unexpected end');
    if (t.t === 'id' && this.t[this.i + 1]?.t === '(') {
      this.i += 2;
      const args: Ast[] = [];
      while (!this.peek(')')) {
        args.push(this.expr());
        if (this.peek(',')) this.i++;
      }
      this.i++;
      base = { k: 'fn', name: String(t.v), args };
    } else if (t.t === 'id') {
      this.i++;
      base = { k: 'cur' };
      ops.push({ k: 'field', name: String(t.v) });
    } else if (t.t === 'lit' || t.t === 'num') {
      this.i++;
      base = { k: 'lit', v: t.v };
    } else if (t.t === '@') {
      this.i++;
      base = { k: 'cur' };
    } else if (t.t === '(') {
      this.i++;
      base = this.expr();
      this.take(')');
    } else if (t.t === '{') {
      base = this.hash();
    } else if (t.t === '[' && this.t[this.i + 1]?.t !== 'num') {
      base = this.list();
    } else if (t.t === '*') {
      this.i++;
      base = { k: 'cur' };
      ops.push({ k: 'wild' });
    } else base = { k: 'cur' };
    for (;;) {
      const x = this.t[this.i];
      if (!x) break;
      if (x.t === '.') {
        this.i++;
        const y = this.t[this.i];
        if (y?.t === 'id') {
          this.i++;
          ops.push({ k: 'field', name: String(y.v) });
        } else if (y?.t === '{') ops.push({ k: 'select', e: this.hash() });
        else if (y?.t === '[') ops.push({ k: 'select', e: this.list() });
        else if (y?.t === '*') {
          this.i++;
          ops.push({ k: 'wild' });
        } else throw new JmesError('Bad jmespath expression: expected identifier after .');
      } else if (x.t === '[' && this.t[this.i + 1]?.t === 'num') {
        this.i++;
        ops.push({ k: 'index', n: Number(this.take('num').v) });
        this.take(']');
      } else if (x.t === '[]') {
        this.i++;
        ops.push({ k: 'flatten' });
      } else if (x.t === '[*]') {
        this.i++;
        ops.push({ k: 'wild' });
      } else if (x.t === '[?') {
        this.i++;
        const e = this.expr();
        this.take(']');
        ops.push({ k: 'filter', e });
      } else break;
    }
    return ops.length ? { k: 'chain', base, ops } : base;
  }
  list(): Ast {
    this.take('[');
    const items: Ast[] = [];
    while (!this.peek(']')) {
      items.push(this.expr());
      if (this.peek(',')) this.i++;
    }
    this.i++;
    return { k: 'list', items };
  }
  hash(): Ast {
    this.take('{');
    const items: [string, Ast][] = [];
    while (!this.peek('}')) {
      const key = String(this.take('id').v);
      this.take(':');
      items.push([key, this.expr()]);
      if (this.peek(',')) this.i++;
    }
    this.i++;
    return { k: 'hash', items };
  }
}

const truthy = (v: unknown) => !(v === null || v === undefined || v === false || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && v !== null && !Array.isArray(v) && !Object.keys(v).length));

const nonNull = (x: unknown) => x !== null && x !== undefined;

function simple(x: unknown, op: Op): unknown {
  if (op.k === 'field') return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>)[op.name] ?? null : null;
  if (op.k === 'index') return Array.isArray(x) ? x[op.n < 0 ? x.length + op.n : op.n] ?? null : null;
  if (op.k === 'select') return x === null || x === undefined ? null : evaluate(op.e, x);
  return x;
}

/** Flatten (`[]`) applies to everything on its left; `[*]` / `[?]` project the rest of the chain. */
function applyOps(v: unknown, ops: Op[]): unknown {
  let k = -1;
  for (let i = ops.length - 1; i >= 0; i--) if (ops[i].k === 'flatten') {
    k = i;
    break;
  }
  if (k >= 0) {
    const left = applyOps(v, ops.slice(0, k));
    if (!Array.isArray(left)) return null;
    const arr = left.flatMap((x) => (Array.isArray(x) ? x : [x])).filter(nonNull);
    const rest = ops.slice(k + 1);
    return rest.length ? arr.map((x) => applyOps(x, rest)).filter(nonNull) : arr;
  }
  const w = ops.findIndex((o) => o.k === 'wild' || o.k === 'filter');
  if (w >= 0) {
    const left = applyOps(v, ops.slice(0, w));
    const op = ops[w];
    let src: unknown[] | null = Array.isArray(left) ? left : op.k === 'wild' && left && typeof left === 'object' ? Object.values(left) : null;
    if (src === null) return null;
    if (op.k === 'filter') src = src.filter((x) => truthy(evaluate(op.e, x)));
    const rest = ops.slice(w + 1);
    return rest.length ? src.map((x) => applyOps(x, rest)).filter(nonNull) : src;
  }
  return ops.reduce((x, op) => simple(x, op), v);
}

function cmp(op: string, a: unknown, b: unknown): boolean {
  if (op === '==') return JSON.stringify(a) === JSON.stringify(b);
  if (op === '!=') return JSON.stringify(a) !== JSON.stringify(b);
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
}

const FNS: Record<string, (...a: unknown[]) => unknown> = {
  length: (x) => (Array.isArray(x) || typeof x === 'string' ? x.length : x && typeof x === 'object' ? Object.keys(x).length : null),
  sum: (x) => (x as number[]).reduce((a, b) => a + b, 0),
  max: (x) => Math.max(...(x as number[])),
  min: (x) => Math.min(...(x as number[])),
  sort: (x) => [...(x as unknown[])].sort(),
  join: (sep, x) => (x as unknown[]).join(String(sep)),
  contains: (x, y) => (Array.isArray(x) ? x.includes(y) : String(x).includes(String(y))),
  starts_with: (x, y) => String(x).startsWith(String(y)),
  keys: (x) => Object.keys(x as object),
  to_string: (x) => (typeof x === 'string' ? x : JSON.stringify(x)),
};

export function evaluate(a: Ast, v: unknown): unknown {
  switch (a.k) {
    case 'cur':
      return v;
    case 'lit':
      return a.v;
    case 'field':
      return applyOps(v, [{ k: 'field', name: a.name }]);
    case 'index':
      return applyOps(v, [{ k: 'index', n: a.n }]);
    case 'chain':
      return applyOps(evaluate(a.base, v), a.ops);
    case 'pipe':
      return evaluate(a.r, evaluate(a.l, v));
    case 'or': {
      const l = evaluate(a.l, v);
      return truthy(l) ? l : evaluate(a.r, v);
    }
    case 'and': {
      const l = evaluate(a.l, v);
      return truthy(l) ? evaluate(a.r, v) : l;
    }
    case 'not':
      return !truthy(evaluate(a.e, v));
    case 'cmp':
      return cmp(a.op, evaluate(a.l, v), evaluate(a.r, v));
    case 'list':
      return a.items.map((x) => evaluate(x, v));
    case 'hash':
      return Object.fromEntries(a.items.map(([k, x]) => [k, evaluate(x, v)]));
    case 'fn': {
      const f = FNS[a.name];
      if (!f) throw new JmesError(`Unknown function: ${a.name}()`);
      return f(...a.args.map((x) => evaluate(x, v)));
    }
  }
}

export function jmes(expr: string, data: unknown): unknown {
  const p = new P(lex(expr));
  const ast = p.expr();
  if (p.peek()) throw new JmesError(`Bad jmespath expression: Unexpected token: ${String((p as unknown as { t: Tok[] }).t[p.i].v ?? (p as unknown as { t: Tok[] }).t[p.i].t)}`);
  return evaluate(ast, data);
}
