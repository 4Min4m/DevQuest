/** Loki: log streams from models, a LogQL subset, and logcli. */
import type { CommandDef } from '../shell/types';
import type { SimState } from '../state';
import { appHandlers } from '../systemd/hooks';
import { Labels, observe, predAt } from './metrics';
import { parseDuration } from './promql';

export interface LogLine {
  t: number;
  labels: Labels;
  line: string;
}

/** Every log line (ms timestamps) up to now, oldest first. */
export function allLines(state: SimState): LogLine[] {
  const obs = state.obs;
  if (!obs) return [];
  observe(state);
  const out: LogLine[] = [];
  for (const s of obs.logs) {
    for (const l of s.lines ?? []) {
      const t = obs.epoch + l.at * 1000;
      if (t <= state.clock) out.push({ t, labels: s.labels, line: l.line });
    }
    const r = s.repeat;
    if (r) {
      const end = Math.min(state.clock, r.to === undefined ? state.clock : obs.epoch + r.to * 1000);
      let n = 0;
      for (let t = obs.epoch + r.from * 1000; t <= end; t += r.every * 1000, n++) {
        if (r.when && !predAt(obs, r.when, t)) continue;
        out.push({ t, labels: s.labels, line: r.lines[n % r.lines.length].replace(/\{n\}/g, String(1000 + n)).replace(/\{ts\}/g, new Date(t).toISOString()) });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export class LogQLError extends Error {}

type Stage =
  | { k: 'line'; op: '|=' | '!=' | '|~' | '!~'; v: string }
  | { k: 'json' }
  | { k: 'logfmt' }
  | { k: 'label'; name: string; op: string; v: string | number }
  | { k: 'format'; tpl: string };

interface LogQuery {
  matchers: { name: string; op: string; value: string }[];
  stages: Stage[];
}

type MetricQuery = { fn: string; range: number; q: LogQuery; agg?: { op: string; by?: string[] }; cmp?: { op: string; v: number } };

function parseSelector(s: string): { q: LogQuery; rest: string } {
  const m = /^\s*\{([^}]*)\}/.exec(s);
  if (!m) throw new LogQLError('parse error : syntax error: unexpected IDENTIFIER, expecting {');
  const matchers = [...m[1].matchAll(/(\w+)\s*(=~|!~|!=|=)\s*"([^"]*)"/g)].map((x) => ({ name: x[1], op: x[2], value: x[3] }));
  const emptyOk = (m: { op: string; value: string }) => (m.op === '=' ? m.value === '' : m.op === '=~' ? new RegExp(`^(?:${m.value})$`).test('') : true);
  if (!matchers.length || matchers.every(emptyOk)) throw new LogQLError('parse error : queries require at least one regexp or equality matcher that does not have an empty-compatible value. For instance, app=~".*" does not meet this requirement, but app=~".+" will');
  let rest = s.slice(m[0].length);
  const stages: Stage[] = [];
  for (;;) {
    rest = rest.trimStart();
    let x: RegExpExecArray | null;
    if ((x = /^(\|=|!=|\|~|!~)\s*"((?:[^"\\]|\\.)*)"/.exec(rest)) || (x = /^(\|=|!=|\|~|!~)\s*`([^`]*)`/.exec(rest))) {
      stages.push({ k: 'line', op: x[1] as '|=', v: x[2].replace(/\\(.)/g, '$1') });
    } else if ((x = /^\|\s*json\b/.exec(rest))) stages.push({ k: 'json' });
    else if ((x = /^\|\s*logfmt\b/.exec(rest))) stages.push({ k: 'logfmt' });
    else if ((x = /^\|\s*line_format\s*"((?:[^"\\]|\\.)*)"/.exec(rest))) stages.push({ k: 'format', tpl: x[1] });
    else if ((x = /^\|\s*(\w+)\s*(==|=~|!~|!=|>=|<=|>|<|=)\s*("(?:[^"\\]|\\.)*"|[\d.]+[a-z]*)/.exec(rest))) {
      const raw = x[3];
      stages.push({ k: 'label', name: x[1], op: x[2], v: raw.startsWith('"') ? raw.slice(1, -1) : Number.isNaN(Number(raw)) ? parseDuration(raw) : Number(raw) });
    } else break;
    rest = rest.slice(x[0].length);
  }
  return { q: { matchers, stages }, rest };
}

