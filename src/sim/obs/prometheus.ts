/** Prometheus (rules, alerts, HTTP API), Alertmanager (silences) and their CLIs: promtool and amtool. */
import { parseAllDocuments, parse as parseYaml } from 'yaml';
import type { CommandContext, CommandDef } from '../shell/types';
import type { SimState } from '../state';
import { appHandlers, reloadHooks } from '../systemd/hooks';
import { Vfs } from '../vfs/vfs';
import { Labels, observe } from './metrics';
import { evaluate, formatLabels, formatValue, parse, parseDuration, PromQLError, query, Value } from './promql';
import type { RuleSpec } from './types';

const PROM_CONFIG = '/etc/prometheus/prometheus.yml';
const root = (s: SimState) => new Vfs(s.fs, { name: 'root', groups: ['root'] });
const now = (s: SimState) => Math.floor(s.clock / 1000);

export function promProcess(state: SimState) {
  return state.processes.find((p) => /(^|\/)prometheus(\s|$)/.test(p.command.split(/\s+/)[0] + ' ') && p.ports?.includes(9090));
}
export function amProcess(state: SimState) {
  return state.processes.find((p) => /alertmanager/.test(p.command.split(/\s+/)[0]) && p.ports?.includes(9093));
}

interface Group {
  name: string;
  rules: RuleSpec[];
}

/** Validate and parse a rule file the way `promtool check rules` does. Returns rules or error lines. */
export function checkRuleFile(text: string, file: string): { groups: Group[]; errors: string[] } {
  const errors: string[] = [];
  let doc: unknown;
  try {
    const docs = parseAllDocuments(text);
    if (docs.some((d) => d.errors.length)) throw new Error(docs.find((d) => d.errors.length)!.errors[0].message.split('\n')[0]);
    doc = parseYaml(text);
  } catch (e) {
    return { groups: [], errors: [`${file}: yaml: ${(e as Error).message}`] };
  }
  const d = doc as { groups?: unknown };
  if (!d || typeof d !== 'object' || !Array.isArray(d.groups)) return { groups: [], errors: [`${file}: yaml: unmarshal errors:\n  field groups not found or not a list`] };
  const groups: Group[] = [];
  const seen = new Set<string>();
  for (const g of d.groups as { name?: string; rules?: Record<string, unknown>[]; interval?: string }[]) {
    if (!g.name) {
      errors.push(`${file}: groupname must not be empty`);
      continue;
    }
    if (seen.has(g.name)) errors.push(`${file}: ${g.name}: groupname must be unique within a file`);
    seen.add(g.name);
    const rules: RuleSpec[] = [];
    (g.rules ?? []).forEach((r, i) => {
      const name = String(r.alert ?? r.record ?? '');
      const where = `${file}: group "${g.name}", rule ${i + 1}, "${name}"`;
      for (const k of Object.keys(r)) if (!['alert', 'record', 'expr', 'for', 'keep_firing_for', 'labels', 'annotations'].includes(k)) errors.push(`${file}: yaml: unmarshal errors:\n  field ${k} not found in type rulefmt.RuleNode`);
      if (r.alert && r.record) errors.push(`${where}: only one of 'record' and 'alert' must be set`);
      if (!r.alert && !r.record) errors.push(`${file}: group "${g.name}", rule ${i + 1}: one of 'record' or 'alert' must be set`);
      if (r.expr === undefined || r.expr === '') errors.push(`${where}: field 'expr' must be set in rule`);
      else {
        try {
          parse(String(r.expr));
        } catch (e) {
          errors.push(`${where}: could not parse expression: ${(e as Error).message}`);
        }
      }
      if (r.for !== undefined) {
        try {
          parseDuration(String(r.for));
        } catch {
          errors.push(`${where}: yaml: unmarshal errors:\n  not a valid duration string: "${r.for}"`);
        }
      }
      if (r.record && (r.for || r.annotations)) errors.push(`${where}: invalid field 'for' in recording rule`);
      if (r.record && !/^[a-zA-Z_:][\w:]*$/.test(String(r.record))) errors.push(`${where}: invalid recording rule name: ${r.record}`);
      for (const l of Object.keys((r.labels as object) ?? {})) if (!/^[a-zA-Z_]\w*$/.test(l)) errors.push(`${where}: invalid label name: ${l}`);
      rules.push({ alert: r.alert as string | undefined, record: r.record as string | undefined, expr: String(r.expr ?? ''), for: r.for as string | undefined, labels: r.labels as Record<string, string> | undefined, annotations: r.annotations as Record<string, string> | undefined });
    });
    groups.push({ name: g.name, rules });
  }
  return { groups, errors };
}

