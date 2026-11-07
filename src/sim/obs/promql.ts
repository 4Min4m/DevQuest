/** A PromQL engine over the simulated series. */
import type { SimState } from '../state';
import { Labels, Sample, samplesAt, SCRAPE } from './metrics';

export class PromQLError extends Error {}

type Matcher = { name: string; op: '=' | '!=' | '=~' | '!~'; value: string };
type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'sel'; name?: string; matchers: Matcher[]; range?: number; offset?: number }
  | { k: 'sub'; e: Node; range: number; step: number }
  | { k: 'fn'; name: string; args: Node[] }
  | { k: 'agg'; op: string; by?: string[]; without?: string[]; param?: Node; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node; bool?: boolean; on?: string[]; ignoring?: string[]; group?: 'left' | 'right' }
  | { k: 'neg'; e: Node };

export type Value = { type: 'scalar'; v: number } | { type: 'vector'; v: Sample[] } | { type: 'matrix'; v: { labels: Labels; points: [number, number][] }[] } | { type: 'string'; v: string };

const AGGS = ['sum', 'avg', 'min', 'max', 'count', 'topk', 'bottomk', 'quantile', 'stddev', 'count_values', 'group'];

export function parseDuration(s: string): number {
  const re = /(\d+)(ms|s|m|h|d|w|y)/g;
  let total = 0;
  let m: RegExpExecArray | null;
  let consumed = '';
  while ((m = re.exec(s))) {
    total += Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }[m[2]]!;
    consumed += m[0];
  }
  if (consumed !== s || !s) throw new PromQLError(`not a valid duration string: "${s}"`);
  return total;
}

