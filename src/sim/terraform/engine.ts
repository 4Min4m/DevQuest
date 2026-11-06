/** The Terraform core: evaluates modules, refreshes state, plans changes and applies them in dependency order. */
import type { CommandContext } from '../shell/types';
import type { SimState } from '../state';
import { Vfs } from '../vfs/vfs';
import { Diag, loadModule, ModuleCall, ModuleCfg, OutputCfg, ResourceCfg, TfError, VariableCfg } from './config';
import { deepUnknown, evaluate, EvalError, isUnknown, Scope, Sensitive, typeName, UNKNOWN, unwrap } from './eval';
import { functions } from './functions';
import { Attr, Block, Body, Expr, parseHcl, Parser, references } from './hcl';
import { Attrs, AttrSchema, awsCaller, DataType, PROVIDERS, providerOf, ProviderCtx, ProviderError, ResourceType } from './providers';
import { emptyState, StateFile, StateInstance } from './state';

export type Action = 'create' | 'update' | 'replace' | 'delete' | 'noop' | 'read';

export interface Change {
  addr: string;
  /** Resource config id (module prefix + type.name), the unit of dependencies. */
  rcId: string;
  modPrefix: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  key?: number | string;
  action: Action;
  before: Attrs | null;
  after: Attrs | null;
  forces: Set<string>;
  reason?: string;
  rc?: ResourceCfg;
  mod?: ModInst;
  /** Replacement requested with -replace. */
  requested?: boolean;
  /** count.index / each for re-evaluating the config at apply time. */
  inst?: InstCtx;
}

export interface Drift {
  addr: string;
  type: string;
  name: string;
  before: Attrs;
  after: Attrs | null;
}

export interface InstCtx {
  count?: number;
  each?: { key: string; value: unknown };
}

export class ModInst {
  children = new Map<string, ModInst>();
  localCache = new Map<string, unknown>();
  varCache = new Map<string, unknown>();
  constructor(public cfg: ModuleCfg, public path: string[], public parent?: ModInst, public call?: ModuleCall) {}
  get prefix(): string {
    return this.path.map((p) => `module.${p}.`).join('');
  }
  get label(): string {
    return this.path.length ? `module.${this.path.join('.module.')}` : 'the root module';
  }
}

export interface EngineOpts {
  cmd: CommandContext;
  state: SimState;
  dir: string;
  vars: Record<string, { value: unknown; raw: boolean }>;
  prior: StateFile;
  destroy?: boolean;
  refresh?: boolean;
  replace?: string[];
  out(s: string): void;
}

const META_ATTRS = new Set(['count', 'for_each', 'depends_on', 'provider']);
const META_BLOCKS = new Set(['lifecycle', 'provisioner', 'connection']);

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export const instAddr = (prefix: string, mode: string, type: string, name: string, key?: number | string) =>
  `${prefix}${mode === 'data' ? 'data.' : ''}${type}.${name}${key === undefined ? '' : typeof key === 'number' ? `[${key}]` : `["${key}"]`}`;

function deepUnwrap(v: unknown): unknown {
  v = unwrap(v);
  if (isUnknown(v)) return null;
  if (Array.isArray(v)) return v.map(deepUnwrap);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepUnwrap(x)]));
  return v;
}

/** Equal for planning purposes (null ≈ empty collections, sets unordered). */
export function sameValue(a: unknown, b: unknown, s?: AttrSchema): boolean {
  a = unwrap(a);
  b = unwrap(b);
  if (isUnknown(a) || isUnknown(b)) return false;
  const empty = (x: unknown) => x === null || x === undefined || (Array.isArray(x) && !x.length) || (typeof x === 'object' && x !== null && !Array.isArray(x) && !Object.keys(x).length) || x === '';
  if (empty(a) && empty(b)) return true;
  const norm = (x: unknown): string => {
    if (Array.isArray(x)) {
      const items = x.map(norm);
      return '[' + (s?.type === 'set' || s?.block ? items.sort() : items).join(',') + ']';
    }
    if (x && typeof x === 'object') return '{' + Object.keys(x).sort().filter((k) => !empty((x as Attrs)[k]) || typeof (x as Attrs)[k] === 'boolean').map((k) => `${k}:${norm((x as Attrs)[k])}`).join(',') + '}';
    return JSON.stringify(typeof x === 'number' ? x : x);
  };
  return norm(a) === norm(b) || (typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b));
}

export class Engine {
  root: ModInst;
  changes = new Map<string, Change>();
  drift: Drift[] = [];
  phase: 'plan' | 'apply' = 'plan';
  /** Applied (known) attributes by instance address during apply. */
  applied = new Map<string, Attrs | null>();
  private planned = new Set<string>();
  private planning = new Set<string>();
  dataValues = new Map<string, Attrs>();
  refreshed = new Map<string, Attrs | null>();
  private providerCtx = new Map<string, ProviderCtx>();
  private vfs: Vfs;
  diags: Diag[] = [];

  constructor(public o: EngineOpts, rootCfg: ModuleCfg) {
    this.root = new ModInst(rootCfg, []);
    this.vfs = new Vfs(o.state.fs, { name: o.state.user, groups: [] }, () => o.state.clock);
  }

  // ---------------------------------------------------------------- modules

  child(m: ModInst, name: string): ModInst {
    let c = m.children.get(name);
    if (c) return c;
    const call = m.cfg.modules[name];
    const dir = normalizeDir(`${m.cfg.dir}/${call.source}`);
    const cfg = loadModule(this.vfs, dir);
    c = new ModInst(cfg, [...m.path, name], m, call);
    m.children.set(name, c);
    return c;
  }

  allModules(m = this.root): ModInst[] {
    return [m, ...Object.keys(m.cfg.modules).flatMap((n) => this.allModules(this.child(m, n)))];
  }

  // ---------------------------------------------------------------- diagnostics

  diagAt(m: ModInst, file: string, e: { pos: { line: number; col: number } }, summary: string, detail: string, context?: string): Diag {
    const text = m.cfg.files[file]?.split('\n')[e.pos.line - 1];
    return { summary, detail, file: this.relFile(m, file), pos: e.pos, line: text, context };
  }

