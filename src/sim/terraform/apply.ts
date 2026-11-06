/** Applying a plan: provider calls in dependency order, progress lines, and the new state. */
import { Sensitive, unwrap, isUnknown } from './eval';
import { Change, Engine, instAddr } from './engine';
import { TfError, Diag } from './config';
import { Attrs, PROVIDERS, providerOf, ProviderError, ResourceType, DataType } from './providers';
import { StateFile, StateResource, TF_VERSION } from './state';

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

function plain(v: unknown): unknown {
  v = unwrap(v);
  if (isUnknown(v)) return null;
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v === undefined ? null : v;
}

const PROVIDER_ADDR = (t: string) => {
  const p = providerOf(t);
  return p === 'terraform' ? 'provider["terraform.io/builtin/terraform"]' : `provider["registry.terraform.io/${PROVIDERS[p]?.source ?? 'hashicorp/' + p}"]`;
};

export interface ApplyResult {
  added: number;
  changed: number;
  destroyed: number;
  error?: TfError;
  state: StateFile;
}

interface Entry {
  module?: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  key?: number | string;
  attrs: Attrs;
  deps: string[];
  status?: string;
}

/** Execute every change; returns counts and the state to persist (even on error, with what was done). */
export function applyPlan(e: Engine, prior: StateFile, out: (s: string) => void): ApplyResult {
  e.phase = 'apply';
  const entries = new Map<string, Entry>();
  for (const r of prior.resources) {
    for (const i of r.instances) {
      const addr = instAddr(r.module ? r.module + '.' : '', r.mode, r.type, r.name, i.index_key);
      const now = r.mode === 'managed' ? (e.refreshed.has(addr) ? e.refreshed.get(addr) : i.attributes) : i.attributes;
      if (!now) continue;
      entries.set(addr, { module: r.module, mode: r.mode, type: r.type, name: r.name, key: i.index_key, attrs: now, deps: i.dependencies ?? [], status: (i as { status?: string }).status });
    }
  }
  const res: ApplyResult = { added: 0, changed: 0, destroyed: 0, state: prior };
  const put = (c: Change, attrs: Attrs) => {
    const schema = e.typeOf(c)?.schema ?? {};
    const full: Attrs = {};
    for (const k of Object.keys(schema)) full[k] = plain(attrs[k] ?? null);
    for (const [k, v] of Object.entries(attrs)) if (!(k in full)) full[k] = plain(v);
    entries.set(c.addr, { module: c.modPrefix ? c.modPrefix.replace(/\.$/, '') : undefined, mode: c.mode, type: c.type, name: c.name, key: c.key, attrs: full, deps: [...e.depsFor(c)].sort() });
    e.applied.set(c.addr, full);
  };
  const fail = (c: Change, err: unknown): TfError => {
    if (err instanceof TfError) return err;
    if (err instanceof ProviderError) {
      const d: Diag = { summary: err.summary, detail: err.detail, addr: c.addr.replace(/\[.*\]$/, (x) => x) };
      if (c.rc && c.mod) Object.assign(d, { file: e.relFile(c.mod, c.rc.file), pos: c.rc.block.pos, line: c.rc.block.line, context: e.ctxOf(c.rc) });
      return new TfError([d]);
    }
    throw err;
  };
  const progress = (addr: string, verb: string, secs: number) => {
    for (let s = 10; s < secs; s += 10) out(`${addr}: Still ${verb.toLowerCase()}... [${s}s elapsed]\n`);
    return secs;
  };
  try {
    for (const c of e.order()) {
      const p = e.provider(providerOf(c.type));
      const pctx = { ...p, seed: hash(c.addr) };
      const rt = e.typeOf(c);
      if (c.mode === 'data') {
        if (c.action === 'read') {
          const cfg = e.evalBody(c.mod!, c.rc!, c.rc!.body, rt!.schema, e.instCtx(c.mod!, c.rc!, c.key), true);
          out(`${c.addr}: Reading...\n`);
          const r = (rt as DataType).read(pctx, plain(cfg) as Attrs);
          out(`${c.addr}: Read complete after 0s [id=${r.id}]\n`);
          put(c, r);
        } else if (c.after) put(c, c.after);
        continue;
      }
      const t = rt as ResourceType;
      const destroy = (before: Attrs) => {
        out(`${c.addr}: Destroying... [id=${before.id}]\n`);
        try {
          t.delete(pctx, before);
        } catch (err) {
          throw fail(c, err);
        }
        out(`${c.addr}: Destruction complete after ${c.type === 'aws_instance' ? '31' : '0'}s\n`);
        entries.delete(c.addr);
        e.applied.set(c.addr, null);
      };
      if (c.action === 'delete') {
        destroy(c.before!);
        res.destroyed++;
        continue;
      }
      let cfg: Attrs;
      try {
        cfg = plain(e.evalBody(c.mod!, c.rc!, c.rc!.body, t.schema, e.instCtx(c.mod!, c.rc!, c.key), true)) as Attrs;
      } catch (err) {
        throw fail(c, err);
      }
      for (const k of Object.keys(cfg)) if (cfg[k] === null) delete cfg[k];
      const create = () => {
        out(`${c.addr}: Creating...\n`);
        let attrs: Attrs;
        try {
          attrs = t.create(pctx, cfg);
        } catch (err) {
          throw fail(c, err);
        }
        const secs = progress(c.addr, 'creating', t.createSeconds ?? 1);
        out(`${c.addr}: Creation complete after ${secs}s [id=${attrs.id}]\n`);
        put(c, attrs);
      };
      if (c.action === 'create') {
        create();
        res.added++;
      } else if (c.action === 'replace') {
        if (c.rc?.lifecycle.createBeforeDestroy) {
          const old = c.before!;
          create();
          out(`${c.addr} (deposed object): Destroying... [id=${old.id}]\n`);
          t.delete(pctx, old);
          out(`${c.addr}: Destruction complete after 0s\n`);
        } else {
          destroy(c.before!);
          create();
        }
        res.added++;
        res.destroyed++;
      } else if (c.action === 'update') {
        out(`${c.addr}: Modifying... [id=${c.before!.id}]\n`);
        let attrs: Attrs;
        try {
          attrs = t.update!(pctx, c.before!, cfg);
        } catch (err) {
          throw fail(c, err);
        }
        out(`${c.addr}: Modifications complete after 1s [id=${attrs.id}]\n`);
        put(c, attrs);
        res.changed++;
      } else if (c.action === 'noop' && c.after) put(c, c.after);
    }
  } catch (err) {
    if (!(err instanceof TfError)) throw err;
    res.error = err;
  }
  // Unchanged instances keep their (refreshed) attributes.
  for (const c of e.changes.values()) if (c.action === 'noop' && c.mode === 'managed' && c.after && !entries.has(c.addr)) put(c, c.after);
  const outputs: StateFile['outputs'] = {};
  if (!res.error) {
    try {
      for (const [name, o] of Object.entries(e.outputs())) {
        const v = plain(o.value);
        outputs[name] = { value: v, type: typeOfValue(v), ...(o.sensitive ? { sensitive: true } : {}) };
      }
    } catch (err) {
      if (err instanceof TfError) res.error = err;
      else throw err;
    }
  } else Object.assign(outputs, prior.outputs);
  res.state = buildState(prior, entries, outputs);
  return res;
}