class Parser {
  i = 0;
  constructor(private s: string) {}
  private ws() {
    while (this.i < this.s.length) {
      if (/\s/.test(this.s[this.i])) this.i++;
      else if (this.s[this.i] === '#') while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      else break;
    }
  }
  private peek(t: string) {
    this.ws();
    return this.s.startsWith(t, this.i);
  }
  private peekWord(w: string) {
    this.ws();
    return new RegExp(`^${w}(?![\\w:])`, 'i').test(this.s.slice(this.i));
  }
  private take(t: string) {
    if (!this.peek(t)) this.fail(`unexpected ${this.near()}, expected "${t}"`);
    this.i += t.length;
  }
  private near() {
    this.ws();
    return this.i >= this.s.length ? 'end of input' : `character "${this.s[this.i]}"`;
  }
  fail(msg: string): never {
    throw new PromQLError(`1:${this.i + 1}: parse error: ${msg}`);
  }
  ident(): string {
    this.ws();
    const m = /^[a-zA-Z_:][\w:]*/.exec(this.s.slice(this.i));
    if (!m) this.fail(`unexpected ${this.near()}`);
    this.i += m[0].length;
    return m[0];
  }
  done() {
    this.ws();
    return this.i >= this.s.length;
  }
  expr(minPrec = 0): Node {
    let l = this.unary();
    for (;;) {
      this.ws();
      const ops: [string, number, boolean][] = [['or', 1, true], ['and', 2, true], ['unless', 2, true], ['==', 3, false], ['!=', 3, false], ['<=', 3, false], ['>=', 3, false], ['<', 3, false], ['>', 3, false], ['+', 4, false], ['-', 4, false], ['*', 5, false], ['/', 5, false], ['%', 5, false], ['^', 6, false]];
      const hit = ops.find(([o, , word]) => (word ? this.peekWord(o) : this.peek(o)));
      if (!hit || hit[1] <= minPrec) return l;
      const [op, prec] = hit;
      this.i += op.length;
      const node: Node & { k: 'bin' } = { k: 'bin', op: op.toLowerCase(), l, r: { k: 'num', v: 0 } };
      if (this.peekWord('bool')) {
        this.i += 4;
        node.bool = true;
      }
      for (const kw of ['on', 'ignoring'] as const) {
        if (this.peekWord(kw)) {
          this.i += kw.length;
          node[kw] = this.labelList();
        }
      }
      for (const g of ['group_left', 'group_right'] as const) {
        if (this.peekWord(g)) {
          this.i += g.length;
          node.group = g === 'group_left' ? 'left' : 'right';
          if (this.peek('(')) this.labelList();
        }
      }
      node.r = this.expr(op === '^' ? prec - 1 : prec);
      l = node;
    }
  }
  private labelList(): string[] {
    this.take('(');
    const out: string[] = [];
    while (!this.peek(')')) {
      out.push(this.ident());
      if (this.peek(',')) this.i++;
    }
    this.i++;
    return out;
  }
  private unary(): Node {
    if (this.peek('-')) {
      this.i++;
      return { k: 'neg', e: this.unary() };
    }
    if (this.peek('+')) this.i++;
    return this.postfix(this.primary());
  }
  private postfix(n: Node): Node {
    for (;;) {
      if (this.peek('[')) {
        this.i++;
        this.ws();
        const m = /^[\dsmhdwy]+/.exec(this.s.slice(this.i));
        if (!m) this.fail('unexpected character in duration');
        this.i += m[0].length;
        const range = parseDuration(m[0]);
        if (this.peek(':')) {
          this.i++;
          this.ws();
          const st = /^[\dsmhdwy]*/.exec(this.s.slice(this.i))![0];
          this.i += st.length;
          this.take(']');
          n = { k: 'sub', e: n, range, step: st ? parseDuration(st) : 60 };
          continue;
        }
        this.take(']');
        if (n.k !== 'sel') this.fail('ranges only allowed for vector selectors');
        n = { ...n, range };
      } else if (this.peekWord('offset')) {
        this.i += 6;
        this.ws();
        const m = /^[\dsmhdwy]+/.exec(this.s.slice(this.i))!;
        this.i += m[0].length;
        if (n.k === 'sel') n = { ...n, offset: parseDuration(m[0]) };
      } else return n;
    }
  }
  private primary(): Node {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) this.fail('unexpected end of input');
    if (c === '(') {
      this.i++;
      const e = this.expr();
      this.take(')');
      return e;
    }
    if (c === '"' || c === "'" || c === '`') return { k: 'str', v: this.string() };
    const num = /^(\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+|Inf|NaN)/.exec(this.s.slice(this.i));
    if (num && !/^[a-zA-Z_:]/.test(c)) {
      this.i += num[0].length;
      return { k: 'num', v: Number(num[0]) };
    }
    if (c === '{') return this.selector(undefined);
    const name = this.ident();
    const lname = name.toLowerCase();
    if (AGGS.includes(lname)) {
      let by: string[] | undefined;
      let without: string[] | undefined;
      const mod = () => {
        if (this.peekWord('by')) {
          this.i += 2;
          by = this.labelList();
        } else if (this.peekWord('without')) {
          this.i += 7;
          without = this.labelList();
        }
      };
      mod();
      this.take('(');
      let param: Node | undefined;
      let e = this.expr();
      if (this.peek(',')) {
        this.i++;
        param = e;
        e = this.expr();
      }
      this.take(')');
      mod();
      return { k: 'agg', op: lname, by, without, param, e };
    }
    if (this.peek('(')) {
      this.i++;
      const args: Node[] = [];
      while (!this.peek(')')) {
        args.push(this.expr());
        if (this.peek(',')) this.i++;
        else if (!this.peek(')')) this.fail(`unexpected ${this.near()} in function call`);
      }
      this.i++;
      if (!FUNCS[name]) throw new PromQLError(`1:1: parse error: unknown function with name "${name}"`);
      return { k: 'fn', name, args };
    }
    return this.selector(name);
  }
  private string(): string {
    const q = this.s[this.i++];
    let out = '';
    while (this.i < this.s.length && this.s[this.i] !== q) {
      if (this.s[this.i] === '\\' && q !== '`') out += this.s[++this.i];
      else out += this.s[this.i];
      this.i++;
    }
    if (this.s[this.i] !== q) this.fail('unterminated quoted string');
    this.i++;
    return out;
  }
  private selector(name: string | undefined): Node {
    const matchers: Matcher[] = [];
    if (this.peek('{')) {
      this.i++;
      while (!this.peek('}')) {
        const n = this.ident();
        this.ws();
        const op = (['=~', '!~', '!=', '='] as const).find((o) => this.s.startsWith(o, this.i));
        if (!op) this.fail(`unexpected ${this.near()} in label matching, expected label matching operator`);
        this.i += op.length;
        this.ws();
        if (!['"', "'", '`'].includes(this.s[this.i])) this.fail(`unexpected ${this.near()} in label matching, expected string`);
        matchers.push({ name: n, op, value: this.string() });
        if (this.peek(',')) this.i++;
        else if (!this.peek('}')) this.fail(`unexpected ${this.near()} in label matching, expected "," or "}"`);
      }
      this.i++;
    }
    if (!name && !matchers.some((m) => !(m.op === '=~' && /^\.\*$/.test(m.value)) && m.value !== '')) {
      this.fail('vector selector must contain at least one non-empty matcher');
    }
    return { k: 'sel', name, matchers };
  }
}