  relFile(m: ModInst, file: string): string {
    const rel = m.cfg.dir === this.o.dir ? '' : m.cfg.dir.slice(this.o.dir.length + 1) + '/';
    return rel + file;
  }

  ctxOf(rc: ResourceCfg): string {
    return `${rc.mode === 'data' ? 'data' : 'resource'} "${rc.type}" "${rc.name}"`;
  }

  /** Check every reference in an expression before evaluating it (Terraform's own messages). */
  checkRefs(m: ModInst, e: Expr | undefined, file: string, context: string | undefined, inst: { count: boolean; each: boolean; iterators?: string[] }): void {
    if (!e) return;
    const d = (summary: string, detail: string, pos: { line: number; col: number }) => this.diags.push(this.diagAt(m, file, { pos }, summary, detail, context));
    const where = m.path.length ? `module.${m.path.join('.module.')}` : 'the root module';
    for (const r of references(e)) {
      const [root, a, b] = r.path;
      if (typeof root !== 'string' || inst.iterators?.includes(root)) continue;
      switch (root) {
        case 'var':
          if (typeof a === 'string' && !m.cfg.variables[a]) d('Reference to undeclared input variable', `An input variable with the name "${a}" has not been declared. This variable can be declared with a variable "${a}" {} block.`, r.pos);
          break;
        case 'local':
          if (typeof a === 'string' && !m.cfg.locals[a]) d('Reference to undeclared local value', `A local value with the name "${a}" has not been declared.`, r.pos);
          break;
        case 'module':
          if (typeof a === 'string') {
            if (!m.cfg.modules[a]) d('Reference to undeclared module', `No module call named "${a}" is declared in ${where}.`, r.pos);
            else if (typeof b === 'string') {
              try {
                const c = this.child(m, a);
                if (!c.cfg.outputs[b]) d('Unsupported attribute', `This object does not have an attribute named "${b}".`, r.pos);
              } catch {
                /* reported elsewhere */
              }
            }
          }
          break;
        case 'count':
          if (!inst.count) d('Reference to "count" in non-counted context', 'The "count" object can only be used in "module", "resource", and "data" blocks, and only when the "count" argument is set.', r.pos);
          else if (a !== 'index') d('Invalid "count" attribute', `The "count" object does not have an attribute named "${a}". The only supported attribute is count.index, which is the index of each instance of a resource block that has the "count" argument set.`, r.pos);
          break;
        case 'each':
          if (!inst.each) d('Reference to "each" in context without for_each', 'The "each" object can be used only in "module" or "resource" blocks, and only when the "for_each" argument is set.', r.pos);
          break;
        case 'path':
        case 'terraform':
        case 'self':
          break;
        case 'data': {
          if (typeof a !== 'string' || typeof b !== 'string') break;
          if (!m.cfg.resources.some((x) => x.mode === 'data' && x.type === a && x.name === b)) d('Reference to undeclared resource', `A data resource "${a}" "${b}" has not been declared in ${where}.`, r.pos);
          break;
        }
        default: {
          if (r.path.length === 1) {
            d('Invalid reference', 'A reference to a resource type must be followed by at least one attribute access, specifying the resource name.', r.pos);
            break;
          }
          if (typeof a !== 'string') break;
          const rc = m.cfg.resources.find((x) => x.mode === 'managed' && x.type === root && x.name === a);
          if (!rc) {
            d('Reference to undeclared resource', `A managed resource "${root}" "${a}" has not been declared in ${where}.`, r.pos);
            break;
          }
          const counted = rc.count || rc.forEach;
          if (counted && typeof b === 'string') {
            d('Missing resource instance key', `Because ${root}.${a} has "${rc.count ? 'count' : 'for_each'}" set, its attributes must be accessed on specific instances.\n\nFor example, to correlate with indices of a referring resource, use:\n    ${root}.${a}[${rc.count ? 'count.index' : 'each.key'}]`, r.pos);
            break;
          }
          const attrName = counted ? r.path[3] : b;
          const schema = PROVIDERS[providerOf(root)]?.resources[root]?.schema;
          if (schema && typeof attrName === 'string' && !(attrName in schema)) d('Unsupported attribute', `This object has no argument, nested block, or exported attribute named "${attrName}".`, r.pos);
        }
      }
    }
  }

  // ---------------------------------------------------------------- scope

  scope(m: ModInst, inst: InstCtx = {}): Scope {
    const fileRead = (p: string) => {
      const path = p.startsWith('/') ? p : `${this.o.dir}/${p}`;
      try {
        return this.vfs.readFile(normalizeDir(path));
      } catch {
        return null;
      }
    };
    const render = (text: string, vars: Record<string, unknown>, pos: { line: number; col: number }) => {
      const e = new Parser('"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"', 'template');
      let ex: Expr;
      try {
        ex = e.expr(true);
      } catch {
        throw new EvalError('Error in function call', 'Call to function "templatefile" failed: invalid template syntax.', pos);
      }
      const sc: Scope = { root: (n, x) => (n in vars ? vars[n] : (() => { throw new EvalError('Error in function call', `Call to function "templatefile" failed: vars map does not contain key "${n}", referenced at ${x.pos.line}:${x.pos.col}.`, pos); })()), fn: this.fns };
      return evaluate(ex, sc);
    };
    this.fns ??= functions(fileRead, render);
    const self = this;
    const lazy = (get: (k: string) => unknown, has: (k: string) => boolean) =>
      new Proxy({}, { has: (_t, k) => typeof k === 'string' && has(k), get: (_t, k) => (typeof k === 'string' ? get(k) : undefined) });
    return {
      fn: this.fns,
      root(name) {
        switch (name) {
          case 'var':
            return lazy((k) => self.varValue(m, k), (k) => k in m.cfg.variables);
          case 'local':
            return lazy((k) => self.localValue(m, k), (k) => k in m.cfg.locals);
          case 'module':
            return lazy(
              (c) => lazy((out) => self.outputValue(self.child(m, c), out), (out) => out in self.child(m, c).cfg.outputs),
              (c) => c in m.cfg.modules,
            );
          case 'data':
            return lazy(
              (t) => lazy((n) => self.resourceValue(m, m.cfg.resources.find((r) => r.mode === 'data' && r.type === t && r.name === n)!), (n) => m.cfg.resources.some((r) => r.mode === 'data' && r.type === t && r.name === n)),
              (t) => m.cfg.resources.some((r) => r.mode === 'data' && r.type === t),
            );
          case 'count':
            return { index: inst.count };
          case 'each':
            return inst.each ?? {};
          case 'path':
            return { module: m.cfg.dir === self.o.dir ? '.' : m.cfg.dir.slice(self.o.dir.length + 1), root: '.', cwd: self.o.dir };
          case 'terraform':
            return { workspace: 'default' };
        }
        return lazy((n) => self.resourceValue(m, m.cfg.resources.find((r) => r.mode === 'managed' && r.type === name && r.name === n)!), (n) => m.cfg.resources.some((r) => r.mode === 'managed' && r.type === name && r.name === n));
      },
    };
  }
  private fns?: Scope['fn'];

