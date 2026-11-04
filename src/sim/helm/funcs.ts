/** Go template builtins plus the Sprig/Helm functions charts commonly use. */
import { stringify } from 'yaml';
import type { ExecEnv } from './exec';
import type { Pos } from './parse';

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;
type Fn = (env: ExecEnv, pos: Pos, ...args: V[]) => V;

/** Go's %v for a float64 (strconv 'g' with shortest precision): 1e+06, 3, 0.5. */
export function goFloat(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? '+Inf' : n < 0 ? '-Inf' : 'NaN';
  if (n === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(n)));
  return exp < -4 || exp >= 6 ? expForm(n) : String(n);
}

function expForm(n: number): string {
  const [m, e] = n.toExponential().split('e');
  const ei = Number(e);
  return `${m}e${ei < 0 ? '-' : '+'}${String(Math.abs(ei)).padStart(2, '0')}`;
}

/** How Go's fmt %v prints a value. */
export function goString(v: V): string {
  if (v === undefined) return '<no value>';
  if (v === null) return '<nil>';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return goFloat(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(goString).join(' ')}]`;
  if (typeof v === 'object') return `map[${Object.keys(v).sort().map((k) => `${k}:${goString(v[k])}`).join(' ')}]`;
  return String(v);
}

export function isEmpty(v: V): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function sortKeys(v: V): V {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** Helm's toYaml: keys sorted (it goes through JSON), no trailing newline. */
export function toYaml(v: V): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return '{}';
  if (Array.isArray(v) && !v.length) return '[]';
  return stringify(sortKeys(v), { lineWidth: 0, aliasDuplicateObjects: false }).replace(/\n$/, '');
}

const str = (v: V) => (v === undefined || v === null ? '' : goString(v));
const num = (v: V) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : typeof v === 'boolean' ? Number(v) : 0);

function goQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

/** fmt.Sprintf for the verbs templates use. */
export function sprintf(format: string, args: V[]): string {
  let i = 0;
  return format.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([sdvqfgtxXT%])/g, (_m, flags: string, width: string | undefined, prec: string | undefined, verb: string) => {
    if (verb === '%') return '%';
    if (i >= args.length) return `%!${verb}(MISSING)`;
    const a = args[i++];
    let s: string;
    switch (verb) {
      case 'd':
        s = typeof a === 'number' ? String(Math.trunc(a)) : `%!d(${typeof a === 'string' ? 'string=' + a : goString(a)})`;
        break;
      case 'f':
        s = num(a).toFixed(prec !== undefined ? Number(prec) : 6);
        break;
      case 'g':
        s = goFloat(num(a));
        break;
      case 'q':
        s = goQuote(str(a));
        break;
      case 'x':
      case 'X':
        s = typeof a === 'number' ? a.toString(16) : [...new TextEncoder().encode(str(a))].map((b) => b.toString(16).padStart(2, '0')).join('');
        if (verb === 'X') s = s.toUpperCase();
        break;
      case 't':
        s = String(!!a);
        break;
      case 'T':
        s = typeof a === 'string' ? 'string' : typeof a === 'number' ? 'float64' : typeof a === 'boolean' ? 'bool' : Array.isArray(a) ? '[]interface {}' : a === null || a === undefined ? '<nil>' : 'map[string]interface {}';
        break;
      default:
        s = a === undefined ? '<nil>' : goString(a);
        if (prec !== undefined && verb === 's') s = s.slice(0, Number(prec));
    }
    if (width) s = flags.includes('-') ? s.padEnd(Number(width)) : s.padStart(Number(width), flags.includes('0') ? '0' : ' ');
    return s;
  });
}

function hash(s: string): string {
  // Deterministic stand-in for sha256sum (64 hex chars).
  let h1 = 0x811c9dc5;
  let out = '';
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < s.length; i++) h1 = Math.imul(h1 ^ s.charCodeAt(i) ^ round, 16777619) >>> 0;
    out += h1.toString(16).padStart(8, '0');
  }
  return out;
}

function semverParts(v: string): number[] {
  const m = /v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0];
}

function cmpVer(a: string, b: string): number {
  const x = semverParts(a);
  const y = semverParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function semverCompare(constraint: string, version: string): boolean {
  return constraint.split(',').every((part) => {
    const m = /^\s*(>=|<=|>|<|=|!=|\^|~)?\s*(.+?)\s*$/.exec(part);
    if (!m) return false;
    const c = cmpVer(version, m[2].replace(/-0$/, ''));
    switch (m[1] ?? '=') {
      case '>=':
        return c >= 0;
      case '<=':
        return c <= 0;
      case '>':
        return c > 0;
      case '<':
        return c < 0;
      case '!=':
        return c !== 0;
      case '^':
        return c >= 0 && semverParts(version)[0] === semverParts(m[2])[0];
      case '~':
        return c >= 0 && semverParts(version)[1] === semverParts(m[2])[1];
      default:
        return c === 0;
    }
  });
}

const cmp = (a: V, b: V) => (typeof a === 'number' && typeof b === 'number' ? a - b : str(a) < str(b) ? -1 : str(a) > str(b) ? 1 : 0);

function deepMerge(dst: V, src: V): V {
  for (const [k, v] of Object.entries(src ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v);
    else if (!(k in dst)) dst[k] = v;
  }
  return dst;
}

let randSeq = 0;

export const FUNCS: Record<string, Fn> = {
  // ---- Go builtins
  not: (_e, _p, v) => !isTruthy(v),
  len: (_e, _p, v) => {
    if (typeof v === 'string' || Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
    throw new Error(`len of ${v === undefined || v === null ? 'nil pointer' : 'type ' + typeof v}`);
  },
  index: (_e, _p, v, ...keys) => {
    let cur = v;
    for (const k of keys) {
      if (cur === undefined || cur === null) return undefined;
      if (Array.isArray(cur) && (typeof k !== 'number' || k >= cur.length || k < 0)) throw new Error(`index out of range: ${k}`);
      cur = cur[k];
    }
    return cur;
  },
  print: (_e, _p, ...a) => a.map(goString).join(''),
  println: (_e, _p, ...a) => a.map(goString).join(' ') + '\n',
  printf: (_e, _p, f, ...a) => sprintf(str(f), a),
  eq: (_e, _p, a, ...bs) => bs.some((b) => a === b || (a == null && b == null)),
  ne: (_e, _p, a, b) => a !== b,
  lt: (_e, _p, a, b) => cmp(a, b) < 0,
  le: (_e, _p, a, b) => cmp(a, b) <= 0,
  gt: (_e, _p, a, b) => cmp(a, b) > 0,
  ge: (_e, _p, a, b) => cmp(a, b) >= 0,
  html: (_e, _p, s) => str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;'),
  js: (_e, _p, s) => str(s).replace(/['"\\]/g, (c) => '\\' + c),
  urlquery: (_e, _p, ...a) => encodeURIComponent(a.map(str).join('')),
  slice: (_e, _p, v, i = 0, j) => v.slice(i, j),
  // ---- Helm
  include: (env, _p, name, data) => env.set.include(str(name), data, env.file),
  tpl: (env, _p, src, data) => env.tpl(str(src), data),
  required: (env, pos, msg, v) => {
    if (v === undefined || v === null || v === '') throw env.err(pos, str(msg), 'execution');
    return v;
  },
  fail: (env, pos, msg) => {
    throw env.err(pos, str(msg), 'execution');
  },
  toYaml: (_e, _p, v) => toYaml(v),
  toJson: (_e, _p, v) => JSON.stringify(sortKeys(v) ?? null),
  mustToJson: (_e, _p, v) => JSON.stringify(sortKeys(v) ?? null),
  toPrettyJson: (_e, _p, v) => JSON.stringify(sortKeys(v) ?? null, null, 2),
  fromYaml: () => ({}),
  lookup: () => ({}),
  // ---- Sprig: defaults & logic
  default: (_e, _p, d, ...given) => (given.length === 0 || isEmpty(given[0]) ? d : given[0]),
  empty: (_e, _p, v) => isEmpty(v),
  coalesce: (_e, _p, ...a) => a.find((x) => !isEmpty(x)),
  ternary: (_e, _p, a, b, cond) => (cond ? a : b),
  // ---- strings
  quote: (_e, _p, ...a) => a.filter((x) => x !== undefined && x !== null).map((x) => goQuote(goString(x))).join(' '),
  squote: (_e, _p, ...a) => a.filter((x) => x !== undefined && x !== null).map((x) => `'${goString(x)}'`).join(' '),
  upper: (_e, _p, s) => str(s).toUpperCase(),
  lower: (_e, _p, s) => str(s).toLowerCase(),
  title: (_e, _p, s) => str(s).replace(/\b\w/g, (c) => c.toUpperCase()),
  trim: (_e, _p, s) => str(s).trim(),
  trimAll: (_e, _p, c, s) => str(s).replace(new RegExp(`^[${str(c).replace(/[\]\\^-]/g, '\\$&')}]+|[${str(c).replace(/[\]\\^-]/g, '\\$&')}]+$`, 'g'), ''),
  trimSuffix: (_e, _p, suf, s) => (str(s).endsWith(str(suf)) && str(suf) ? str(s).slice(0, -str(suf).length) : str(s)),
  trimPrefix: (_e, _p, pre, s) => (str(s).startsWith(str(pre)) ? str(s).slice(str(pre).length) : str(s)),
  trunc: (_e, _p, n, s) => (n >= 0 ? str(s).slice(0, n) : str(s).slice(n)),
  replace: (_e, _p, old, nw, s) => str(s).split(str(old)).join(str(nw)),
  contains: (_e, _p, sub, s) => str(s).includes(str(sub)),
  hasPrefix: (_e, _p, pre, s) => str(s).startsWith(str(pre)),
  hasSuffix: (_e, _p, suf, s) => str(s).endsWith(str(suf)),
  indent: (_e, _p, n, s) => {
    const pad = ' '.repeat(n);
    return pad + str(s).split('\n').join('\n' + pad);
  },
  nindent: (_e, _p, n, s) => {
    const pad = ' '.repeat(n);
    return '\n' + pad + str(s).split('\n').join('\n' + pad);
  },
  repeat: (_e, _p, n, s) => str(s).repeat(Math.max(0, n)),
  nospace: (_e, _p, s) => str(s).replace(/\s+/g, ''),
  cat: (_e, _p, ...a) => a.filter((x) => x !== undefined && x !== null).map(goString).join(' '),
  snakecase: (_e, _p, s) => str(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase(),
  kebabcase: (_e, _p, s) => str(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase(),
  b64enc: (_e, _p, s) => btoa(unescape(encodeURIComponent(str(s)))),
  b64dec: (_e, _p, s) => decodeURIComponent(escape(atob(str(s)))),
  sha256sum: (_e, _p, s) => hash(str(s)),
  randAlphaNum: (_e, _p, n) => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < n; i++) out += chars[(Math.imul(++randSeq, 2654435761) >>> 0) % chars.length];
    return out;
  },
  split: (_e, _p, sep, s) => Object.fromEntries(str(s).split(str(sep)).map((x, i) => [`_${i}`, x])),
  splitList: (_e, _p, sep, s) => str(s).split(str(sep)),
  join: (_e, _p, sep, l) => (Array.isArray(l) ? l.map(goString).join(str(sep)) : str(l)),
  regexMatch: (_e, _p, re, s) => new RegExp(str(re)).test(str(s)),
  regexReplaceAll: (_e, _p, re, s, repl) => str(s).replace(new RegExp(str(re), 'g'), str(repl).replace(/\$\{?(\d+)\}?/g, '$$$1')),
  toString: (_e: ExecEnv, _p: Pos, v: V): V => str(v),
  toStrings: (_e, _p, l) => (l ?? []).map(str),
  // ---- numbers
  int: (_e, _p, v) => Math.trunc(num(v)),
  int64: (_e, _p, v) => Math.trunc(num(v)),
  float64: (_e, _p, v) => num(v),
  atoi: (_e, _p, v) => Math.trunc(num(v)),
  add: (_e, _p, ...a) => a.reduce((x, y) => x + num(y), 0),
  add1: (_e, _p, v) => num(v) + 1,
  sub: (_e, _p, a, b) => num(a) - num(b),
  mul: (_e, _p, ...a) => a.reduce((x, y) => x * num(y), 1),
  div: (_e, _p, a, b) => Math.trunc(num(a) / num(b)),
  mod: (_e, _p, a, b) => num(a) % num(b),
  max: (_e, _p, ...a) => Math.max(...a.map(num)),
  min: (_e, _p, ...a) => Math.min(...a.map(num)),
  until: (_e, _p, n) => Array.from({ length: Math.max(0, num(n)) }, (_, i) => i),
  untilStep: (_e, _p, a, b, step) => {
    const out: number[] = [];
    for (let i = num(a); step > 0 ? i < num(b) : i > num(b); i += num(step)) out.push(i);
    return out;
  },
  // ---- lists & dicts
  list: (_e, _p, ...a) => a,
  tuple: (_e, _p, ...a) => a,
  first: (_e, _p, l) => (l ?? [])[0],
  last: (_e, _p, l) => (l ?? [])[(l ?? []).length - 1],
  rest: (_e, _p, l) => (l ?? []).slice(1),
  initial: (_e, _p, l) => (l ?? []).slice(0, -1),
  append: (_e, _p, l, v) => [...(l ?? []), v],
  prepend: (_e, _p, l, v) => [v, ...(l ?? [])],
  concat: (_e, _p, ...ls) => ls.flatMap((l) => l ?? []),
  has: (_e, _p, v, l) => (l ?? []).includes(v),
  without: (_e, _p, l, ...vs) => (l ?? []).filter((x: V) => !vs.includes(x)),
  uniq: (_e, _p, l) => [...new Set(l ?? [])],
  compact: (_e, _p, l) => (l ?? []).filter((x: V) => !isEmpty(x)),
  sortAlpha: (_e, _p, l) => [...(l ?? [])].map(str).sort(),
  reverse: (_e, _p, l) => [...(l ?? [])].reverse(),
  dict: (_e, _p, ...a) => {
    const out: Record<string, V> = {};
    for (let i = 0; i < a.length; i += 2) out[str(a[i])] = a[i + 1] ?? '';
    return out;
  },
  get: (_e, _p, d, k) => (d ?? {})[str(k)] ?? '',
  set: (_e, _p, d, k, v) => {
    d[str(k)] = v;
    return d;
  },
  unset: (_e, _p, d, k) => {
    delete d[str(k)];
    return d;
  },
  hasKey: (_e, _p, d, k) => Object.prototype.hasOwnProperty.call(d ?? {}, str(k)),
  keys: (_e, _p, ...ds) => ds.flatMap((d) => Object.keys(d ?? {})),
  values: (_e, _p, d) => Object.values(d ?? {}),
  pick: (_e, _p, d, ...ks) => Object.fromEntries(Object.entries(d ?? {}).filter(([k]) => ks.includes(k))),
  omit: (_e, _p, d, ...ks) => Object.fromEntries(Object.entries(d ?? {}).filter(([k]) => !ks.includes(k))),
  merge: (_e, _p, dst, ...srcs) => srcs.reduce((acc, s) => deepMerge(acc, s), dst),
  mergeOverwrite: (_e, _p, dst, ...srcs) => srcs.reduce((acc, s) => Object.assign(acc, JSON.parse(JSON.stringify(s ?? {}))), dst),
  deepCopy: (_e, _p, v) => JSON.parse(JSON.stringify(v ?? null)),
  // ---- types
  kindIs: (_e, _p, kind, v) => kindOf(v) === kind,
  kindOf: (_e, _p, v) => kindOf(v),
  typeOf: (_e, _p, v) => (typeof v === 'string' ? 'string' : typeof v === 'number' ? 'float64' : typeof v === 'boolean' ? 'bool' : Array.isArray(v) ? '[]interface {}' : v == null ? '<nil>' : 'map[string]interface {}'),
  semverCompare: (_e, _p, c, v) => semverCompare(str(c), str(v)),
  // ---- time (fixed, so renders are deterministic)
  now: () => '2026-11-03 09:00:00.000000000 +0000 UTC',
  date: (_e, _p, _fmt, _t) => '2026-11-03',
  uuidv4: () => '6f1c2a54-9d3e-4b8a-a1f0-7c2d9e4b5a63',
};

function kindOf(v: V): string {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'float64';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return 'slice';
  if (v === null || v === undefined) return 'invalid';
  return 'map';
}

function isTruthy(v: V): boolean {
  return !isEmpty(v);
}
