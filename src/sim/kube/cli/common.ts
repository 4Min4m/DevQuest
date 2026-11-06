import type { CommandContext } from '../../shell/types';
import { getObj, infoOf, listObjs, resourceFor, ResourceInfo } from '../cluster';
import { reconcile } from '../controllers';
import { ADMIN, allowed, forbiddenMessage, groupOf, Identity } from '../rbac';
import type { J, KObj, KubeState } from '../types';

export class KubectlError extends Error {
  constructor(
    message: string,
    public readonly code = 1,
  ) {
    super(message);
  }
}

export interface Flags {
  flags: Record<string, string | true>;
  multi: Record<string, string[]>;
  args: string[];
  /** Everything after `--`. */
  rest: string[] | null;
}

export interface FlagSpec {
  bool?: string[];
  value?: string[];
  /** short → long */
  alias?: Record<string, string>;
}

const GLOBAL_VALUE = ['n', 'namespace', 'context', 'kubeconfig', 'cluster', 'user', 'v', 'request-timeout', 's', 'server'];
const GLOBAL_BOOL = ['A', 'all-namespaces', 'insecure-skip-tls-verify'];

/** pflag-style parsing: flags anywhere, --x=v, -x v, -xv, -it, `--` ends flags. */
export function parseFlags(cmd: string, argv: string[], spec: FlagSpec): Flags {
  const alias: Record<string, string> = { n: 'namespace', A: 'all-namespaces', ...(spec.alias ?? {}) };
  const bool = new Set([...GLOBAL_BOOL, ...(spec.bool ?? [])]);
  const value = new Set([...GLOBAL_VALUE, ...(spec.value ?? [])]);
  const out: Flags = { flags: {}, multi: {}, args: [], rest: null };
  const set = (name: string, v: string | true) => {
    const key = alias[name] ?? name;
    out.flags[key] = v;
    if (typeof v === 'string') (out.multi[key] ??= []).push(v);
  };
  const help = `See 'kubectl ${cmd} --help' for usage.`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (value.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new KubectlError(`error: flag needs an argument: --${name}\n${help}`);
        set(name, v);
      } else if (bool.has(name)) set(name, eq > 0 ? (a.slice(eq + 1) === 'false' ? 'false' : true) : true);
      else throw new KubectlError(`error: unknown flag: --${name}\n${help}`);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (value.has(c) || value.has(alias[c] ?? '')) {
          let v = a.slice(k + 1);
          if (v.startsWith('=')) v = v.slice(1);
          if (!v) v = argv[++i];
          if (v === undefined) throw new KubectlError(`error: flag needs an argument: '${c}' in -${c}\n${help}`);
          set(c, v);
          break;
        }
        if (bool.has(c) || bool.has(alias[c] ?? '')) set(c, true);
        else throw new KubectlError(`error: unknown shorthand flag: '${c}' in ${a}\n${help}`);
      }
      continue;
    }
    out.args.push(a);
  }
  return out;
}

export interface KCtx {
  ctx: CommandContext;
  ks: KubeState;
  now: number;
  out: (t: string) => void;
  err: (t: string) => void;
  note: (t: string) => void;
  /** Who the request runs as (`--as` impersonation). */
  id: Identity;
}

/** CRDs of the cluster kubectl is talking to (resource types they add only exist once installed). */
let installedCrds: string[] = [];

export function kctx(ctx: CommandContext, id: Identity = ADMIN): KCtx {
  const ks = reconcile(ctx.state);
  installedCrds = ks.crds ?? [];
  return { ctx, ks, now: ctx.state.clock, out: ctx.out, err: ctx.err, note: ctx.note, id };
}

/**
 * RBAC check for one API request; throws the API server's Forbidden error.
 * `sub` is a subresource ("log", "exec", "scale"); `prefix` goes before the message (e.g. `error when creating "x.yaml": `).
 */
export function authorize(k: KCtx, verb: string, res: ResourceInfo, ns: string | undefined, name?: string, sub?: string, prefix = ''): void {
  if (k.id === ADMIN) return;
  const req = { verb, resource: sub ? `${res.plural}/${sub}` : res.plural, group: groupOf(res), namespace: res.namespaced ? ns : undefined, name };
  if (!allowed(k.ks, k.id, req)) throw new KubectlError(`Error from server (Forbidden): ${prefix}${forbiddenMessage(k.id, req)}`);
}

export function namespaceOf(k: KCtx, f: Flags): string {
  const ns = (f.flags.namespace as string | undefined) ?? k.ks.namespace;
  return ns;
}