  /** Evaluate an attribute, turning evaluation errors into diagnostics. */
  evalAttr(m: ModInst, a: Attr, file: string, context: string | undefined, inst: InstCtx = {}): unknown {
    try {
      return evaluate(a.expr, this.scope(m, inst));
    } catch (e) {
      if (e instanceof EvalError) throw new TfError([this.diagAt(m, file, e, e.summary, e.detail, context)]);
      throw e;
    }
  }

  varValue(m: ModInst, name: string): unknown {
    if (m.varCache.has(name)) return m.varCache.get(name);
    const v = m.cfg.variables[name];
    let val: unknown;
    if (m.parent) {
      const arg = m.call!.args.find((a) => a.name === name);
      if (arg) val = this.evalAttr(m.parent, arg, m.call!.file, `module "${m.call!.name}"`);
      else if (v.default) val = this.evalAttr(m, v.default, v.file, undefined);
      else throw new TfError([{ ...this.diagAt(m.parent, m.call!.file, m.call!.block, 'Missing required argument', `The argument "${name}" is required, but no definition was found.`), context: `module "${m.call!.name}"`, line: m.call!.block.line }]);
    } else {
      const given = this.o.vars[name];
      if (given) val = given.raw ? convertVar(String(given.value), v) : given.value;
      else if (v.default) val = this.evalAttr(m, v.default, v.file, undefined);
      else throw new TfError([{ summary: 'No value for required variable', detail: `The root module input variable "${name}" is not set, and has no default value. Use a -var or -var-file command line argument to provide a value for this variable.`, file: v.file, pos: v.block.pos, line: v.block.line }]);
    }
    val = typed(val, v, (summary, detail) => this.diagAt(m, v.file, v.block, summary, detail));
    for (const val0 of v.validations) {
      if (!val0.condition) continue;
      const sc = this.scope(m);
      const inner: Scope = { ...sc, root: (n, e) => (n === 'var' ? { [name]: val } : sc.root(n, e)) };
      let ok: unknown;
      try {
        ok = evaluate(val0.condition.expr, inner);
      } catch (e) {
        if (e instanceof EvalError) throw new TfError([this.diagAt(m, v.file, e, e.summary, e.detail)]);
        throw e;
      }
      if (ok === false) {
        const msg = val0.message ? String(unwrap(this.evalAttr(m, val0.message, v.file, undefined))) : 'Invalid value.';
        const c = val0.condition.pos;
        throw new TfError([{ summary: 'Invalid value for variable', detail: `${msg}\n\nThis was checked by the validation rule at ${this.relFile(m, v.file)}:${c.line},${c.col}-${c.col + (val0.condition.line.trim().length - 0)}.`, file: this.relFile(m, v.file), pos: v.block.pos, line: v.block.line }]);
      }
    }
    if (v.sensitive) val = new Sensitive(val);
    m.varCache.set(name, val);
    return val;
  }

  localValue(m: ModInst, name: string): unknown {
    if (m.localCache.has(name) && this.phase === 'plan') return m.localCache.get(name);
    const l = m.cfg.locals[name];
    const key = `${m.prefix}local.${name}`;
    if (this.planning.has(key)) throw new TfError([{ summary: 'Cycle', detail: `Cycle: ${key}`, file: this.relFile(m, l.file), pos: l.attr.pos, line: l.attr.line }]);
    this.planning.add(key);
    try {
      const v = this.evalAttr(m, l.attr, l.file, undefined);
      if (this.phase === 'plan') m.localCache.set(name, v);
      return v;
    } finally {
      this.planning.delete(key);
    }
  }

  outputValue(m: ModInst, name: string): unknown {
    const o = m.cfg.outputs[name];
    if (!o.value) return null;
    const v = this.evalAttr(m, o.value, o.file, undefined);
    return o.sensitive && !(v instanceof Sensitive) ? new Sensitive(v) : v;
  }

  // ---------------------------------------------------------------- providers

  provider(name: string): ProviderCtx {
    let p = this.providerCtx.get(name);
    if (p) return p;
    const pc = this.root.cfg.providers[name];
    let config: Attrs = {};
    if (pc) {
      for (const a of pc.block.body.attrs) config[a.name] = deepUnwrap(this.evalAttr(this.root, a, pc.file, `provider "${name}"`));
      for (const b of pc.block.body.blocks) {
        const inner: Attrs = {};
        for (const a of b.body.attrs) inner[a.name] = deepUnwrap(this.evalAttr(this.root, a, pc.file, `provider "${name}"`));
        ((config[b.type] ??= []) as Attrs[]).push(inner);
      }
    }
    let caller: ReturnType<typeof awsCaller> | null = null;
    const o = this.o;
    const rootCfg = this.root.cfg;
    p = {
      state: o.state,
      cmd: o.cmd,
      config,
      dir: o.dir,
      seed: 0,
      aws() {
        if (caller) return caller;
        try {
          caller = awsCaller(o.cmd, config);
        } catch (e) {
          if (e instanceof ProviderError) {
            const blk = pc?.block;
            throw new TfError([{ summary: e.summary, detail: e.detail, addr: 'provider["registry.terraform.io/hashicorp/aws"]', file: pc?.file, pos: blk?.pos, line: blk?.line, context: pc ? `provider "aws"` : undefined }]);
          }
          throw e;
        }
        void rootCfg;
        return caller;
      },
    };
    this.providerCtx.set(name, p);
    return p;
  }

