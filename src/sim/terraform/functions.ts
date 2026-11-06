/** Terraform's built-in functions (the commonly used ones). */
import { deepUnknown, EvalError, isUnknown, Sensitive, TRY_FAILED, typeName, unwrap, UNKNOWN } from './eval';
import type { Pos } from './hcl';

type Fn = (args: unknown[], pos: Pos) => unknown;

const fail = (name: string, msg: string, pos: Pos): never => {
  throw new EvalError('Error in function call', `Call to function "${name}" failed: ${msg}.`, pos);
};

const str = (v: unknown) => String(unwrap(v));
const list = (name: string, v: unknown, pos: Pos): unknown[] => {
  const u = unwrap(v);
  if (Array.isArray(u)) return u;
  return fail(name, `list or set required, got ${typeName(u)}`, pos);
};

function ipNum(ip: string): number {
  return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
}
function numIp(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
}

/** printf-style %s %d %q %v %.2f %05d. */
function format(fmt: string, args: unknown[], pos: Pos): string {
  let i = 0;
  return fmt.replace(/%(-?)(0?)(\d*)(?:\.(\d+))?([sdvqf%t])/g, (_m, minus, zero, width, prec, verb) => {
    if (verb === '%') return '%';
    if (i >= args.length) fail('format', 'not enough arguments for format string', pos);
    const a = unwrap(args[i++]);
    let s: string;
    if (verb === 'd') s = String(Math.trunc(Number(a)));
    else if (verb === 'f') s = Number(a).toFixed(prec ? Number(prec) : 6);
    else if (verb === 'q') s = JSON.stringify(String(a));
    else if (verb === 'v' && typeof a === 'object') s = JSON.stringify(a);
    else s = String(a);
    const w = Number(width || 0);
    if (s.length < w) s = minus ? s.padEnd(w) : s.padStart(w, zero ? '0' : ' ');
    return s;
  });
}