export function parseLogQL(src: string): { log?: LogQuery; metric?: MetricQuery } {
  const s = src.trim();
  if (s.startsWith('{')) {
    const { q, rest } = parseSelector(s);
    if (rest.trim()) throw new LogQLError(`parse error at line 1, col ${s.length - rest.length + 1}: syntax error: unexpected ${rest.trim().split(/\s/)[0]}`);
    return { log: q };
  }
  let agg: MetricQuery['agg'];
  let body = s;
  let cmp: MetricQuery['cmp'];
  const c = /\)\s*(>=|<=|>|<|==)\s*([\d.]+)\s*$/.exec(body);
  if (c) {
    cmp = { op: c[1], v: Number(c[2]) };
    body = body.slice(0, c.index + 1);
  }
  const a = /^(sum|count|max|min|avg|topk)\s*(?:by\s*\(([^)]*)\))?\s*\(([\s\S]*)\)\s*(?:by\s*\(([^)]*)\))?$/.exec(body);
  if (a) {
    agg = { op: a[1], by: (a[2] ?? a[4])?.split(',').map((x) => x.trim()).filter(Boolean) };
    body = a[3].trim();
  }
  const f = /^(count_over_time|rate|bytes_over_time|bytes_rate)\s*\(([\s\S]*)\[(\w+)\]\s*\)$/.exec(body);
  if (!f) throw new LogQLError(`parse error : syntax error: unexpected ${s.split(/[\s({]/)[0] || 'input'}`);
  const { q, rest } = parseSelector(f[2]);
  if (rest.trim()) throw new LogQLError(`parse error : syntax error: unexpected ${rest.trim()}`);
  return { metric: { fn: f[1], range: parseDuration(f[3]), q, agg, cmp } };
}

function apply(q: LogQuery, l: LogLine): { labels: Labels; line: string } | null {
  for (const m of q.matchers) {
    const v = l.labels[m.name] ?? '';
    const ok = m.op === '=' ? v === m.value : m.op === '!=' ? v !== m.value : m.op === '=~' ? new RegExp(`^(?:${m.value})$`).test(v) : !new RegExp(`^(?:${m.value})$`).test(v);
    if (!ok) return null;
  }
  let labels = { ...l.labels };
  let line = l.line;
  for (const st of q.stages) {
    if (st.k === 'line') {
      const hit = st.op === '|=' || st.op === '!=' ? line.includes(st.v) : new RegExp(st.v).test(line);
      if ((st.op === '|=' || st.op === '|~') !== hit) return null;
    } else if (st.k === 'json') {
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        const flat = (obj: Record<string, unknown>, pre: string) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) flat(v as Record<string, unknown>, `${pre}${k}_`);
            else labels[`${pre}${k}`.replace(/[^\w]/g, '_')] = String(v);
          }
        };
        flat(o, '');
      } catch {
        labels = { ...labels, __error__: 'JSONParserErr' };
      }
    } else if (st.k === 'logfmt') {
      for (const m of line.matchAll(/(\w+)=("[^"]*"|\S+)/g)) labels[m[1]] = m[2].replace(/^"|"$/g, '');
    } else if (st.k === 'format') {
      line = st.tpl.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_m, k) => labels[k] ?? '').replace(/\\"/g, '"');
    } else {
      const v = labels[st.name];
      if (v === undefined) return null;
      const num = typeof st.v === 'number';
      const a = num ? (Number.isNaN(Number(v)) ? parseDurationSafe(v) : Number(v)) : v;
      const b = st.v;
      const ok = st.op === '=' || st.op === '==' ? a === b : st.op === '!=' ? a !== b : st.op === '=~' ? new RegExp(`^(?:${b})$`).test(String(a)) : st.op === '!~' ? !new RegExp(`^(?:${b})$`).test(String(a)) : st.op === '>' ? a > b : st.op === '<' ? a < b : st.op === '>=' ? a >= b : a <= b;
      if (!ok) return null;
    }
  }
  return { labels, line };
}

function parseDurationSafe(v: string): number {
  try {
    return parseDuration(v);
  } catch {
    return NaN;
  }
}

export interface LogResult {
  streams?: { labels: Labels; t: number; line: string }[];
  vector?: { labels: Labels; value: number }[];
}

export function runLogQL(state: SimState, src: string, opts: { since: number; limit: number; forward?: boolean }): LogResult {
  const p = parseLogQL(src);
  const lines = allLines(state);
  if (p.log) {
    const from = state.clock - opts.since * 1000;
    const hits = lines.filter((l) => l.t >= from).map((l) => ({ l, r: apply(p.log!, l) })).filter((x) => x.r).map((x) => ({ labels: x.r!.labels, t: x.l.t, line: x.r!.line }));
    const ordered = opts.forward ? hits : hits.reverse();
    return { streams: ordered.slice(0, opts.limit) };
  }
  const m = p.metric!;
  const from = state.clock - m.range * 1000;
  const groups = new Map<string, { labels: Labels; n: number; bytes: number }>();
  for (const l of lines) {
    if (l.t < from) continue;
    const r = apply(m.q, l);
    if (!r) continue;
    const key = m.agg ? Object.fromEntries((m.agg.by ?? []).map((k) => [k, r.labels[k] ?? ''])) : r.labels;
    const k = JSON.stringify(Object.entries(key).sort());
    const g = groups.get(k) ?? { labels: key, n: 0, bytes: 0 };
    g.n++;
    g.bytes += r.line.length;
    groups.set(k, g);
  }
  let vector = [...groups.values()].map((g) => ({ labels: g.labels, value: m.fn === 'count_over_time' ? g.n : m.fn === 'rate' ? g.n / m.range : m.fn === 'bytes_over_time' ? g.bytes : g.bytes / m.range }));
  if (m.cmp) vector = vector.filter((v) => (m.cmp!.op === '>' ? v.value > m.cmp!.v : m.cmp!.op === '<' ? v.value < m.cmp!.v : m.cmp!.op === '>=' ? v.value >= m.cmp!.v : m.cmp!.op === '<=' ? v.value <= m.cmp!.v : v.value === m.cmp!.v));
  return { vector: vector.sort((a, b) => b.value - a.value) };
}

