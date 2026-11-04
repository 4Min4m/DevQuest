/** Charts: loading from disk or the offline repo, values (-f / --set), and rendering to a release manifest. */
import { parse, parseAllDocuments } from 'yaml';
import { joinPath } from '../vfs/path';
import type { Vfs } from '../vfs/vfs';
import { TemplateSet } from './exec';
import { TemplateError } from './parse';
import { REPO_CHARTS } from './repo';

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export class HelmError extends Error {}

export interface Chart {
  meta: V;
  values: V;
  /** Relative paths ("templates/deployment.yaml") → source. */
  files: Record<string, string>;
}

function yamlError(e: unknown): string {
  const msg = (e as Error).message ?? String(e);
  const line = /at line (\d+)/.exec(msg)?.[1];
  const what = msg.split(' at line')[0].replace(/\.$/, '');
  return `error converting YAML to JSON: yaml: ${line ? `line ${line}: ` : ''}${what.charAt(0).toLowerCase()}${what.slice(1)}`;
}

export function chartFromFiles(files: Record<string, string>): Chart {
  if (files['Chart.yaml'] === undefined) throw new HelmError('Chart.yaml file is missing');
  let meta: V;
  try {
    meta = parse(files['Chart.yaml']) ?? {};
  } catch (e) {
    throw new HelmError(`cannot load Chart.yaml: ${yamlError(e)}`);
  }
  if (!meta.apiVersion) throw new HelmError('validation: chart.metadata.apiVersion is required');
  if (!meta.name) throw new HelmError('validation: chart.metadata.name is required');
  if (!meta.version) throw new HelmError('validation: chart.metadata.version is required');
  let values: V = {};
  if (files['values.yaml'] !== undefined) {
    try {
      values = parse(files['values.yaml']) ?? {};
    } catch (e) {
      throw new HelmError(`cannot load values.yaml: ${yamlError(e)}`);
    }
  }
  return { meta, values, files };
}

/** Read a chart directory from the VFS. */
export function loadChartDir(vfs: Vfs, dir: string, shown: string): Chart {
  if (!vfs.exists(dir)) throw new HelmError(`path "${shown}" not found`);
  if (!vfs.isDir(dir)) throw new HelmError(`file '${shown}' does not appear to be a gzipped archive; got 'application/octet-stream'`);
  const files: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const n of vfs.readdir(abs)) {
      const a = joinPath(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      if (vfs.isDir(a)) walk(a, r);
      else files[r] = vfs.readFile(a);
    }
  };
  walk(dir, '');
  return chartFromFiles(files);
}

/** "bitnami/nginx" (optionally a specific version) from the offline repo. */
export function repoChart(repo: string, name: string, version?: string): Chart | null {
  const list = (REPO_CHARTS[repo] ?? []).filter((c) => c.name === name);
  const c = version ? list.find((x) => x.version === version) : list[0];
  return c ? chartFromFiles(c.files) : null;
}

// ------------------------------------------------------------------ values

const isMap = (v: V) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Helm's coalescing: user values override chart defaults; a user null deletes the key. */
export function coalesce(base: V, over: V): V {
  if (!isMap(base) || !isMap(over)) return over === undefined ? base : over;
  const out: V = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = isMap(v) && isMap(out[k]) ? coalesce(out[k], v) : v;
  }
  return out;
}

function typed(raw: string, asString: boolean): V {
  if (asString) return raw;
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw) && raw.length < 16) return Number(raw);
  if (/^\{.*\}$/.test(raw)) return raw.slice(1, -1).split(',').filter(Boolean).map((x) => typed(x, false));
  return raw;
}

/** Apply one `--set a.b=1,c[0]=x` argument to `target`. */
export function applySet(target: V, expr: string, asString = false): void {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '\\' && i + 1 < expr.length) {
      cur += expr[++i];
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur) parts.push(cur);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq <= 0) throw new HelmError(`failed parsing --set data: key "${p}" has no value`);
    const path = p.slice(0, eq);
    const value = typed(p.slice(eq + 1), asString);
    const keys = path.split('.').flatMap((seg) => {
      const m = /^([^[]*)((\[\d+\])*)$/.exec(seg);
      if (!m) return [seg];
      return [m[1], ...[...m[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]))].filter((x) => x !== '');
    });
    let node = target;
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      if (last) {
        node[k] = value;
        return;
      }
      const nextIsIndex = typeof keys[i + 1] === 'number';
      if (node[k] === undefined || node[k] === null || typeof node[k] !== 'object') node[k] = nextIsIndex ? [] : {};
      node = node[k];
    });
  }
}

// ------------------------------------------------------------------ rendering