  typeOf(rc: { mode: string; type: string }): ResourceType | DataType | undefined {
    const prov = PROVIDERS[providerOf(rc.type)];
    return rc.mode === 'data' ? prov?.data[rc.type] : prov?.resources[rc.type];
  }

  // ---------------------------------------------------------------- bodies

  /** Evaluate a resource body against its schema (arguments and nested blocks). */
  evalBody(m: ModInst, rc: ResourceCfg, body: Body, schema: Record<string, AttrSchema>, inst: InstCtx, top: boolean): Attrs {
    const out: Attrs = {};
    const ctx = this.ctxOf(rc);
    const diags: Diag[] = [];
    for (const a of body.attrs) {
      if (top && META_ATTRS.has(a.name)) continue;
      const s = schema[a.name];
      if (!s || (s.computed && !s.optional && !s.required)) {
        diags.push(this.diagAt(m, rc.file, a, 'Unsupported argument', s ? `Can't configure a value for "${a.name}": its value will be decided automatically based on the result of applying this configuration.` : `An argument named "${a.name}" is not expected here.${suggest(a.name, schema)}`, ctx));
        continue;
      }
      out[a.name] = convert(this.evalAttr(m, a, rc.file, ctx, inst), s);
    }
    for (const b of body.blocks) {
      if (top && META_BLOCKS.has(b.type)) continue;
      if (b.type === 'dynamic') {
        const name = b.labels[0];
        const s = schema[name];
        if (!s?.block) {
          diags.push(this.diagAt(m, rc.file, b, 'Unsupported block type', `Blocks of type "${name}" are not expected here.`, ctx));
          continue;
        }
        const fe = b.body.attrs.find((x) => x.name === 'for_each');
        const iter = b.body.attrs.find((x) => x.name === 'iterator');
        const itName = iter && iter.expr.t === 'var' ? iter.expr.name : name;
        const content = b.body.blocks.find((x) => x.type === 'content');
        const coll = unwrap(fe ? this.evalAttr(m, fe, rc.file, ctx, inst) : []);
        if (isUnknown(coll)) {
          out[name] = UNKNOWN;
          continue;
        }
        const entries: [unknown, unknown][] = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : Object.entries((coll as object) ?? {});
        const items: Attrs[] = [];
        for (const [k, v] of entries) {
          items.push(this.withIterator(itName, { key: k, value: v }, () => this.evalBody(m, rc, content?.body ?? { attrs: [], blocks: [] }, s.block!, inst, false)));
        }
        out[name] = [...((out[name] as Attrs[]) ?? []), ...items];
        continue;
      }
      const s = schema[b.type];
      if (!s?.block) {
        diags.push(this.diagAt(m, rc.file, b, 'Unsupported block type', s ? `Blocks of type "${b.type}" are not expected here. Did you mean to define argument "${b.type}"? If so, use the equals sign to assign it a value.` : `Blocks of type "${b.type}" are not expected here.`, ctx));
        continue;
      }
      out[b.type] = [...((out[b.type] as Attrs[]) ?? []), this.evalBody(m, rc, b.body, s.block, inst, false)];
      if (s.maxItems && (out[b.type] as Attrs[]).length > s.maxItems) diags.push(this.diagAt(m, rc.file, b, 'Too many ' + b.type + ' blocks', `No more than ${s.maxItems} "${b.type}" blocks are allowed`, ctx));
    }
    for (const [k, s] of Object.entries(schema)) {
      if (s.required && !(k in out)) {
        const blk = top ? rc.block : undefined;
        diags.push({ ...this.diagAt(m, rc.file, blk ?? rc.block, 'Missing required argument', s.block ? `At least 1 "${k}" blocks are required.` : `The argument "${k}" is required, but no definition was found.`, ctx) });
      }
    }
    if (diags.length) throw new TfError(diags);
    return out;
  }

  /** Evaluate with an extra root name (a dynamic block's iterator). */
  private withIterator<T>(name: string, v: unknown, f: () => T): T {
    const prev = this.scope.bind(this);
    const self = this;
    this.scope = (mm: ModInst, inst?: InstCtx) => {
      const sc = prev(mm, inst);
      return { ...sc, root: (n, e) => (n === name ? v : sc.root(n, e)) };
    };
    try {
      return f();
    } finally {
      self.scope = prev;
    }
  }

  // ---------------------------------------------------------------- planning

  private priorInstances(prefix: string, mode: string, type: string, name: string) {
    const mod = prefix ? prefix.replace(/\.$/, '') : undefined;
    const r = this.o.prior.resources.find((x) => (x.module ?? undefined) === mod && x.mode === mode && x.type === type && x.name === name);
    return r?.instances ?? [];
  }

  /** Refresh one state instance (cached). */
  refreshed_(addr: string, type: string, attrs: Attrs): Attrs | null {
    if (this.refreshed.has(addr)) return this.refreshed.get(addr)!;
    const rt = this.typeOf({ mode: 'managed', type }) as ResourceType | undefined;
    if (!rt || this.o.refresh === false) {
      this.refreshed.set(addr, attrs);
      return attrs;
    }
    const p = this.provider(providerOf(type));
    const now = rt.read({ ...p, seed: hash(addr) }, attrs);
    this.o.out(`${addr}: Refreshing state... [id=${attrs.id}]\n`);
    this.refreshed.set(addr, now);
    if (!now) this.drift.push({ addr, type, name: addr, before: attrs, after: null });
    else if (!sameValue(stripVolatile(now), stripVolatile(attrs))) this.drift.push({ addr, type, name: addr, before: attrs, after: now });
    return now;
  }

  /** Refresh everything in state first (in state order, like Terraform). */
  refreshAll() {
    for (const r of this.o.prior.resources) {
      if (r.mode !== 'managed') continue;
      for (const i of r.instances) this.refreshed_(instAddr(r.module ? r.module + '.' : '', r.mode, r.type, r.name, i.index_key), r.type, i.attributes);
    }
  }