/** Rule files named by prometheus.yml (globs relative to its directory). */
export function ruleFiles(state: SimState, configPath = PROM_CONFIG): { files: string[]; error?: string } {
  const v = root(state);
  let cfg: { rule_files?: string[] };
  try {
    cfg = (parseYaml(v.readFile(configPath)) as typeof cfg) ?? {};
  } catch (e) {
    return { files: [], error: (e as Error).message };
  }
  const dir = configPath.replace(/\/[^/]+$/, '');
  const files: string[] = [];
  for (const pat of cfg.rule_files ?? []) {
    const abs = pat.startsWith('/') ? pat : `${dir}/${pat}`;
    const d = abs.replace(/\/[^/]+$/, '');
    const re = new RegExp('^' + abs.split('/').pop()!.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    try {
      for (const f of v.readdir(d).sort()) if (re.test(f)) files.push(`${d}/${f}`);
    } catch {
      /* no dir */
    }
  }
  return { files };
}

/** (Re)load rules like Prometheus at start-up / SIGHUP. Invalid files keep the previous rules. */
export function loadRules(state: SimState): { msg: string; prio: number }[] {
  const obs = state.obs;
  const proc = promProcess(state);
  if (!obs || !proc) return [];
  const { files, error } = ruleFiles(state);
  const groups: Group[] = [];
  const errs: string[] = error ? [error] : [];
  for (const f of files) {
    const r = checkRuleFile(root(state).readFile(f), f);
    errs.push(...r.errors);
    groups.push(...r.groups);
  }
  if (errs.length) {
    obs.loaded = { pid: proc.pid, groups: obs.loaded?.groups ?? [], error: errs.join('\n') };
    return [{ msg: `ts=${new Date(state.clock).toISOString()} caller=main.go:1171 level=error msg="Error reloading config" err="one or more errors occurred while applying the new configuration (--config.file=${PROM_CONFIG})" errors="${errs[0].replace(/"/g, '\\"')}"`, prio: 3 }];
  }
  obs.loaded = { pid: proc.pid, groups };
  (obs as { loadedAt?: number }).loadedAt = state.clock;
  return [{ msg: `ts=${new Date(state.clock).toISOString()} caller=main.go:1213 level=info msg="Completed loading of configuration file" filename=${PROM_CONFIG}`, prio: 6 }];
}

/** Lazily load rules for a freshly started Prometheus process. */
function ensureLoaded(state: SimState) {
  const proc = promProcess(state);
  if (!proc || !state.obs) return;
  if (state.obs.loaded?.pid !== proc.pid) {
    const startedAt = state.clock;
    loadRules(state);
    (state.obs as { loadedAt?: number }).loadedAt ??= startedAt;
    if (state.obs.loaded && !state.obs.loaded.error) (state.obs as { loadedAt?: number }).loadedAt = startedAt;
  }
}

reloadHooks.push((state, _unit, exe) => (/prometheus$/.test(exe) ? loadRules(state) : undefined));

function records(state: SimState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of state.obs?.loaded?.groups ?? []) for (const r of g.rules) if (r.record) out[r.record] = r.expr;
  return out;
}

/** Run a query as the live Prometheus would (recording rules included). */
export function promQuery(state: SimState, q: string, t = now(state)): Value {
  observe(state);
  ensureLoaded(state);
  const recs = records(state);
  if (!Object.keys(recs).length) return query(state, q, t);
  // Expand recording rule names textually into their expressions (parenthesized).
  let expanded = q;
  for (let i = 0; i < 3; i++) {
    for (const [name, expr] of Object.entries(recs)) {
      expanded = expanded.replace(new RegExp(`(?<![\\w:])${name.replace(/:/g, '\\:')}(?![\\w:])(\\{[^}]*\\})?`, 'g'), (_m, sel?: string) => {
        if (!sel) return `(${expr})`;
        const ms = sel.slice(1, -1).trim();
        return ms ? `((${expr}) and on(${[...ms.matchAll(/(\w+)\s*=/g)].map((m) => m[1]).join(',')}) ({__name__=~".+", ${ms}}))` : `(${expr})`;
      });
    }
  }
  return query(state, expanded, t);
}