export function parse(q: string): Node {
  const p = new Parser(q);
  const n = p.expr();
  if (!p.done()) p.fail(`unexpected character after expression`);
  return n;
}

const sig = (l: Labels, drop = ['__name__']) => JSON.stringify(Object.keys(l).filter((k) => !drop.includes(k)).sort().map((k) => [k, l[k]]));
const noName = (l: Labels) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== '__name__'));

function match(l: Labels, m: Matcher): boolean {
  const v = l[m.name] ?? '';
  switch (m.op) {
    case '=':
      return v === m.value;
    case '!=':
      return v !== m.value;
    case '=~':
      return new RegExp(`^(?:${m.value})$`).test(v);
    case '!~':
      return !new RegExp(`^(?:${m.value})$`).test(v);
  }
}

type Ctx = { state: SimState; cache: Map<number, Sample[]> };

function selectAt(c: Ctx, n: Node & { k: 'sel' }, t: number): Sample[] {
  let all = c.cache.get(t);
  if (!all) {
    all = samplesAt(c.state, t * 1000);
    c.cache.set(t, all);
  }
  return all.filter((s) => (!n.name || s.labels.__name__ === n.name) && n.matchers.every((m) => match(s.labels, m)));
}

function rangeOf(c: Ctx, n: Node & { k: 'sel' }, t: number): { labels: Labels; points: [number, number][] }[] {
  const end = t - (n.offset ?? 0);
  const start = end - (n.range ?? 0);
  const series = new Map<string, { labels: Labels; points: [number, number][] }>();
  const first = Math.ceil(start / SCRAPE) * SCRAPE;
  const times: number[] = [];
  for (let x = first; x <= end; x += SCRAPE) times.push(x);
  if (times[times.length - 1] !== end) times.push(end);
  if (times[0] !== start) times.unshift(start);
  for (const x of times) {
    for (const s of selectAt(c, { ...n, range: undefined }, x)) {
      const k = JSON.stringify(s.labels);
      let e = series.get(k);
      if (!e) {
        e = { labels: s.labels, points: [] };
        series.set(k, e);
      }
      e.points.push([x, s.value]);
    }
  }
  return [...series.values()];
}

const isVec = (v: Value): v is { type: 'vector'; v: Sample[] } => v.type === 'vector';