  private expand(m: ModInst, rc: ResourceCfg): { key?: number | string; inst: InstCtx }[] {
    const ctx = this.ctxOf(rc);
    if (rc.count) {
      const v = unwrap(this.evalAttr(m, rc.count, rc.file, ctx));
      if (isUnknown(v)) throw new TfError([this.diagAt(m, rc.file, rc.count, 'Invalid count argument', 'The "count" value depends on resource attributes that cannot be determined until apply, so Terraform cannot predict how many instances will be created. To work around this, use the -target argument to first apply only the resources that the count depends on.', ctx)]);
      if (typeof v !== 'number' || v < 0 || !Number.isInteger(v)) throw new TfError([this.diagAt(m, rc.file, rc.count, 'Invalid count argument', 'The given "count" argument value is unsuitable: must be a whole number greater than or equal to zero.', ctx)]);
      return Array.from({ length: v }, (_, i) => ({ key: i, inst: { count: i } }));
    }
    if (rc.forEach) {
      const v = unwrap(this.evalAttr(m, rc.forEach, rc.file, ctx));
      if (isUnknown(v) || (Array.isArray(v) && v.some((x) => deepUnknown(x)))) throw new TfError([this.diagAt(m, rc.file, rc.forEach, 'Invalid for_each argument', 'The "for_each" map includes keys derived from resource attributes that cannot be determined until apply, and so Terraform cannot determine the full set of keys that will identify the instances of this resource.', ctx)]);
      if (Array.isArray(v) && !(v as unknown[] & { __set?: boolean }).__set && !isSetLike(rc.forEach.expr)) {
        throw new TfError([this.diagAt(m, rc.file, rc.forEach, 'Invalid for_each argument', `The given "for_each" argument value is unsuitable: the "for_each" argument must be a map, or set of strings, and you have provided a value of type ${typeName(v)}.`, ctx)]);
      }
      if (Array.isArray(v)) return [...new Set(v.map(String))].sort().map((k) => ({ key: k, inst: { each: { key: k, value: k } } }));
      if (v && typeof v === 'object') return Object.keys(v).sort().map((k) => ({ key: k, inst: { each: { key: k, value: (v as Attrs)[k] } } }));
      throw new TfError([this.diagAt(m, rc.file, rc.forEach, 'Invalid for_each argument', `The given "for_each" argument value is unsuitable: the "for_each" argument must be a map, or set of strings, and you have provided a value of type ${typeName(v)}.`, ctx)]);
    }
    return [{ inst: {} }];
  }

  /** count.index / each.* for an instance, evaluated now (each.value may have become known). */
  instCtx(m: ModInst, rc: ResourceCfg, key: number | string | undefined): InstCtx {
    if (key === undefined) return {};
    if (typeof key === 'number' && rc.count) return { count: key };
    const v = unwrap(this.evalAttr(m, rc.forEach!, rc.file, this.ctxOf(rc)));
    if (Array.isArray(v)) return { each: { key: String(key), value: String(key) } };
    return { each: { key: String(key), value: (v as Attrs)[String(key)] } };
  }

  rcId(m: ModInst, rc: { mode: string; type: string; name: string }): string {
    return `${m.prefix}${rc.mode === 'data' ? 'data.' : ''}${rc.type}.${rc.name}`;
  }

  /** Plan (or, during apply, look up) a resource; return its value for references. */
  resourceValue(m: ModInst, rc: ResourceCfg): unknown {
    const id = this.rcId(m, rc);
    if (!this.planned.has(id)) this.planResource(m, rc);
    const insts = [...this.changes.values()].filter((c) => c.rcId === id && c.action !== 'delete');
    const val = (c: Change) => {
      const attrs = this.phase === 'apply' && this.applied.has(c.addr) ? this.applied.get(c.addr) : c.after;
      return markSensitive(attrs ?? {}, this.typeOf(rc)?.schema ?? {});
    };
    if (rc.count) return insts.sort((a, b) => Number(a.key) - Number(b.key)).map(val);
    if (rc.forEach) return Object.fromEntries(insts.map((c) => [String(c.key), val(c)]));
    return insts[0] ? val(insts[0]) : {};
  }

  planResource(m: ModInst, rc: ResourceCfg): void {
    const id = this.rcId(m, rc);
    if (this.planned.has(id)) return;
    if (this.planning.has(id)) throw new TfError([{ summary: 'Cycle: ' + [...this.planning].filter((x) => !x.includes('local.')).join(', '), detail: '' }]);
    this.planning.add(id);
    try {
      const rt = this.typeOf(rc);
      if (!rt) {
        throw new TfError([
          rc.mode === 'data'
            ? this.diagAt(m, rc.file, rc.block, 'Invalid data source', `The provider ${PROVIDERS[providerOf(rc.type)] ? 'hashicorp/' + providerOf(rc.type) : 'hashicorp/' + providerOf(rc.type)} does not support data source "${rc.type}".`, this.ctxOf(rc))
            : this.diagAt(m, rc.file, rc.block, 'Invalid resource type', `The provider ${'hashicorp/' + providerOf(rc.type)} does not support resource type "${rc.type}".${PROVIDERS[providerOf(rc.type)] ? suggest(rc.type, PROVIDERS[providerOf(rc.type)].resources as unknown as Record<string, AttrSchema>).replace('Did you mean', '\n\nDid you intend to use') : ''}`, this.ctxOf(rc)),
        ]);
      }
      for (const a of rc.body.attrs) this.checkRefs(m, a.expr, rc.file, this.ctxOf(rc), { count: !!rc.count, each: !!rc.forEach });
      const walk = (b: Body, iterators: string[]) => b.blocks.forEach((x) => {
        const its = x.type === 'dynamic' ? [...iterators, (() => {
          const it = x.body.attrs.find((a) => a.name === 'iterator');
          return it && it.expr.t === 'var' ? it.expr.name : x.labels[0];
        })()] : iterators;
        x.body.attrs.forEach((a) => this.checkRefs(m, a.expr, rc.file, this.ctxOf(rc), { count: !!rc.count, each: !!rc.forEach, iterators: its }));
        walk(x.body, its);
      });
      walk(rc.body, []);
      for (const d of rc.dependsOn) this.checkRefs(m, d, rc.file, this.ctxOf(rc), { count: false, each: false });
      if (this.diags.length) throw new TfError(this.diags.splice(0));
      const keys = this.expand(m, rc);
      for (const { key, inst } of keys) {
        const addr = instAddr(m.prefix, rc.mode, rc.type, rc.name, key);
        const cfg = this.evalBody(m, rc, rc.body, rt.schema, inst, true);
        if (rc.mode === 'data') {
          this.planData(m, rc, rt as DataType, addr, key, cfg);
          continue;
        }
        const priorInst = this.priorInstances(m.prefix, 'managed', rc.type, rc.name).find((i) => i.index_key === key);
        const prior = priorInst ? this.refreshed_(addr, rc.type, priorInst.attributes) : null;
        const ch = this.diff(m, rc, rt as ResourceType, addr, key, cfg, prior);
        ch.inst = inst;
        if (priorInst && (priorInst as StateInstance & { status?: string }).status === 'tainted' && ch.action !== 'create') {
          ch.action = 'replace';
          ch.reason = 'tainted';
        }
        this.changes.set(addr, ch);
      }
    } finally {
      this.planning.delete(id);
      this.planned.add(id);
    }
  }