function typeOfValue(v: unknown): unknown {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return ['tuple', v.map(typeOfValue)];
  if (v && typeof v === 'object') return ['object', Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeOfValue(x)]))];
  return 'dynamic';
}

export function buildState(prior: StateFile, entries: Map<string, Entry>, outputs: StateFile['outputs']): StateFile {
  const groups = new Map<string, StateResource>();
  const sorted = [...entries.values()].sort((a, b) => `${a.module ?? ''}${a.mode}${a.type}${a.name}`.localeCompare(`${b.module ?? ''}${b.mode}${b.type}${b.name}`) || String(a.key).localeCompare(String(b.key), undefined, { numeric: true }));
  for (const x of sorted) {
    const id = `${x.module ?? ''}|${x.mode}|${x.type}|${x.name}`;
    let g = groups.get(id);
    if (!g) {
      g = { ...(x.module ? { module: x.module } : {}), mode: x.mode, type: x.type, name: x.name, provider: PROVIDER_ADDR(x.type), instances: [] };
      groups.set(id, g);
    }
    g.instances.push({ ...(x.key !== undefined ? { index_key: x.key } : {}), ...(x.status ? { status: x.status } : {}), schema_version: 0, attributes: x.attrs, sensitive_attributes: [], ...(x.deps.length ? { dependencies: x.deps } : {}) });
  }
  return { version: 4, terraform_version: TF_VERSION, serial: prior.serial + 1, lineage: prior.lineage, outputs, resources: [...groups.values()], check_results: null };
}

export { Sensitive };