/** "deployments.apps", "pods" — how errors name a resource. */
export function groupResource(r: ResourceInfo): string {
  return r.apiVersion.includes('/') ? `${r.plural}.${r.apiVersion.split('/')[0]}` : r.plural;
}

export function notFound(r: ResourceInfo, name: string): KubectlError {
  return new KubectlError(`Error from server (NotFound): ${groupResource(r)} "${name}" not found`);
}

export function resolveResource(word: string): ResourceInfo {
  const r = resourceFor(word);
  if (!r || (r.crd && !installedCrds.includes(r.crd))) throw new KubectlError(`error: the server doesn't have a resource type "${word}"`);
  return r;
}

/** Parse `pod/x`, `deploy x y`, `deploy,svc`, into (resource, names). */
export function targets(args: string[]): { res: ResourceInfo; names: string[] }[] {
  if (!args.length) return [];
  if (args[0].includes('/')) {
    return args.map((a) => {
      const [type, name] = a.split('/');
      if (!name) throw new KubectlError(`error: arguments in resource/name form must have a single resource and name`);
      return { res: resolveResource(type), names: [name] };
    });
  }
  const kinds = args[0].split(',').filter(Boolean);
  const names = args.slice(1);
  if (kinds.length > 1 && names.length) throw new KubectlError('error: arguments in resource/name form must have a single resource and name');
  return kinds.map((k) => ({ res: resolveResource(k), names }));
}

/** Label selectors: a=b, a!=b, a, !a, a in (x,y), a notin (x). */
export function selectorMatches(labels: Record<string, string> | undefined, sel: string): boolean {
  const l = labels ?? {};
  const parts = sel.match(/[^,(]+(\([^)]*\))?/g) ?? [];
  return parts.every((raw) => {
    const p = raw.trim();
    if (!p) return true;
    let m;
    if ((m = /^([\w./-]+)\s+(in|notin)\s+\(([^)]*)\)$/.exec(p))) {
      const vals = m[3].split(',').map((s) => s.trim());
      return m[2] === 'in' ? vals.includes(l[m[1]]) : !vals.includes(l[m[1]]);
    }
    if ((m = /^([\w./-]+)\s*!=\s*(.*)$/.exec(p))) return l[m[1]] !== m[2];
    if ((m = /^([\w./-]+)\s*==?\s*(.*)$/.exec(p))) return l[m[1]] === m[2];
    if (p.startsWith('!')) return !(p.slice(1) in l);
    return p in l;
  });
}

export function fieldMatches(o: KObj, sel: string): boolean {
  return sel.split(',').every((p) => {
    const m = /^([\w.]+)\s*(!=|==|=)\s*(.*)$/.exec(p.trim());
    if (!m) return true;
    const v = m[1].split('.').reduce((a: J, k) => a?.[k], o);
    const eq = String(v ?? '') === m[3];
    return m[2] === '!=' ? !eq : eq;
  });
}

export function findOne(k: KCtx, res: ResourceInfo, ns: string, name: string): KObj {
  const o = getObj(k.ks, res.kind, ns, name);
  if (!o) throw notFound(res, name);
  return o;
}

export function listFor(k: KCtx, res: ResourceInfo, f: Flags): KObj[] {
  const all = !!f.flags['all-namespaces'];
  let objs = listObjs(k.ks, res.kind, res.namespaced && !all ? namespaceOf(k, f) : undefined);
  if (f.flags.selector) objs = objs.filter((o) => selectorMatches(o.metadata.labels, f.flags.selector as string));
  if (f.flags['field-selector']) objs = objs.filter((o) => fieldMatches(o, f.flags['field-selector'] as string));
  return objs;
}

/** A pod for `logs` / `exec` / `port-forward`: `pod`, `pod/x`, `deploy/x`, `svc/x`. */
export function podFor(k: KCtx, ref: string, ns: string): KObj {
  const [type, name] = ref.includes('/') ? ref.split('/') : ['pod', ref];
  const res = resolveResource(type);
  if (res.kind === 'Pod') return findOne(k, res, ns, name);
  const owner = findOne(k, res, ns, name);
  const selector = owner.spec?.selector;
  const pods = listObjs(k.ks, 'Pod', ns)
    .filter((p) => !p.metadata.deletionTimestamp && (res.kind === 'Service' ? Object.entries(selector ?? {}).every(([a, b]) => p.metadata.labels?.[a] === b) : Object.entries(selector?.matchLabels ?? {}).every(([a, b]) => p.metadata.labels?.[a] === b)))
    .sort((a, b) => (a.status?.phase === 'Running' ? -1 : 1) - (b.status?.phase === 'Running' ? -1 : 1));
  if (!pods.length) throw new KubectlError(`error: no matching resources found`);
  return pods[0];
}

export { infoOf };