  private planData(m: ModInst, rc: ResourceCfg, dt: DataType, addr: string, key: number | string | undefined, cfg: Attrs) {
    const base: Change = { addr, rcId: this.rcId(m, rc), modPrefix: m.prefix, mode: 'data', type: rc.type, name: rc.name, key, action: 'read', before: null, after: null, forces: new Set(), rc, mod: m, inst: key === undefined ? {} : typeof key === 'number' ? { count: key } : undefined };
    if (deepUnknown(cfg)) {
      base.after = { ...Object.fromEntries(Object.entries(dt.schema).filter(([, s]) => s.computed).map(([k]) => [k, UNKNOWN])), ...cfg };
      this.changes.set(addr, base);
      return;
    }
    this.o.out(`${addr}: Reading...\n`);
    const p = this.provider(providerOf(rc.type));
    let r: Attrs;
    try {
      r = dt.read({ ...p, seed: hash(addr) }, deepUnwrap(cfg) as Attrs);
    } catch (e) {
      if (e instanceof ProviderError) throw new TfError([{ ...this.diagAt(m, rc.file, rc.block, e.summary, e.detail, this.ctxOf(rc)), addr }]);
      throw e;
    }
    this.o.out(`${addr}: Read complete after 0s [id=${r.id}]\n`);
    this.dataValues.set(addr, r);
    this.changes.set(addr, { ...base, action: 'noop', after: r, inst: undefined });
  }

  private diff(m: ModInst, rc: ResourceCfg, rt: ResourceType, addr: string, key: number | string | undefined, cfg: Attrs, prior: Attrs | null): Change {
    const ch: Change = { addr, rcId: this.rcId(m, rc), modPrefix: m.prefix, mode: 'managed', type: rc.type, name: rc.name, key, action: 'noop', before: prior, after: null, forces: new Set(), rc, mod: m };
    const p = this.provider(providerOf(rc.type));
    const defaults = ((p.config.default_tags as Attrs[] | undefined)?.[0]?.tags as Attrs) ?? {};
    const desired = (k: string, s: AttrSchema): unknown => {
      if (k in cfg) return cfg[k];
      if (s.default !== undefined) return s.default;
      if (s.computed) return prior ? prior[k] : UNKNOWN;
      return null;
    };
    const tagsAll = () => (rt.schema.tags_all ? (deepUnknown(cfg.tags) ? UNKNOWN : { ...defaults, ...((unwrap(cfg.tags) as Attrs) ?? {}) }) : undefined);
    let planned: Attrs = {};
    try {
      planned = rt.plan ? rt.plan({ ...p, seed: hash(addr) }, deepUnknown(cfg) ? {} : (deepUnwrap(cfg) as Attrs)) : {};
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      throw new TfError([{ ...this.diagAt(m, rc.file, rc.block, e.summary, e.detail, this.ctxOf(rc)), addr }]);
    }
    const fresh = (): Attrs => {
      const a: Attrs = {};
      for (const [k, s] of Object.entries(rt.schema)) {
        if (s.computed && !(k in cfg)) a[k] = k in planned ? planned[k] : s.default !== undefined ? s.default : UNKNOWN;
        else if (k in cfg) a[k] = cfg[k];
        else if (s.default !== undefined) a[k] = s.default;
        else a[k] = null;
      }
      if (rt.schema.tags_all) a.tags_all = tagsAll();
      return a;
    };
    if (!prior) {
      ch.action = 'create';
      ch.after = fresh();
      return ch;
    }
    const ignore = rc.lifecycle.ignoreChanges;
    const after: Attrs = { ...prior };
    for (const [k, s] of Object.entries(rt.schema)) {
      if (!s.required && !s.optional) continue;
      if (ignore === 'all' || (ignore as string[]).includes(k)) continue;
      const want = desired(k, s);
      if (!sameValue(want, prior[k], s)) {
        after[k] = want;
        if (s.forceNew) ch.forces.add(k);
        ch.action = 'update';
      }
    }
    if (rt.schema.tags_all && ch.action !== 'noop' && !sameValue(tagsAll(), prior.tags_all)) after.tags_all = tagsAll();
    else if (rt.schema.tags_all && ignore !== 'all' && !(ignore as string[]).includes('tags') && !sameValue(tagsAll(), prior.tags_all)) {
      after.tags_all = tagsAll();
      ch.action = 'update';
    }
    for (const [k, v] of Object.entries(planned)) if (!sameValue(v, prior[k]) && rt.schema[k]?.computed && !(k in cfg)) {
      after[k] = v;
      if (ch.action === 'noop') ch.action = 'update';
    }
    const requested = this.o.replace?.includes(addr);
    if (ch.forces.size || requested || (ch.action === 'update' && !rt.update)) {
      ch.action = 'replace';
      ch.requested = requested && !ch.forces.size;
      const a = fresh();
      for (const [k, s] of Object.entries(rt.schema)) if (s.computed && !(k in cfg) && !(k in planned) && s.forceNew === undefined && k !== 'id' && (s.optional || s.required)) a[k] = UNKNOWN;
      ch.after = a;
      return ch;
    }
    ch.after = after;
    return ch;
  }