export interface AlertInstance {
  name: string;
  labels: Labels;
  annotations: Record<string, string>;
  state: 'pending' | 'firing';
  activeAt: number;
  value: number;
}

function template(s: string, labels: Labels, value: number): string {
  return s
    .replace(/\{\{\s*\$labels\.(\w+)\s*\}\}/g, (_m, k) => labels[k] ?? '')
    .replace(/\{\{\s*\$value\s*\|\s*humanizePercentage\s*\}\}/g, () => `${Math.round(value * 10000) / 100}%`)
    .replace(/\{\{\s*\$value\s*\|\s*humanize(Duration)?\s*\}\}/g, () => String(Math.round(value * 1000) / 1000))
    .replace(/\{\{\s*\$value\s*\}\}/g, () => String(Math.round(value * 1e4) / 1e4));
}

/** Active alerts right now: pending until the expression has held for `for`, evaluated since the rules were loaded. */
export function activeAlerts(state: SimState): AlertInstance[] {
  observe(state);
  ensureLoaded(state);
  const obs = state.obs;
  if (!obs?.loaded || !promProcess(state)) return [];
  const t = now(state);
  const since = Math.floor(((obs as { loadedAt?: number }).loadedAt ?? state.clock) / 1000);
  const out: AlertInstance[] = [];
  for (const g of obs.loaded.groups) {
    for (const r of g.rules) {
      if (!r.alert) continue;
      const v = promQuery(state, r.expr, t);
      if (v.type !== 'vector') continue;
      const forSec = r.for ? parseDuration(r.for) : 0;
      for (const s of v.v) {
        const key = JSON.stringify(Object.entries(s.labels).filter(([k]) => k !== '__name__').sort());
        // Walk back to find when this series started matching (bounded by rule load time).
        let start = t;
        for (let x = t - 15; x >= since; x -= 15) {
          const back = promQuery(state, r.expr, x);
          if (back.type !== 'vector' || !back.v.some((b) => JSON.stringify(Object.entries(b.labels).filter(([k]) => k !== '__name__').sort()) === key)) break;
          start = x;
          if (t - start > forSec + 60) break;
        }
        const labels: Labels = { alertname: r.alert, ...Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== '__name__')), ...(r.labels ?? {}) };
        out.push({ name: r.alert, labels, annotations: Object.fromEntries(Object.entries(r.annotations ?? {}).map(([k, a]) => [k, template(a, labels, s.value)])), state: t - start >= forSec ? 'firing' : 'pending', activeAt: start, value: s.value });
      }
    }
  }
  return out;
}

function silencedBy(state: SimState, a: AlertInstance) {
  return state.obs?.silences.find((s) => !s.expired && s.endsAt > state.clock && Object.entries(s.matchers).every(([k, v]) => (v.startsWith('~') ? new RegExp(`^(?:${v.slice(1)})$`).test(a.labels[k] ?? '') : a.labels[k] === v)));
}

/** Alerts Alertmanager has (firing ones), with silenced ones marked. */
export function amAlerts(state: SimState): (AlertInstance & { silenced?: string })[] {
  return activeAlerts(state).filter((a) => a.state === 'firing').map((a) => ({ ...a, silenced: silencedBy(state, a)?.id }));
}

const json = (o: unknown, status = 200) => ({ kind: 'response' as const, res: { status, body: JSON.stringify(o) + '\n', headers: { 'Content-Type': 'application/json' } } });
const iso = (s: number) => new Date(s * 1000).toISOString();