function overTime(f: (pts: [number, number][], range: number) => number | undefined) {
  return (c: Ctx, args: Node[], t: number): Value => {
    const a = args[0];
    let ser: { labels: Labels; points: [number, number][] }[];
    let range: number;
    if (a.k === 'sel' && a.range) {
      ser = rangeOf(c, a, t);
      range = a.range;
    } else if (a.k === 'sub') {
      range = a.range;
      const map = new Map<string, { labels: Labels; points: [number, number][] }>();
      for (let x = Math.ceil((t - a.range) / a.step) * a.step; x <= t; x += a.step) {
        const v = evaluate(c, a.e, x);
        if (!isVec(v)) continue;
        for (const s of v.v) {
          const k = JSON.stringify(s.labels);
          if (!map.has(k)) map.set(k, { labels: s.labels, points: [] });
          map.get(k)!.points.push([x, s.value]);
        }
      }
      ser = [...map.values()];
    } else throw new PromQLError(`expected type range vector in call to function, got instant vector`);
    const out: Sample[] = [];
    for (const s of ser) {
      if (!s.points.length) continue;
      const v = f(s.points, range);
      if (v !== undefined && !Number.isNaN(v)) out.push({ labels: noName(s.labels), value: v });
    }
    return { type: 'vector', v: out };
  };
}

const counterDelta = (p: [number, number][]) => {
  let d = 0;
  for (let i = 1; i < p.length; i++) d += p[i][1] >= p[i - 1][1] ? p[i][1] - p[i - 1][1] : p[i][1];
  return d;
};

function quantile(q: number, buckets: { le: number; v: number }[]): number {
  buckets.sort((a, b) => a.le - b.le);
  const total = buckets[buckets.length - 1]?.v ?? 0;
  if (!total || buckets[buckets.length - 1].le !== Infinity) return NaN;
  const rank = q * total;
  let prevLe = 0;
  let prevV = 0;
  for (const b of buckets) {
    if (b.v >= rank) {
      if (b.le === Infinity) return prevLe;
      return prevLe + ((b.le - prevLe) * (rank - prevV)) / Math.max(1e-12, b.v - prevV);
    }
    prevLe = b.le;
    prevV = b.v;
  }
  return prevLe;
}

const mapVec = (f: (x: number, ...extra: number[]) => number) => (c: Ctx, args: Node[], t: number): Value => {
  const v = evaluate(c, args[0], t);
  const extra = args.slice(1).map((a) => scalarOf(evaluate(c, a, t)));
  if (v.type === 'scalar') return { type: 'scalar', v: f(v.v, ...extra) };
  if (!isVec(v)) throw new PromQLError('expected instant vector');
  return { type: 'vector', v: v.v.map((s) => ({ labels: noName(s.labels), value: f(s.value, ...extra) })) };
};

function scalarOf(v: Value): number {
  if (v.type === 'scalar') return v.v;
  if (isVec(v)) return v.v.length === 1 ? v.v[0].value : NaN;
  throw new PromQLError('expected scalar');
}