const lokiUp = (state: SimState) => state.processes.some((p) => /loki/.test(p.command.split(/\s+/)[0]) && p.ports?.includes(3100));

appHandlers.loki = (_state, req) => {
  const p = new URL(req.key.replace(/^https?:\/\/[^/]+/, 'http://x')).pathname;
  if (p === '/ready') return { kind: 'response', res: { status: 200, body: 'ready\n' } };
  return { kind: 'response', res: { status: 404, body: '404 page not found\n' } };
};

const fmtLabels = (l: Labels) => `{${Object.keys(l).sort().map((k) => `${k}="${l[k]}"`).join(', ')}}`;

export const logcli: CommandDef = {
  name: 'logcli',
  summary: 'query Loki logs with LogQL (logcli query \'{app="api"} |= "error"\')',
  run(ctx) {
    const args = [...ctx.args];
    const flags: Record<string, string> = {};
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const m = /^--?([\w.-]+)(?:=(.*))?$/.exec(a);
      if (m && !a.startsWith('{')) {
        const bool = ['forward', 'quiet', 'q', 'no-labels', 'tail'].includes(m[1]);
        flags[m[1]] = m[2] ?? (bool ? 'true' : args[++i] ?? '');
      } else pos.push(a);
    }
    if (!lokiUp(ctx.state)) {
      ctx.err(`Query failed: run out of attempts while querying the server; last error: error sending request Get "http://localhost:3100/loki/api/v1/query_range": dial tcp 127.0.0.1:3100: connect: connection refused\n`);
      return 1;
    }
    const [cmd, ...rest] = pos;
    const quiet = flags.quiet === 'true' || flags.q === 'true';
    if (cmd === 'labels') {
      const lines = allLines(ctx.state);
      if (!rest[0]) {
        const names = new Set(lines.flatMap((l) => Object.keys(l.labels)));
        ctx.out([...names].sort().join('\n') + '\n');
      } else {
        const vals = new Set(lines.map((l) => l.labels[rest[0]]).filter((x) => x !== undefined));
        ctx.out([...vals].sort().join('\n') + '\n');
      }
      return 0;
    }
    if (cmd === 'query' || cmd === 'instant-query') {
      const q = rest[0];
      if (!q) {
        ctx.err("logcli: error: required argument 'query' not provided, try --help\n");
        return 1;
      }
      const since = flags.since ? parseDuration(flags.since) : 3600;
      const limit = Number(flags.limit ?? 30);
      try {
        parseLogQL(q);
        if (!quiet) ctx.note(`http://localhost:3100/loki/api/v1/query_range?direction=${flags.forward ? 'FORWARD' : 'BACKWARD'}&end=${ctx.state.clock}000000&limit=${limit}&query=${encodeURIComponent(q)}&start=${ctx.state.clock - since * 1000}000000\n`);
        const r = runLogQL(ctx.state, q, { since, limit, forward: flags.forward === 'true' });
        if (r.streams) {
          const common = r.streams.length ? Object.fromEntries(Object.entries(r.streams[0].labels).filter(([k, v]) => r.streams!.every((s) => s.labels[k] === v))) : {};
          if (!quiet) ctx.note(`Common labels: ${fmtLabels(common)}\n`);
          const raw = flags.o === 'raw' || flags.output === 'raw';
          for (const s of r.streams) {
            const own = Object.fromEntries(Object.entries(s.labels).filter(([k]) => !(k in common)));
            if (raw) ctx.out(s.line + '\n');
            else ctx.out(`${new Date(s.t).toISOString().replace(/\.\d+Z$/, 'Z')} ${flags['no-labels'] ? '' : fmtLabels(own) + ' '}${s.line}\n`);
          }
        } else {
          for (const v of r.vector!) ctx.out(`${fmtLabels(v.labels)} => ${Math.round(v.value * 1000) / 1000}\n`);
        }
        return 0;
      } catch (e) {
        ctx.err(`Query failed: ${(e as Error).message}\n`);
        return 1;
      }
    }
    ctx.err('usage: logcli [<flags>] <command> [<args> ...]\n\nCommands:\n  query [<flags>] <query>\n  labels [<label>]\n');
    return 1;
  },
};