appHandlers.prometheus = (state, req) => {
  const url = new URL(req.key.replace(/^https?:\/\/[^/]+/, 'http://x'));
  const p = url.pathname.replace(/\/$/, '');
  if (p === '/-/healthy') return { kind: 'response', res: { status: 200, body: 'Prometheus Server is Healthy.\n' } };
  if (p === '/-/ready') return { kind: 'response', res: { status: 200, body: 'Prometheus Server is Ready.\n' } };
  if (p === '/-/reload') {
    if (req.method !== 'POST' && req.method !== 'PUT') return { kind: 'response', res: { status: 405, body: 'Only POST or PUT requests allowed\n' } };
    const r = loadRules(state);
    const err = r.find((x) => x.prio === 3);
    return err ? { kind: 'response', res: { status: 500, body: `failed to reload config: ${state.obs?.loaded?.error}\n` } } : { kind: 'response', res: { status: 200, body: '' } };
  }
  if (p === '/api/v1/query') {
    const q = url.searchParams.get('query') ?? (req.body ? new URLSearchParams(req.body).get('query') : null);
    if (!q) return json({ status: 'error', errorType: 'bad_data', error: 'invalid parameter "query": unknown position: parse error: no expression found in input' }, 400);
    try {
      const v = promQuery(state, q);
      const t = now(state);
      const result = v.type === 'vector' ? v.v.map((s) => ({ metric: s.labels, value: [t, String(s.value)] })) : v.type === 'scalar' ? [t, String(v.v)] : v.type === 'matrix' ? v.v.map((s) => ({ metric: s.labels, values: s.points.map(([x, y]) => [x, String(y)]) })) : [t, v.v];
      return json({ status: 'success', data: { resultType: v.type, result } });
    } catch (e) {
      return json({ status: 'error', errorType: 'bad_data', error: `invalid parameter "query": ${(e as Error).message}` }, 400);
    }
  }
  if (p === '/api/v1/alerts') return json({ status: 'success', data: { alerts: activeAlerts(state).map((a) => ({ labels: a.labels, annotations: a.annotations, state: a.state, activeAt: iso(a.activeAt), value: String(a.value) })) } });
  if (p === '/api/v1/rules') {
    ensureLoaded(state);
    const act = activeAlerts(state);
    return json({ status: 'success', data: { groups: (state.obs?.loaded?.groups ?? []).map((g) => ({ name: g.name, rules: g.rules.map((r) => (r.alert ? { name: r.alert, query: r.expr, duration: r.for ? parseDuration(r.for) : 0, labels: r.labels ?? {}, annotations: r.annotations ?? {}, state: act.some((a) => a.name === r.alert && a.state === 'firing') ? 'firing' : act.some((a) => a.name === r.alert) ? 'pending' : 'inactive', type: 'alerting' } : { name: r.record, query: r.expr, type: 'recording' })) })) } });
  }
  if (p === '' || p === '/graph') return { kind: 'response', res: { status: 302, body: '<a href="/query">Found</a>.\n' } };
  return { kind: 'response', res: { status: 404, body: '404 page not found\n' } };
};

appHandlers.alertmanager = (state, req) => {
  const p = new URL(req.key.replace(/^https?:\/\/[^/]+/, 'http://x')).pathname.replace(/\/$/, '');
  if (p === '/-/healthy') return { kind: 'response', res: { status: 200, body: 'OK' } };
  if (p === '/api/v2/alerts') return json(amAlerts(state).map((a) => ({ labels: a.labels, annotations: a.annotations, startsAt: iso(a.activeAt), status: { state: a.silenced ? 'suppressed' : 'active', silencedBy: a.silenced ? [a.silenced] : [], inhibitedBy: [] } })));
  if (p === '/api/v2/silences') return json(state.obs?.silences ?? []);
  return { kind: 'response', res: { status: 404, body: '404 page not found\n' } };
};

// ------------------------------------------------------------------ promtool

function promUrlOk(ctx: CommandContext, url: string): string | null {
  const m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(url);
  if (!m) return `query error: parse "${url}": invalid URI for request`;
  const port = Number(m[2] ?? 80);
  const local = ['localhost', '127.0.0.1', ctx.state.hostname].includes(m[1]);
  if (!local || port !== 9090 || !promProcess(ctx.state)) return `query error: Post "${url.replace(/\/$/, '')}/api/v1/query": dial tcp ${local ? '127.0.0.1' : m[1]}:${port}: connect: connection refused`;
  return null;
}