const FUNCS: Record<string, (c: Ctx, args: Node[], t: number) => Value> = {
  rate: overTime((p, r) => (p.length < 2 ? undefined : counterDelta(p) / r)),
  irate: overTime((p) => (p.length < 2 ? undefined : (p[p.length - 1][1] - p[p.length - 2][1]) / (p[p.length - 1][0] - p[p.length - 2][0]))),
  increase: overTime((p) => (p.length < 2 ? undefined : counterDelta(p))),
  delta: overTime((p) => (p.length < 2 ? undefined : p[p.length - 1][1] - p[0][1])),
  deriv: overTime((p) => (p.length < 2 ? undefined : (p[p.length - 1][1] - p[0][1]) / (p[p.length - 1][0] - p[0][0]))),
  avg_over_time: overTime((p) => p.reduce((a, x) => a + x[1], 0) / p.length),
  max_over_time: overTime((p) => Math.max(...p.map((x) => x[1]))),
  min_over_time: overTime((p) => Math.min(...p.map((x) => x[1]))),
  sum_over_time: overTime((p) => p.reduce((a, x) => a + x[1], 0)),
  count_over_time: overTime((p) => p.length),
  last_over_time: overTime((p) => p[p.length - 1][1]),
  histogram_quantile: (c, args, t) => {
    const q = scalarOf(evaluate(c, args[0], t));
    const v = evaluate(c, args[1], t);
    if (!isVec(v)) throw new PromQLError('expected instant vector in call to function "histogram_quantile"');
    const groups = new Map<string, { labels: Labels; b: { le: number; v: number }[] }>();
    for (const s of v.v) {
      if (s.labels.le === undefined) continue;
      const rest = Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== 'le' && k !== '__name__'));
      const k = sig(rest);
      if (!groups.has(k)) groups.set(k, { labels: rest, b: [] });
      groups.get(k)!.b.push({ le: s.labels.le === '+Inf' ? Infinity : Number(s.labels.le), v: s.value });
    }
    return { type: 'vector', v: [...groups.values()].map((g) => ({ labels: g.labels, value: quantile(q, g.b) })).filter((s) => !Number.isNaN(s.value)) };
  },
  abs: mapVec(Math.abs),
  ceil: mapVec(Math.ceil),
  floor: mapVec(Math.floor),
  round: mapVec((x, to = 1) => Math.round(x / to) * to),
  sqrt: mapVec(Math.sqrt),
  exp: mapVec(Math.exp),
  ln: mapVec(Math.log),
  clamp_min: mapVec((x, m) => Math.max(x, m)),
  clamp_max: mapVec((x, m) => Math.min(x, m)),
  absent: (c, args, t) => {
    const v = evaluate(c, args[0], t);
    if (isVec(v) && v.v.length) return { type: 'vector', v: [] };
    const a = args[0];
    const labels: Labels = {};
    if (a.k === 'sel') for (const m of a.matchers) if (m.op === '=') labels[m.name] = m.value;
    return { type: 'vector', v: [{ labels, value: 1 }] };
  },
  time: (_c, _a, t) => ({ type: 'scalar', v: t }),
  vector: (c, args, t) => ({ type: 'vector', v: [{ labels: {}, value: scalarOf(evaluate(c, args[0], t)) }] }),
  scalar: (c, args, t) => ({ type: 'scalar', v: scalarOf(evaluate(c, args[0], t)) }),
  sort: (c, args, t) => {
    const v = evaluate(c, args[0], t) as { type: 'vector'; v: Sample[] };
    return { type: 'vector', v: [...v.v].sort((a, b) => a.value - b.value) };
  },
  sort_desc: (c, args, t) => {
    const v = evaluate(c, args[0], t) as { type: 'vector'; v: Sample[] };
    return { type: 'vector', v: [...v.v].sort((a, b) => b.value - a.value) };
  },
  label_replace: (c, args, t) => {
    const v = evaluate(c, args[0], t) as { type: 'vector'; v: Sample[] };
    const [dst, repl, src, re] = args.slice(1).map((a) => (a.k === 'str' ? a.v : ''));
    return {
      type: 'vector',
      v: v.v.map((s) => {
        const m = new RegExp(`^(?:${re})$`).exec(s.labels[src] ?? '');
        if (!m) return s;
        return { labels: { ...s.labels, [dst]: repl.replace(/\$(\d)/g, (_x, d) => m[Number(d)] ?? '') }, value: s.value };
      }),
    };
  },
};

function arith(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    case '%':
      return a % b;
    case '^':
      return a ** b;
    case '==':
      return a === b ? 1 : 0;
    case '!=':
      return a !== b ? 1 : 0;
    case '>':
      return a > b ? 1 : 0;
    case '<':
      return a < b ? 1 : 0;
    case '>=':
      return a >= b ? 1 : 0;
    case '<=':
      return a <= b ? 1 : 0;
  }
  throw new PromQLError(`unknown operator ${op}`);
}

const CMP = ['==', '!=', '>', '<', '>=', '<='];

