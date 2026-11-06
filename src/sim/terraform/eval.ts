/** Evaluates HCL expressions, with values that are unknown until apply. */
import type { Expr, Pos } from './hcl';

/** "(known after apply)". */
export class Unknown {
  readonly unknownAfterApply = true;
  static readonly it = new Unknown();
}
export const UNKNOWN = Unknown.it;
export const isUnknown = (v: unknown): v is Unknown => v instanceof Unknown;

/** A sensitive value (shown as "(sensitive value)"). */
export class Sensitive {
  constructor(public v: unknown) {}
}

/** Marker for a failed try()/can() argument. */
export const TRY_FAILED = { tryFailed: true };

export class EvalError extends Error {
  constructor(public summary: string, public detail: string, public pos: Pos, public src = '') {
    super(summary);
  }
}

export interface Scope {
  /** Resolve the first part of a reference (var, local, aws_x, data, module, count, each, path...). */
  root(name: string, e: Expr): unknown;
  fn?: Record<string, (args: unknown[], pos: Pos) => unknown>;
  /** Read a file relative to the module (file(), templatefile()). */
  readFile?(path: string): string | null;
  vars?: Record<string, unknown>;
}

export function deepUnknown(v: unknown): boolean {
  if (isUnknown(v)) return true;
  if (Array.isArray(v)) return v.some(deepUnknown);
  if (v && typeof v === 'object' && !(v instanceof Sensitive)) return Object.values(v).some(deepUnknown);
  if (v instanceof Sensitive) return deepUnknown(v.v);
  return false;
}

export function unwrap(v: unknown): unknown {
  return v instanceof Sensitive ? unwrap(v.v) : v;
}

export function typeName(v: unknown): string {
  v = unwrap(v);
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'tuple';
  if (typeof v === 'object') return 'object';
  return typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : 'bool';
}

export function toStr(v: unknown, pos: Pos): string {
  v = unwrap(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (v === null) throw new EvalError('Invalid template interpolation value', 'The expression result is null. Cannot include a null value in a string template.', pos);
  throw new EvalError('Invalid template interpolation value', `Cannot include the given value in a string template: string required, but have ${typeName(v)}.`, pos);
}

function attrOf(v: unknown, key: string, e: Expr): unknown {
  if (isUnknown(v)) return UNKNOWN;
  if (v instanceof Sensitive) return new Sensitive(attrOf(v.v, key, e));
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (key in (v as object)) return (v as Record<string, unknown>)[key];
    throw new EvalError('Unsupported attribute', `This object does not have an attribute named "${key}".`, e.pos, e.src);
  }
  if (Array.isArray(v)) throw new EvalError('Unsupported attribute', `Can't access attributes on a list of objects. Did you mean to access attribute "${key}" for a specific element of the list, or across all elements of the list?`, e.pos, e.src);
  throw new EvalError('Unsupported attribute', `Can't access attributes on a primitive-typed value (${typeName(v)}).`, e.pos, e.src);
}

function indexOf(v: unknown, k: unknown, e: Expr): unknown {
  if (isUnknown(v) || isUnknown(k)) return UNKNOWN;
  if (v instanceof Sensitive) return new Sensitive(indexOf(v.v, k, e));
  if (Array.isArray(v)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 0 || n >= v.length) throw new EvalError('Invalid index', `The given key does not identify an element in this collection value: the collection has ${v.length} element${v.length === 1 ? '' : 's'}.`, e.pos, e.src);
    return v[n];
  }
  if (v && typeof v === 'object') {
    const key = String(k);
    if (!(key in (v as object))) throw new EvalError('Invalid index', `The given key does not identify an element in this collection value.`, e.pos, e.src);
    return (v as Record<string, unknown>)[key];
  }
  throw new EvalError('Invalid index', 'This value does not have any indices.', e.pos, e.src);
}

const num = (v: unknown, pos: Pos): number => {
  v = unwrap(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  throw new EvalError('Invalid operand', `Unsuitable value for left operand: a number is required.`, pos);
};

const bool = (v: unknown, pos: Pos): boolean => {
  v = unwrap(v);
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'false') return v === 'true';
  throw new EvalError('Invalid operand', `Unsuitable value for left operand: a bool is required.`, pos);
};

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(unwrap(a)) === JSON.stringify(unwrap(b));
}