  /** Plan everything: config resources, orphans in state, outputs. */
  plan(): void {
    this.refreshAll();
    if (this.o.destroy) {
      for (const r of this.o.prior.resources) {
        if (r.mode !== 'managed') continue;
        for (const i of r.instances) {
          const addr = instAddr(r.module ? r.module + '.' : '', 'managed', r.type, r.name, i.index_key);
          const now = this.refreshed.get(addr) ?? i.attributes;
          if (!now) continue;
          this.changes.set(addr, { addr, rcId: instAddr(r.module ? r.module + '.' : '', 'managed', r.type, r.name), modPrefix: r.module ? r.module + '.' : '', mode: 'managed', type: r.type, name: r.name, key: i.index_key, action: 'delete', before: now, after: null, forces: new Set(), rc: this.findRc(r.module, r.type, r.name) });
        }
      }
      for (const ch of this.changes.values()) {
        if (ch.rc?.lifecycle.preventDestroy) throw new TfError([{ summary: 'Instance cannot be destroyed', detail: `Resource ${ch.addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target flag.`, file: ch.rc.file, pos: ch.rc.block.pos, line: ch.rc.block.line, context: `resource "${ch.type}" "${ch.name}"` }]);
      }
      return;
    }
    const mods = this.allModules();
    // Validate locals and outputs references up front.
    for (const m of mods) {
      for (const [, l] of Object.entries(m.cfg.locals)) this.checkRefs(m, l.attr.expr, l.file, undefined, { count: false, each: false });
      for (const o of Object.values(m.cfg.outputs)) if (o.value) this.checkRefs(m, o.value.expr, o.file, undefined, { count: false, each: false });
      for (const call of Object.values(m.cfg.modules)) for (const a of call.args) this.checkRefs(m, a.expr, call.file, `module "${call.name}"`, { count: false, each: false });
      if (m.parent) {
        for (const a of m.call!.args) {
          if (!m.cfg.variables[a.name]) this.diags.push({ ...this.diagAt(m.parent, m.call!.file, a, 'Unsupported argument', `An argument named "${a.name}" is not expected here.`), context: `module "${m.call!.name}"` });
        }
      }
    }
    if (this.diags.length) throw new TfError(this.diags.splice(0));
    for (const m of mods) for (const rc of m.cfg.resources) this.planResource(m, rc);
    // Orphans: in state but no longer in configuration.
    for (const r of this.o.prior.resources) {
      if (r.mode !== 'managed') continue;
      for (const i of r.instances) {
        const prefix = r.module ? r.module + '.' : '';
        const addr = instAddr(prefix, 'managed', r.type, r.name, i.index_key);
        if (this.changes.has(addr)) continue;
        const now = this.refreshed.get(addr) ?? i.attributes;
        if (!now) continue;
        const rc = this.findRc(r.module, r.type, r.name);
        const base = instAddr(prefix, 'managed', r.type, r.name);
        const reason = !rc ? `because ${base} is not in configuration` : typeof i.index_key === 'number' ? `because index [${i.index_key}] is out of range for count` : i.index_key !== undefined ? `because key ["${i.index_key}"] is not in for_each map` : rc.count || rc.forEach ? `because ${base} has "${rc.count ? 'count' : 'for_each'}" set` : `because ${base} is not in configuration`;
        this.changes.set(addr, { addr, rcId: base, modPrefix: prefix, mode: 'managed', type: r.type, name: r.name, key: i.index_key, action: 'delete', before: now, after: null, forces: new Set(), reason, rc });
      }
    }
    for (const ch of this.changes.values()) {
      if ((ch.action === 'replace' || ch.action === 'delete') && ch.rc?.lifecycle.preventDestroy) {
        throw new TfError([{ summary: 'Instance cannot be destroyed', detail: `Resource ${ch.addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target flag.`, file: ch.rc.file, pos: ch.rc.block.pos, line: ch.rc.block.line, context: `resource "${ch.type}" "${ch.name}"` }]);
      }
    }
  }

  private findRc(module: string | undefined, type: string, name: string): ResourceCfg | undefined {
    try {
      const m = this.allModules().find((x) => (x.path.length ? x.prefix.replace(/\.$/, '') : undefined) === module);
      return m?.cfg.resources.find((r) => r.mode === 'managed' && r.type === type && r.name === name);
    } catch {
      return undefined;
    }
  }

  /** Root outputs as planned (values may be unknown). */
  outputs(): Record<string, { value: unknown; sensitive: boolean; cfg: OutputCfg }> {
    const out: Record<string, { value: unknown; sensitive: boolean; cfg: OutputCfg }> = {};
    if (this.o.destroy) return out;
    for (const o of Object.values(this.root.cfg.outputs)) {
      if (!o.value) continue;
      const v = this.evalAttr(this.root, o.value, o.file, undefined);
      if (hasSensitive(v) && !o.sensitive) {
        throw new TfError([{ summary: 'Output refers to sensitive values', detail: 'To reduce the risk of accidentally exporting sensitive data that was intended to be only internal, Terraform requires that any root module output containing sensitive data be explicitly marked as sensitive, to confirm your intent.\n\nIf you do intend to export this data, annotate the output value as sensitive by adding the following argument:\n    sensitive = true', file: o.file, pos: o.block.pos, line: o.block.line }]);
      }
      out[o.name] = { value: v, sensitive: o.sensitive || hasSensitive(v), cfg: o };
    }
    return out;
  }

  // ---------------------------------------------------------------- dependencies & apply