export function evaluate(c: Ctx, n: Node, t: number): Value {
  switch (n.k) {
    case 'num':
      return { type: 'scalar', v: n.v };
    case 'str':
      return { type: 'string', v: n.v };
    case 'neg': {
      const v = evaluate(c, n.e, t);
      if (v.type === 'scalar') return { type: 'scalar', v: -v.v };
      if (isVec(v)) return { type: 'vector', v: v.v.map((s) => ({ labels: noName(s.labels), value: -s.value })) };
      throw new PromQLError('unary minus needs a scalar or instant vector');
    }
    case 'sel':
      if (n.range) return { type: 'matrix', v: rangeOf(c, n, t) };
      return { type: 'vector', v: selectAt(c, n, t - (n.offset ?? 0)) };
    case 'sub':
      throw new PromQLError('subqueries are only supported inside *_over_time functions');
    case 'fn':
      return FUNCS[n.name](c, n.args, t);
    case 'agg': {
      const v = evaluate(c, n.e, t);
      if (!isVec(v)) throw new PromQLError(`expected type instant vector in aggregation expression, got ${v.type === 'matrix' ? 'range vector' : v.type}`);
      const key = (l: Labels): Labels => {
        if (n.by) return Object.fromEntries(n.by.filter((k) => k in l).map((k) => [k, l[k]]));
        if (n.without) return Object.fromEntries(Object.entries(l).filter(([k]) => !n.without!.includes(k) && k !== '__name__'));
        return {};
      };
      const groups = new Map<string, { labels: Labels; items: Sample[] }>();
      for (const s of v.v) {
        const l = key(s.labels);
        const k = sig(l, []);
        if (!groups.has(k)) groups.set(k, { labels: l, items: [] });
        groups.get(k)!.items.push(s);
      }
      if (n.op === 'topk' || n.op === 'bottomk') {
        const k = scalarOf(evaluate(c, n.param!, t));
        return { type: 'vector', v: [...groups.values()].flatMap((g) => [...g.items].sort((a, b) => (n.op === 'topk' ? b.value - a.value : a.value - b.value)).slice(0, k)) };
      }
      const out: Sample[] = [];
      for (const g of groups.values()) {
        const vals = g.items.map((s) => s.value);
        let r: number;
        switch (n.op) {
          case 'sum':
            r = vals.reduce((a, b) => a + b, 0);
            break;
          case 'avg':
            r = vals.reduce((a, b) => a + b, 0) / vals.length;
            break;
          case 'min':
            r = Math.min(...vals);
            break;
          case 'max':
            r = Math.max(...vals);
            break;
          case 'count':
            r = vals.length;
            break;
          case 'group':
            r = 1;
            break;
          case 'stddev': {
            const m = vals.reduce((a, b) => a + b, 0) / vals.length;
            r = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
            break;
          }
          case 'quantile': {
            const q = scalarOf(evaluate(c, n.param!, t));
            const sorted = [...vals].sort((a, b) => a - b);
            const pos = q * (sorted.length - 1);
            r = sorted[Math.floor(pos)] + (sorted[Math.ceil(pos)] - sorted[Math.floor(pos)]) * (pos - Math.floor(pos));
            break;
          }
          default:
            throw new PromQLError(`unsupported aggregation ${n.op}`);
        }
        out.push({ labels: g.labels, value: r });
      }
      return { type: 'vector', v: out };
    }
    case 'bin': {
      const l = evaluate(c, n.l, t);
      const r = evaluate(c, n.r, t);
      const op = n.op;
      if (['and', 'or', 'unless'].includes(op)) {
        if (!isVec(l) || !isVec(r)) throw new PromQLError(`set operator "${op}" not allowed in binary scalar expression`);
        const k = (s: Sample) => (n.on ? sig(Object.fromEntries(n.on.map((x) => [x, s.labels[x] ?? '']))) : sig(s.labels));
        const rk = new Set(r.v.map(k));
        if (op === 'and') return { type: 'vector', v: l.v.filter((s) => rk.has(k(s))) };
        if (op === 'unless') return { type: 'vector', v: l.v.filter((s) => !rk.has(k(s))) };
        const lk = new Set(l.v.map(k));
        return { type: 'vector', v: [...l.v, ...r.v.filter((s) => !lk.has(k(s)))] };
      }
      const cmp = CMP.includes(op);
      if (l.type === 'scalar' && r.type === 'scalar') {
        if (cmp && !n.bool) throw new PromQLError('comparisons between scalars must use BOOL modifier');
        return { type: 'scalar', v: arith(op, l.v, r.v) };
      }
      if (isVec(l) && r.type === 'scalar') {
        const out: Sample[] = [];
        for (const s of l.v) {
          const x = arith(op, s.value, r.v);
          if (cmp && !n.bool) {
            if (x) out.push(s);
          } else out.push({ labels: noName(s.labels), value: x });
        }
        return { type: 'vector', v: out };
      }
      if (l.type === 'scalar' && isVec(r)) {
        const out: Sample[] = [];
        for (const s of r.v) {
          const x = arith(op, l.v, s.value);
          if (cmp && !n.bool) {
            if (x) out.push(s);
          } else out.push({ labels: noName(s.labels), value: x });
        }
        return { type: 'vector', v: out };
      }
      if (isVec(l) && isVec(r)) {
        const key = (s: Sample) => {
          if (n.on) return sig(Object.fromEntries(n.on.map((x) => [x, s.labels[x] ?? ''])), []);
          return sig(s.labels, ['__name__', ...(n.ignoring ?? [])]);
        };
        const rmap = new Map<string, Sample[]>();
        for (const s of r.v) {
          const k = key(s);
          rmap.set(k, [...(rmap.get(k) ?? []), s]);
        }
        const out: Sample[] = [];
        for (const s of l.v) {
          const m = rmap.get(key(s));
          if (!m) continue;
          if (m.length > 1 && n.group !== 'left') throw new PromQLError('found duplicate series for the match group on the right hand-side of the operation; many-to-many matching not allowed: matching labels must be unique on one side');
          const x = arith(op, s.value, m[0].value);
          if (cmp && !n.bool) {
            if (x) out.push(s);
          } else out.push({ labels: n.on && !n.group ? Object.fromEntries(n.on.map((k) => [k, s.labels[k] ?? ''])) : noName(s.labels), value: x });
        }
        return { type: 'vector', v: out };
      }
      throw new PromQLError(`binary expression must contain only scalar and instant vector types`);
    }
  }
}