export const promtool: CommandDef = {
  name: 'promtool',
  summary: 'Prometheus tooling: check config / rules, query instant / range',
  run(ctx) {
    const [a, b, ...rest] = ctx.args;
    const v = ctx.vfs;
    const read = (f: string) => {
      try {
        return v.readFile(ctx.resolve(f));
      } catch {
        return null;
      }
    };
    if (a === 'check' && b === 'rules') {
      let code = 0;
      for (const f of rest.filter((x) => !x.startsWith('-'))) {
        ctx.out(`Checking ${f}\n`);
        const t = read(f);
        if (t === null) {
          ctx.out('  FAILED:\n');
          ctx.err(`open ${f}: no such file or directory\n`);
          code = 1;
          continue;
        }
        const r = checkRuleFile(t, f);
        if (r.errors.length) {
          ctx.out('  FAILED:\n');
          ctx.err(r.errors.join('\n') + '\n');
          code = 1;
        } else ctx.out(`  SUCCESS: ${r.groups.reduce((n, g) => n + g.rules.length, 0)} rules found\n`);
        ctx.out('\n');
      }
      return code;
    }
    if (a === 'check' && b === 'config') {
      const f = rest.find((x) => !x.startsWith('-')) ?? '';
      ctx.out(`Checking ${f}\n`);
      const t = read(f);
      if (t === null) {
        ctx.out('  FAILED:\n');
        ctx.err(`open ${f}: no such file or directory\n`);
        return 1;
      }
      try {
        parseYaml(t);
      } catch (e) {
        ctx.out('  FAILED:\n');
        ctx.err(`parsing YAML file ${f}: ${(e as Error).message.split('\n')[0]}\n`);
        return 1;
      }
      const { files } = ruleFiles(ctx.state, ctx.resolve(f));
      ctx.out(`  SUCCESS: ${files.length} rule files found\n SUCCESS: ${f} is valid prometheus config file syntax\n\n`);
      let code = 0;
      for (const rf of files) {
        ctx.out(`Checking ${rf}\n`);
        const r = checkRuleFile(v.readFile(rf), rf);
        if (r.errors.length) {
          ctx.out('  FAILED:\n');
          ctx.err(r.errors.join('\n') + '\n');
          code = 1;
        } else ctx.out(`  SUCCESS: ${r.groups.reduce((n, g) => n + g.rules.length, 0)} rules found\n`);
        ctx.out('\n');
      }
      return code;
    }
    if (a === 'query' && b === 'instant') {
      const args = rest.filter((x) => !x.startsWith('--'));
      const [url, expr] = args;
      if (!url || expr === undefined) {
        ctx.err('promtool: error: required argument \'server\' not provided, try --help\n');
        return 1;
      }
      const err = promUrlOk(ctx, url);
      if (err) {
        ctx.err(err + '\n');
        return 1;
      }
      try {
        const val = promQuery(ctx.state, expr);
        ctx.out(formatValue(val, now(ctx.state)));
        return 0;
      } catch (e) {
        ctx.err(`query error: bad_data: invalid parameter "query": ${(e as Error).message}\n`);
        return 1;
      }
    }
    if (a === 'query' && b === 'range') {
      const opts = Object.fromEntries(rest.filter((x) => x.startsWith('--')).map((x) => x.replace(/^--/, '').split('=')));
      const [url, expr] = rest.filter((x) => !x.startsWith('--'));
      const err = promUrlOk(ctx, url ?? '');
      if (err) {
        ctx.err(err + '\n');
        return 1;
      }
      const t = now(ctx.state);
      const step = opts.step ? parseDuration(opts.step) : 60;
      const start = opts.start ? (/^-/.test(opts.start) ? t - parseDuration(opts.start.slice(1)) : Number(opts.start)) : t - 300;
      const lines = new Map<string, string[]>();
      try {
        for (let x = start; x <= t; x += step) {
          const val = promQuery(ctx.state, expr, x);
          if (val.type !== 'vector') continue;
          for (const s of val.v) {
            const k = formatLabels(s.labels);
            lines.set(k, [...(lines.get(k) ?? []), `${Math.round(s.value * 1e6) / 1e6} @[${x}]`]);
          }
        }
      } catch (e) {
        ctx.err(`query error: bad_data: invalid parameter "query": ${(e as Error).message}\n`);
        return 1;
      }
      for (const [k, pts] of lines) ctx.out(`${k} =>\n${pts.join('\n')}\n`);
      return 0;
    }
    ctx.err(`usage: promtool [<flags>] <command> [<args> ...]\n\nTooling for the Prometheus monitoring system.\n\nCommands:\n  check config <config-files>...\n  check rules <rule-files>...\n  query instant <server> <expr>\n  query range [--start=-1h] [--step=1m] <server> <expr>\n`);
    return 1;
  },
};

// ------------------------------------------------------------------ amtool