  /** Resource config ids that `rc` depends on (directly or through locals, variables and module outputs). */
  depsOf(m: ModInst, exprs: (Expr | undefined)[], seen = new Set<string>()): Set<string> {
    const out = new Set<string>();
    const add = (s: Set<string>) => s.forEach((x) => out.add(x));
    for (const e of exprs) {
      for (const r of references(e)) {
        const [root, a, b] = r.path;
        if (typeof root !== 'string' || typeof a !== 'string') continue;
        const key = `${m.prefix}${root}.${a}${root === 'module' || root === 'data' ? '.' + String(b) : ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (root === 'local' && m.cfg.locals[a]) add(this.depsOf(m, [m.cfg.locals[a].attr.expr], seen));
        else if (root === 'var' && m.parent) {
          const arg = m.call!.args.find((x) => x.name === a);
          if (arg) add(this.depsOf(m.parent, [arg.expr], seen));
        } else if (root === 'module' && m.cfg.modules[a] && typeof b === 'string') {
          const c = this.child(m, a);
          const o = c.cfg.outputs[b];
          if (o?.value) add(this.depsOf(c, [o.value.expr], seen));
        } else if (root === 'data' && typeof b === 'string') {
          out.add(`${m.prefix}data.${a}.${b}`);
          const rc = m.cfg.resources.find((x) => x.mode === 'data' && x.type === a && x.name === b);
          if (rc) add(this.depsOf(m, bodyExprs(rc.body), seen));
        } else if (m.cfg.resources.some((x) => x.mode === 'managed' && x.type === root && x.name === a)) out.add(`${m.prefix}${root}.${a}`);
      }
    }
    return out;
  }

  private rcDeps = new Map<string, Set<string>>();
  depsFor(ch: Change): Set<string> {
    if (this.rcDeps.has(ch.rcId)) return this.rcDeps.get(ch.rcId)!;
    let deps = new Set<string>();
    if (ch.rc && ch.mod) deps = this.depsOf(ch.mod, [...bodyExprs(ch.rc.body), ...ch.rc.dependsOn]);
    else {
      const st = this.o.prior.resources.find((r) => instAddr(r.module ? r.module + '.' : '', r.mode, r.type, r.name) === ch.rcId);
      for (const i of st?.instances ?? []) for (const d of i.dependencies ?? []) deps.add(d);
    }
    deps.delete(ch.rcId);
    this.rcDeps.set(ch.rcId, deps);
    return deps;
  }

  /** Changes in the order Terraform would apply them (dependencies first; destroys in reverse). */
  order(): Change[] {
    const list = [...this.changes.values()].filter((c) => c.action !== 'noop' || c.mode === 'data');
    const ids = [...new Set([...this.changes.values()].map((c) => c.rcId))];
    const visited = new Set<string>();
    const topo: string[] = [];
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const sample = [...this.changes.values()].find((c) => c.rcId === id);
      if (sample) for (const d of this.depsFor(sample)) visit(d);
      topo.push(id);
    };
    ids.sort().forEach(visit);
    const rank = (c: Change) => topo.indexOf(c.rcId);
    const deletes = list.filter((c) => c.action === 'delete').sort((a, b) => rank(b) - rank(a));
    const rest = list.filter((c) => c.action !== 'delete').sort((a, b) => rank(a) - rank(b) || String(a.key).localeCompare(String(b.key)));
    return [...deletes, ...rest];
  }
}

function bodyExprs(b: Body): Expr[] {
  return [...b.attrs.map((a) => a.expr), ...b.blocks.flatMap((x) => bodyExprs(x.body))];
}

function isSetLike(e: Expr): boolean {
  return e.t === 'call' && e.name === 'toset';
}

function stripVolatile(a: Attrs): Attrs {
  const { instance_state: _s, ...rest } = a;
  void _s;
  return rest;
}

function hasSensitive(v: unknown): boolean {
  if (v instanceof Sensitive) return true;
  if (Array.isArray(v)) return v.some(hasSensitive);
  if (v && typeof v === 'object' && !isUnknown(v)) return Object.values(v).some(hasSensitive);
  return false;
}

function markSensitive(a: Attrs, schema: Record<string, AttrSchema>): Attrs {
  const out: Attrs = { ...a };
  for (const [k, s] of Object.entries(schema)) if (s.sensitive && k in out) out[k] = new Sensitive(out[k]);
  return out;
}

function suggest(name: string, schema: Record<string, unknown>): string {
  const close = Object.keys(schema).find((k) => lev(k, name) <= 2);
  return close ? ` Did you mean "${close}"?` : '';
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function normalizeDir(p: string): string {
  const parts: string[] = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') parts.pop();
    else parts.push(s);
  }
  return '/' + parts.join('/');
}

/** Convert a value to an attribute's schema type (strings ↔ numbers ↔ bools like cty does). */
function convert(v: unknown, s: AttrSchema): unknown {
  if (v instanceof Sensitive) return new Sensitive(convert(v.v, s));
  if (isUnknown(v) || v === null) return v;
  if (s.type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) return String(v);
  if (s.type === 'number' && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  if (s.type === 'bool' && (v === 'true' || v === 'false')) return v === 'true';
  if (s.type === 'set' && Array.isArray(v)) return [...v].sort((a, b) => String(a).localeCompare(String(b)));
  return v;
}

/** -var / TF_VAR_ values arrive as strings: parse them as HCL for complex types. */
function convertVar(raw: string, v: VariableCfg): unknown {
  const t = v.type ?? 'string';
  if (t === 'string') return raw;
  if (t === 'number') return isNaN(Number(raw)) ? raw : Number(raw);
  if (t === 'bool') return raw === 'true' ? true : raw === 'false' ? false : raw;
  try {
    const body = parseHcl(`x = ${raw}\n`, '<value for var.' + v.name + '>');
    return evaluate(body.attrs[0].expr, { root: () => null });
  } catch {
    return raw;
  }
}

function typed(val: unknown, v: VariableCfg, diag: (s: string, d: string) => Diag): unknown {
  const t = v.type;
  if (!t || t === 'any' || val === null || isUnknown(val)) return val;
  const bad = (why: string) => {
    throw new TfError([{ ...diag('Invalid value for input variable', `The given value is not suitable for var.${v.name} declared at ${v.file}:${v.block.pos.line},1-${v.name.length + 12}: ${why}.`) }]);
  };
  const u = unwrap(val);
  if (t === 'string') return typeof u === 'object' ? bad('string required') : String(u);
  if (t === 'number') return typeof u === 'number' ? u : isNaN(Number(u)) || typeof u === 'object' ? bad('a number is required') : Number(u);
  if (t === 'bool') return typeof u === 'boolean' ? u : u === 'true' || u === 'false' ? u === 'true' : bad('a bool is required');
  if (/^(list|set|tuple)\(/.test(t) && !Array.isArray(u)) return bad('list of ' + t.slice(t.indexOf('(') + 1, -1) + ' required');
  if (/^(map|object)\(/.test(t) && (typeof u !== 'object' || Array.isArray(u))) return bad(`${t.startsWith('map') ? 'map of ' + t.slice(4, -1) : 'object'} required`);
  if (t.startsWith('set(') && Array.isArray(u)) return [...new Set(u)].sort();
  return val;
}

export function emptyPrior(): StateFile {
  return emptyState();
}

export type { StateInstance, Block };