const INSTALL_ORDER = ['Namespace', 'NetworkPolicy', 'ResourceQuota', 'LimitRange', 'PodDisruptionBudget', 'ServiceAccount', 'Secret', 'ConfigMap', 'StorageClass', 'PersistentVolume', 'PersistentVolumeClaim', 'CustomResourceDefinition', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding', 'Service', 'DaemonSet', 'Pod', 'ReplicationController', 'ReplicaSet', 'Deployment', 'HorizontalPodAutoscaler', 'StatefulSet', 'Job', 'CronJob', 'IngressClass', 'Ingress'];

export interface RenderedDoc {
  source: string;
  text: string;
  obj: V;
}

export interface Release {
  name: string;
  namespace: string;
  revision: number;
  isInstall: boolean;
}

function chartObject(meta: V): V {
  return {
    Name: meta.name,
    Version: String(meta.version),
    AppVersion: meta.appVersion !== undefined ? String(meta.appVersion) : '',
    Description: meta.description ?? '',
    APIVersion: meta.apiVersion,
    Type: meta.type ?? 'application',
    Home: meta.home ?? '',
    Icon: meta.icon ?? '',
    Keywords: meta.keywords ?? [],
    Annotations: meta.annotations ?? {},
    Maintainers: meta.maintainers ?? [],
    Sources: meta.sources ?? [],
    KubeVersion: meta.kubeVersion ?? '',
    Dependencies: meta.dependencies ?? [],
  };
}

/** Render every template; returns the docs in install order, the hooks it skipped, and NOTES.txt. */
export function render(chart: Chart, values: V, rel: Release): { docs: RenderedDoc[]; notes: string; hooks: RenderedDoc[] } {
  const name = chart.meta.name;
  const set = new TemplateSet();
  const templates = Object.keys(chart.files)
    .filter((f) => f.startsWith('templates/'))
    .sort();
  try {
    for (const f of templates) set.add(`${name}/${f}`, chart.files[f]);
  } catch (e) {
    if (e instanceof TemplateError) throw new HelmError(e.message);
    throw e;
  }
  const filesObj = {
    Get: (p: string) => chart.files[p] ?? '',
  };
  const base = {
    Values: values,
    Release: { Name: rel.name, Namespace: rel.namespace, Revision: rel.revision, IsInstall: rel.isInstall, IsUpgrade: !rel.isInstall, Service: 'Helm' },
    Chart: chartObject(chart.meta),
    Capabilities: {
      KubeVersion: { Version: 'v1.31.2', Major: '1', Minor: '31', GitVersion: 'v1.31.2' },
      APIVersions: { Has: (v: string) => ['v1', 'apps/v1', 'batch/v1', 'networking.k8s.io/v1', 'autoscaling/v2', 'rbac.authorization.k8s.io/v1', 'storage.k8s.io/v1', 'policy/v1'].some((x) => v === x || v.startsWith(x + '/')) },
      HelmVersion: { Version: 'v3.16.2' },
    },
    Files: filesObj,
  };
  const docs: RenderedDoc[] = [];
  const hooks: RenderedDoc[] = [];
  let notes = '';
  for (const f of templates) {
    const base2 = f.split('/').pop()!;
    if (base2.startsWith('_')) continue;
    const file = `${name}/${f}`;
    let out: string;
    try {
      out = set.render(file, { ...base, Template: { Name: file, BasePath: `${name}/templates` } });
    } catch (e) {
      if (e instanceof TemplateError) throw new HelmError(e.message);
      throw e;
    }
    if (base2 === 'NOTES.txt') {
      notes = out;
      continue;
    }
    if (!/\.(ya?ml|json)$/.test(f)) continue;
    let parsed;
    try {
      parsed = parseAllDocuments(out);
    } catch (e) {
      throw new HelmError(`YAML parse error on ${file}: ${yamlError(e)}`);
    }
    const texts = out.split(/^---\s*$/m);
    let ti = 0;
    for (const d of parsed) {
      if (d.errors.length) throw new HelmError(`YAML parse error on ${file}: ${yamlError(d.errors[0])}`);
      const obj = d.toJS();
      // Match the doc to its raw text (skipping blank chunks).
      while (ti < texts.length && !texts[ti].trim()) ti++;
      const text = (texts[ti++] ?? '').replace(/^\n+/, '').replace(/\s+$/, '');
      if (obj === null || obj === undefined) continue;
      if (typeof obj !== 'object' || !obj.kind) throw new HelmError(`unable to build kubernetes objects from release manifest: error validating "": error validating data: [apiVersion not set, kind not set]`);
      const doc = { source: file, text, obj };
      if (obj.metadata?.annotations?.['helm.sh/hook']) hooks.push(doc);
      else docs.push(doc);
    }
  }
  const rank = (k: string) => {
    const i = INSTALL_ORDER.indexOf(k);
    return i < 0 ? INSTALL_ORDER.length : i;
  };
  docs.sort((a, b) => rank(a.obj.kind) - rank(b.obj.kind) || a.source.localeCompare(b.source) || String(a.obj.metadata?.name).localeCompare(String(b.obj.metadata?.name)));
  return { docs, notes, hooks };
}

/** The manifest text Helm stores and prints (`helm template`, `helm get manifest`). */
export function manifestText(docs: RenderedDoc[]): string {
  return docs.map((d) => `---\n# Source: ${d.source}\n${d.text}\n`).join('');
}