export function evaluate(e: Expr, s: Scope): unknown {
  switch (e.t) {
    case 'lit':
      return e.v;
    case 'tmpl': {
      let out = '';
      let sens = false;
      for (const p of e.parts) {
        if (typeof p === 'string') out += p;
        else {
          const v = evaluate(p, s);
          if (deepUnknown(v)) return UNKNOWN;
          if (v instanceof Sensitive) sens = true;
          out += toStr(v, p.pos);
        }
      }
      return sens ? new Sensitive(out) : out;
    }
    case 'var':
      return s.root(e.name, e);
    case 'get':
      return attrOf(evaluate(e.obj, s), e.key, e);
    case 'index':
      return indexOf(evaluate(e.obj, s), evaluate(e.idx, s), e);
    case 'splat': {
      let v = unwrap(evaluate(e.obj, s));
      if (isUnknown(v)) return UNKNOWN;
      if (v === null) return [];
      if (!Array.isArray(v)) v = [v];
      return (v as unknown[]).map((item) => {
        let cur = item;
        for (const r of e.restSrc) cur = r.kind === 'get' ? attrOf(cur, r.key!, e) : indexOf(cur, evaluate(r.idx!, s), e);
        return cur;
      });
    }
    case 'list':
      return e.items.map((x) => evaluate(x, s));
    case 'obj': {
      const o: Record<string, unknown> = {};
      for (const it of e.items) {
        const k = it.key.t === 'var' ? it.key.name : evaluate(it.key, s);
        if (isUnknown(k)) return UNKNOWN;
        o[toStr(k, it.key.pos)] = evaluate(it.value, s);
      }
      return o;
    }
    case 'call': {
      const f = s.fn?.[e.name];
      if (!f) throw new EvalError('Call to unknown function', `There is no function named "${e.name}".`, e.pos);
      const lazy = e.name === 'try' || e.name === 'can';
      let args = e.args.map((a) => {
        if (!lazy) return evaluate(a, s);
        try {
          return evaluate(a, s);
        } catch (err) {
          if (err instanceof EvalError) return TRY_FAILED;
          throw err;
        }
      });
      if (e.expand) {
        const last = unwrap(args.pop());
        if (isUnknown(last)) return UNKNOWN;
        args = [...args, ...(last as unknown[])];
      }
      // try() and can() evaluate lazily so errors become fallbacks.
      return f(args, e.pos);
    }
    case 'un': {
      const v = evaluate(e.e, s);
      if (isUnknown(v)) return UNKNOWN;
      return e.op === '!' ? !bool(v, e.pos) : -num(v, e.pos);
    }
    case 'bin': {
      if (e.op === '&&' || e.op === '||') {
        const l = evaluate(e.l, s);
        if (isUnknown(l)) return UNKNOWN;
        const lb = bool(l, e.pos);
        if (e.op === '&&' && !lb) return false;
        if (e.op === '||' && lb) return true;
        const r = evaluate(e.r, s);
        return isUnknown(r) ? UNKNOWN : bool(r, e.pos);
      }
      const l = evaluate(e.l, s);
      const r = evaluate(e.r, s);
      if (isUnknown(l) || isUnknown(r)) return UNKNOWN;
      switch (e.op) {
        case '==':
          return eq(l, r);
        case '!=':
          return !eq(l, r);
        case '+':
          return num(l, e.pos) + num(r, e.pos);
        case '-':
          return num(l, e.pos) - num(r, e.pos);
        case '*':
          return num(l, e.pos) * num(r, e.pos);
        case '/':
          return num(l, e.pos) / num(r, e.pos);
        case '%':
          return num(l, e.pos) % num(r, e.pos);
        case '<':
          return num(l, e.pos) < num(r, e.pos);
        case '>':
          return num(l, e.pos) > num(r, e.pos);
        case '<=':
          return num(l, e.pos) <= num(r, e.pos);
        case '>=':
          return num(l, e.pos) >= num(r, e.pos);
      }
      throw new EvalError('Invalid operator', e.op, e.pos);
    }
    case 'cond': {
      const c = evaluate(e.c, s);
      if (isUnknown(c)) return UNKNOWN;
      return bool(c, e.c.pos) ? evaluate(e.a, s) : evaluate(e.b, s);
    }
    case 'for': {
      const coll = unwrap(evaluate(e.coll, s));
      if (isUnknown(coll)) return UNKNOWN;
      if (coll === null || typeof coll !== 'object') throw new EvalError('Iteration over non-iterable value', `A value of type ${typeName(coll)} cannot be used as the collection in a 'for' expression.`, e.coll.pos);
      const entries: [unknown, unknown][] = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : Object.entries(coll as object);
      const out: unknown[] = [];
      const obj: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        const inner: Scope = { ...s, root: (n, x) => (n === e.v ? v : e.k && n === e.k ? k : s.root(n, x)) };
        if (e.cond) {
          const c = evaluate(e.cond, inner);
          if (isUnknown(c)) return UNKNOWN;
          if (!bool(c, e.cond.pos)) continue;
        }
        if (e.obj) {
          const key = evaluate(e.key!, inner);
          if (isUnknown(key)) return UNKNOWN;
          const ks = toStr(key, e.key!.pos);
          const val = evaluate(e.val, inner);
          if (e.group) ((obj[ks] ??= []) as unknown[]).push(val);
          else {
            if (ks in obj) throw new EvalError('Duplicate object key', `Two different items produced the key "${ks}" in this 'for' expression. If duplicates are expected, use the ellipsis (...) after the value expression to enable grouping by key.`, e.key!.pos);
            obj[ks] = val;
          }
        } else out.push(evaluate(e.val, inner));
      }
      return e.obj ? obj : out;
    }
  }
}