export const amtool: CommandDef = {
  name: 'amtool',
  summary: 'Alertmanager CLI: alert query, silence add/query/expire',
  run(ctx) {
    const args = ctx.args.filter((x) => !x.startsWith('--alertmanager.url') && !x.startsWith('-o'));
    const flags = Object.fromEntries(args.filter((x) => x.startsWith('--')).map((x) => {
      const i = x.indexOf('=');
      return i < 0 ? [x.slice(2), 'true'] : [x.slice(2, i), x.slice(i + 1).replace(/^"|"$/g, '')];
    }));
    const pos = args.filter((x) => !x.startsWith('--'));
    if (!amProcess(ctx.state)) {
      ctx.err(`amtool: error: Get "http://localhost:9093/api/v2/status": dial tcp 127.0.0.1:9093: connect: connection refused\n`);
      return 1;
    }
    const obs = (ctx.state.obs ??= { epoch: ctx.state.clock, series: [], logs: [], predLog: {}, silences: [] });
    const matchers = (list: string[]) => Object.fromEntries(list.map((m) => {
      const mm = /^([\w]+)(=~|=)"?(.*?)"?$/.exec(m);
      if (!mm) throw new Error(`bad matcher format: ${m}`);
      return [mm[1], mm[2] === '=~' ? '~' + mm[3] : mm[3]];
    }));
    const [cmd, sub, ...more] = pos;
    try {
      if (cmd === 'alert' && (!sub || sub === 'query')) {
        const m = matchers(sub ? more : []);
        const list = amAlerts(ctx.state).filter((a) => (flags.silenced === 'true' || !a.silenced) && Object.entries(m).every(([k, v]) => (v.startsWith('~') ? new RegExp(`^(?:${v.slice(1)})$`).test(a.labels[k] ?? '') : a.labels[k] === v)));
        const rows = [['Alertname', 'Starts At', 'Summary', 'State'], ...list.map((a) => [a.name, new Date(a.activeAt * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC'), a.annotations.summary ?? '', a.silenced ? 'suppressed' : 'active'])];
        const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
        ctx.out(rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd()).join('\n') + '\n');
        return 0;
      }
      if (cmd === 'silence' && sub === 'add') {
        const m = matchers(more);
        if (!Object.keys(m).length) throw new Error('no matchers specified');
        if (!flags.comment) {
          ctx.err('amtool: error: comment required by config\n');
          return 1;
        }
        const id = `${(ctx.state.clock % 1e8).toString(16).padStart(8, '0')}-${Object.keys(m).length}a2f-4c1d-9e3b-${(obs.silences.length + 1).toString(16).padStart(12, '0')}`;
        const dur = flags.duration ? parseDuration(flags.duration) : 3600;
        obs.silences.push({ id, matchers: m, comment: flags.comment, createdBy: flags.author ?? ctx.state.user, endsAt: ctx.state.clock + dur * 1000 });
        ctx.out(id + '\n');
        return 0;
      }
      if (cmd === 'silence' && (sub === 'query' || !sub)) {
        const rows = [['ID', 'Matchers', 'Ends At', 'Created By', 'Comment'], ...obs.silences.filter((s) => !s.expired && s.endsAt > ctx.state.clock).map((s) => [s.id, Object.entries(s.matchers).map(([k, v]) => (v.startsWith('~') ? `${k}=~"${v.slice(1)}"` : `${k}="${v}"`)).join(' '), new Date(s.endsAt).toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC'), s.createdBy, s.comment])];
        const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
        ctx.out(rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd()).join('\n') + '\n');
        return 0;
      }
      if (cmd === 'silence' && sub === 'expire') {
        for (const id of more) {
          const s = obs.silences.find((x) => x.id === id);
          if (!s) {
            ctx.err(`amtool: error: silence ${id} not found\n`);
            return 1;
          }
          s.expired = true;
        }
        return 0;
      }
    } catch (e) {
      ctx.err(`amtool: error: ${(e as Error).message}\n`);
      return 1;
    }
    ctx.err('usage: amtool [<flags>] <command> [<args> ...]\n\nCommands:\n  alert query [<matcher-groups>...]\n  silence add [<flags>] [<matcher-groups>...]\n  silence query\n  silence expire <silence-ids>...\n');
    return 1;
  },
};

export { evaluate, PromQLError };