export function functions(readFile: (p: string) => string | null, render: (text: string, vars: Record<string, unknown>, pos: Pos) => unknown): Record<string, Fn> {
  const f: Record<string, Fn> = {
    length: ([v], pos) => {
      const u = unwrap(v);
      if (typeof u === 'string' || Array.isArray(u)) return u.length;
      if (u && typeof u === 'object') return Object.keys(u).length;
      return fail('length', `argument must be a string, a collection type, or a structural type, got ${typeName(u)}`, pos);
    },
    upper: ([v]) => str(v).toUpperCase(),
    lower: ([v]) => str(v).toLowerCase(),
    title: ([v]) => str(v).replace(/\b\w/g, (c) => c.toUpperCase()),
    trimspace: ([v]) => str(v).trim(),
    trim: ([v, c]) => str(v).replace(new RegExp(`^[${str(c)}]+|[${str(c)}]+$`, 'g'), ''),
    trimprefix: ([v, p]) => (str(v).startsWith(str(p)) ? str(v).slice(str(p).length) : str(v)),
    trimsuffix: ([v, p]) => (str(v).endsWith(str(p)) ? str(v).slice(0, -str(p).length) : str(v)),
    startswith: ([v, p]) => str(v).startsWith(str(p)),
    endswith: ([v, p]) => str(v).endsWith(str(p)),
    substr: ([v, o, l]) => {
      const s = str(v);
      const off = Number(o) < 0 ? s.length + Number(o) : Number(o);
      return Number(l) < 0 ? s.slice(off) : s.substr(off, Number(l));
    },
    replace: ([v, a, b]) => {
      const sub = str(a);
      const m = /^\/(.*)\/$/.exec(sub);
      return m ? str(v).replace(new RegExp(m[1], 'g'), str(b).replace(/\$\{?(\d)\}?/g, '$$$1')) : str(v).split(sub).join(str(b));
    },
    format: ([fmt, ...args], pos) => format(str(fmt), args, pos),
    join: ([sep, l], pos) => list('join', l, pos).map(str).join(str(sep)),
    split: ([sep, s]) => str(s).split(str(sep)),
    concat: (args, pos) => args.flatMap((a) => list('concat', a, pos)),
    flatten: ([l], pos) => {
      const flat = (x: unknown[]): unknown[] => x.flatMap((y) => (Array.isArray(y) ? flat(y) : [y]));
      return flat(list('flatten', l, pos));
    },
    distinct: ([l], pos) => list('distinct', l, pos).filter((v, i, a) => a.findIndex((x) => JSON.stringify(x) === JSON.stringify(v)) === i),
    sort: ([l], pos) => [...list('sort', l, pos)].map(str).sort(),
    reverse: ([l], pos) => [...list('reverse', l, pos)].reverse(),
    slice: ([l, a, b], pos) => list('slice', l, pos).slice(Number(a), Number(b)),
    contains: ([l, v], pos) => list('contains', l, pos).some((x) => JSON.stringify(x) === JSON.stringify(unwrap(v))),
    index: ([l, v], pos) => {
      const i = list('index', l, pos).findIndex((x) => JSON.stringify(x) === JSON.stringify(unwrap(v)));
      return i < 0 ? fail('index', 'item not found', pos) : i;
    },
    element: ([l, i], pos) => {
      const arr = list('element', l, pos);
      if (!arr.length) fail('element', 'cannot use element function with an empty list', pos);
      return arr[Number(i) % arr.length];
    },
    range: (args) => {
      const [a, b, st] = args.length === 1 ? [0, Number(args[0]), 1] : [Number(args[0]), Number(args[1]), Number(args[2] ?? 1)];
      const out: number[] = [];
      for (let x = a; st > 0 ? x < b : x > b; x += st) out.push(x);
      return out;
    },
    keys: ([m]) => Object.keys(unwrap(m) as object).sort(),
    values: ([m]) => Object.keys(unwrap(m) as object).sort().map((k) => (unwrap(m) as Record<string, unknown>)[k]),
    lookup: ([m, k, d], pos) => {
      const o = unwrap(m) as Record<string, unknown>;
      if (o && str(k) in o) return o[str(k)];
      if (d === undefined) fail('lookup', `lookup failed to find key "${str(k)}"`, pos);
      return d;
    },
    merge: (args) => Object.assign({}, ...args.map((a) => unwrap(a) ?? {})),
    zipmap: ([k, v], pos) => Object.fromEntries(list('zipmap', k, pos).map((x, i) => [str(x), list('zipmap', v, pos)[i]])),
    toset: ([l], pos) => [...new Set(list('toset', l, pos).map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)))].map((x) => (typeof x === 'string' && /^[[{]/.test(x) ? JSON.parse(x) : x)).sort(),
    tolist: ([l], pos) => list('tolist', l, pos),
    tomap: ([m]) => unwrap(m),
    tostring: ([v]) => (v === null ? null : str(v)),
    tonumber: ([v], pos) => {
      const n = Number(unwrap(v));
      return isNaN(n) ? fail('tonumber', `cannot convert "${str(v)}" to number; given string must be a decimal representation of a number`, pos) : n;
    },
    tobool: ([v]) => unwrap(v) === true || unwrap(v) === 'true',
    coalesce: (args, pos) => args.find((a) => a !== null && a !== '') ?? fail('coalesce', 'no non-null, non-empty-string arguments', pos),
    one: ([l], pos) => {
      const a = list('one', l, pos);
      return a.length ? a[0] : null;
    },
    min: (args) => Math.min(...args.map(Number)),
    max: (args) => Math.max(...args.map(Number)),
    abs: ([v]) => Math.abs(Number(v)),
    ceil: ([v]) => Math.ceil(Number(v)),
    floor: ([v]) => Math.floor(Number(v)),
    pow: ([a, b]) => Number(a) ** Number(b),
    sum: ([l], pos) => list('sum', l, pos).reduce((a: number, b) => a + Number(b), 0),
    jsonencode: ([v]) => JSON.stringify(unwrap(v)),
    jsondecode: ([v], pos) => {
      try {
        return JSON.parse(str(v));
      } catch (e) {
        return fail('jsondecode', (e as Error).message, pos);
      }
    },
    yamlencode: ([v]) => JSON.stringify(unwrap(v)),
    base64encode: ([v]) => btoa(str(v)),
    base64decode: ([v]) => atob(str(v)),
    sensitive: ([v]) => new Sensitive(v),
    nonsensitive: ([v]) => unwrap(v),
    file: ([p], pos) => {
      const t = readFile(str(p));
      return t ?? fail('file', `no file exists at "${str(p)}"; this function works only with files that are distributed as part of the configuration source code, so if this file will be created by a resource in this configuration you must instead obtain this result from an attribute of that resource`, pos);
    },
    fileexists: ([p]) => readFile(str(p)) !== null,
    templatefile: ([p, vars], pos) => {
      const t = readFile(str(p));
      if (t === null) fail('templatefile', `no file exists at "${str(p)}"`, pos);
      return render(t!, (unwrap(vars) as Record<string, unknown>) ?? {}, pos);
    },
    basename: ([p]) => str(p).split('/').pop(),
    dirname: ([p]) => str(p).split('/').slice(0, -1).join('/') || '.',
    abspath: ([p]) => str(p),
    cidrsubnet: ([prefix, newbits, netnum], pos) => {
      const [base, bits] = str(prefix).split('/');
      const nb = Number(bits) + Number(newbits);
      if (nb > 32) fail('cidrsubnet', `insufficient address space to extend prefix of ${bits} by ${newbits}`, pos);
      const size = 2 ** (32 - nb);
      const start = Math.floor(ipNum(base) / 2 ** (32 - Number(bits))) * 2 ** (32 - Number(bits));
      if (Number(netnum) >= 2 ** Number(newbits)) fail('cidrsubnet', `prefix extension of ${newbits} does not accommodate a subnet numbered ${netnum}`, pos);
      return `${numIp(start + Number(netnum) * size)}/${nb}`;
    },
    cidrhost: ([prefix, host]) => {
      const [base, bits] = str(prefix).split('/');
      const start = Math.floor(ipNum(base) / 2 ** (32 - Number(bits))) * 2 ** (32 - Number(bits));
      return numIp(start + Number(host));
    },
    timestamp: () => UNKNOWN,
    uuid: () => UNKNOWN,
  };
  // try / can: their arguments were already evaluated; errors are caught by the caller (see engine).
  f.try = (args) => args.find((a) => a !== TRY_FAILED) ?? null;
  f.can = ([a]) => a !== TRY_FAILED;
  // Unknown arguments make (almost) every result unknown.
  for (const [name, fn] of Object.entries(f)) {
    if (['try', 'can', 'sensitive', 'length'].includes(name)) continue;
    f[name] = (args, pos) => (args.some((a) => deepUnknown(a)) ? UNKNOWN : fn(args, pos));
  }
  const len = f.length;
  f.length = (args, pos) => (isUnknown(args[0]) ? UNKNOWN : len(args, pos));
  return f;
}