/** Evaluate a query at time t (seconds). */
export function query(state: SimState, q: string, t: number): Value {
  const ast = parse(q);
  return evaluate({ state, cache: new Map() }, ast, t);
}

export function formatLabels(l: Labels): string {
  const name = l.__name__ ?? '';
  const rest = Object.keys(l).filter((k) => k !== '__name__').sort();
  return `${name}{${rest.map((k) => `${k}="${l[k]}"`).join(', ')}}`;
}

/** promtool's text rendering of a value. */
export function formatValue(v: Value, t: number): string {
  const num = (x: number) => (Number.isNaN(x) ? 'NaN' : x === Infinity ? '+Inf' : String(Math.round(x * 1e6) / 1e6));
  if (v.type === 'scalar') return `scalar: ${num(v.v)} @[${t}]\n`;
  if (v.type === 'string') return `string: ${v.v} @[${t}]\n`;
  if (v.type === 'matrix') return v.v.map((s) => `${formatLabels(s.labels)} =>\n${s.points.map(([x, y]) => `${num(y)} @[${x}]`).join('\n')}`).join('\n') + '\n';
  return v.v.map((s) => `${formatLabels(s.labels)} => ${num(s.value)} @[${t}]`).join('\n') + (v.v.length ? '\n' : '');
}
