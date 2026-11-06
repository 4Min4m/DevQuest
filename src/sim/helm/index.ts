/** The `helm` CLI (v3.16) against the simulated cluster: charts on disk or in an offline repo, releases as Secrets. */
import { parse, stringify } from 'yaml';
import { homeOf } from '../shell/identity';
import { runnerClusterAccess } from '../ci/access';
import type { CommandContext, CommandDef } from '../shell/types';
import { joinPath, resolvePath } from '../vfs/path';
import { kctx, KCtx } from '../kube/cli/common';
import { deleteObject } from '../kube/cli/workloads';
import { getObj, listObjs, putObj } from '../kube/cluster';
import { advance, isPodReady, settle } from '../kube/controllers';
import { admit } from '../kube/manifest';
import type { J, KObj } from '../kube/types';
import { applySet, Chart, coalesce, HelmError, loadChartDir, manifestText, render, repoChart } from './chart';
import { toYaml } from './funcs';
import { applyRelease, deleteReleaseSecrets, history, latestReleases, manifestObjects, ReleaseRecord, removeResource, saveRelease, setDeleter } from './release';
import { KNOWN_REPOS, REPO_CHARTS } from './repo';
import { scaffold } from './scaffold';

class Usage extends Error {}

interface Flags {
  flags: Record<string, string | true>;
  multi: Record<string, string[]>;
  args: string[];
}

const GLOBAL_VALUE = ['n', 'namespace', 'kube-context', 'kubeconfig'];
const GLOBAL_BOOL = ['debug'];

function parseFlags(argv: string[], bool: string[], value: string[], alias: Record<string, string> = {}): Flags {
  const al: Record<string, string> = { n: 'namespace', ...alias };
  const b = new Set([...GLOBAL_BOOL, ...bool]);
  const v = new Set([...GLOBAL_VALUE, ...value]);
  const out: Flags = { flags: {}, multi: {}, args: [] };
  const set = (name: string, val: string | true) => {
    const k = al[name] ?? name;
    out.flags[k] = val;
    if (typeof val === 'string') (out.multi[k] ??= []).push(val);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (v.has(name)) {
        const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (val === undefined) throw new Usage(`Error: flag needs an argument: --${name}`);
        set(name, val);
      } else if (b.has(name)) set(name, eq > 0 && a.slice(eq + 1) === 'false' ? 'false' : true);
      else throw new Usage(`Error: unknown flag: --${name}`);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const c = a[1];
      if (v.has(c) || v.has(al[c] ?? '')) {
        const val = a.length > 2 ? a.slice(2).replace(/^=/, '') : argv[++i];
        if (val === undefined) throw new Usage(`Error: flag needs an argument: '${c}' in -${c}`);
        set(c, val);
      } else if (b.has(c) || b.has(al[c] ?? '')) for (const ch of a.slice(1)) set(ch, true);
      else throw new Usage(`Error: unknown shorthand flag: '${c}' in ${a}`);
      continue;
    }
    out.args.push(a);
  }
  return out;
}

// ------------------------------------------------------------------ formatting

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** Go's time.ANSIC: "Tue Nov  3 09:00:00 2026". */
function ansic(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** "2026-11-03 09:00:00.123456789 +0000 UTC" as `helm list` prints it. */
function goTime(ms: number): string {
  const d = new Date(ms);
  const nanos = String(d.getUTCMilliseconds()).padStart(3, '0') + String((ms * 7919) % 1000000).padStart(6, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${nanos} +0000 UTC`;
}

/** Helm's uitable layout: cells padded to the column width and separated by a tab. */
function uitable(rows: string[][]): string {
  const w: number[] = [];
  for (const r of rows) r.forEach((c, i) => (w[i] = Math.max(w[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('\t').replace(/\s+$/, '') + '\n').join('');
}

function statusText(r: ReleaseRecord, showNotes = true): string {
  let out = `NAME: ${r.name}\nLAST DEPLOYED: ${ansic(r.lastDeployed)}\nNAMESPACE: ${r.namespace}\nSTATUS: ${r.status}\nREVISION: ${r.version}\nTEST SUITE: None\n`;
  if (showNotes && r.notes.trim()) out += `NOTES:\n${r.notes.replace(/\n*$/, '\n')}`;
  return out;
}

// ------------------------------------------------------------------ helpers

interface HCtx {
  ctx: CommandContext;
  k: KCtx;
  ns: string;
}

function home(ctx: CommandContext): string {
  return homeOf(ctx.state);
}

function reposFile(ctx: CommandContext): string {
  return joinPath(home(ctx), '.config/helm/repositories.yaml');
}

function repos(ctx: CommandContext): Record<string, string> {
  try {
    const doc = parse(ctx.vfs.readFile(reposFile(ctx))) ?? {};
    return Object.fromEntries((doc.repositories ?? []).map((r: J) => [r.name, r.url]));
  } catch {
    return {};
  }
}

function saveRepos(ctx: CommandContext, list: Record<string, string>): void {
  const dir = joinPath(home(ctx), '.config/helm');
  if (!ctx.vfs.exists(dir)) ctx.vfs.mkdir(dir, { parents: true });
  ctx.vfs.writeFile(reposFile(ctx), stringify({ apiVersion: '', generated: '0001-01-01T00:00:00Z', repositories: Object.entries(list).map(([name, url]) => ({ caFile: '', certFile: '', insecure_skip_tls_verify: false, keyFile: '', name, pass_credentials_all: false, password: '', url, username: '' })) }));
}

/** Which offline repo serves a URL. */
const repoKey = (url: string) => Object.entries(KNOWN_REPOS).find(([, u]) => u === url.replace(/\/$/, ''))?.[0];

/** Resolve a chart reference: a directory, or `repo/name` from an added repository. */
function loadChart(h: HCtx, ref: string, version: string | undefined, verb: string): Chart {
  const abs = resolvePath(h.ctx.state.cwd, ref);
  if (h.ctx.vfs.exists(abs)) return loadChartDir(h.ctx.vfs, abs, ref);
  if (ref.startsWith('.') || ref.startsWith('/')) throw new HelmError(`path "${ref}" not found`);
  const slash = ref.indexOf('/');
  if (slash < 0) throw new HelmError(`non-absolute URLs should be in form of repo_name/path_to_chart, got: ${ref}`);
  const repo = ref.slice(0, slash);
  const name = ref.slice(slash + 1);
  const url = repos(h.ctx)[repo];
  if (!url) throw new HelmError(`repo ${repo} not found`);
  const key = repoKey(url);
  const c = key ? repoChart(key, name, version) : null;
  if (!c) throw new HelmError(version ? `chart "${name}" matching ${version} not found in ${repo} index. (try 'helm repo update'): no chart version found for ${name}-${version}` : `chart "${name}" not found in ${repo} index. (try 'helm repo update'): no chart name found`);
  void verb;
  return c;
}

/** User values from -f files and --set/--set-string flags. */
function userValues(h: HCtx, f: Flags): J {
  let vals: J = {};
  for (const file of f.multi.values ?? []) {
    let text: string;
    try {
      text = h.ctx.vfs.readFile(resolvePath(h.ctx.state.cwd, file));
    } catch {
      throw new HelmError(`open ${file}: no such file or directory`);
    }
    let doc: J;
    try {
      doc = parse(text) ?? {};
    } catch (e) {
      throw new HelmError(`failed to parse ${file}: error converting YAML to JSON: yaml: ${(e as Error).message.split('\n')[0]}`);
    }
    vals = coalesce(vals, doc);
  }
  for (const s of f.multi.set ?? []) applySet(vals, s);
  for (const s of f.multi['set-string'] ?? []) applySet(vals, s, true);
  return vals;
}

function waitReady(h: HCtx, manifest: string, ns: string, timeoutMs: number): boolean {
  const objs = manifestObjects(manifest, ns).filter((o) => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(o.kind));
  const ready = () =>
    objs.every((o) => {
      const w = getObj(h.k.ks, o.kind, o.namespace, o.name);
      if (!w) return true;
      if (o.kind === 'DaemonSet') return (w.status?.numberReady ?? 0) >= (w.status?.desiredNumberScheduled ?? 0);
      const want = w.spec.replicas ?? 1;
      const pods = listObjs(h.k.ks, 'Pod', o.namespace).filter((p) => Object.entries(w.spec.selector?.matchLabels ?? {}).every(([a, b]) => p.metadata.labels?.[a] === b) && !p.metadata.deletionTimestamp);
      return (w.status?.readyReplicas ?? 0) >= want && (w.status?.updatedReplicas ?? want) >= want && pods.filter(isPodReady).length >= want;
    });
  for (let t = 0; t <= timeoutMs; t += 2000) {
    if (ready()) return true;
    advance(h.ctx.state, 2000);
  }
  return ready();
}

function timeoutOf(f: Flags): number {
  const t = (f.flags.timeout as string | undefined) ?? '5m0s';
  let ms = 0;
  for (const [, n, u] of t.matchAll(/(\d+)(h|m|s)/g)) ms += Number(n) * (u === 'h' ? 3600000 : u === 'm' ? 60000 : 1000);
  if (!ms) throw new Usage(`Error: invalid argument "${t}" for "--timeout" flag: time: invalid duration "${t}"`);
  return ms;
}

const INSTALL_BOOL = ['create-namespace', 'wait', 'atomic', 'dry-run', 'generate-name', 'g', 'install', 'reuse-values', 'reset-values', 'force', 'skip-crds', 'wait-for-jobs', 'cleanup-on-fail'];
const INSTALL_VALUE = ['f', 'values', 'set', 'set-string', 'version', 'timeout', 'description', 'name-template', 'o', 'output'];

// ------------------------------------------------------------------ install / upgrade

function install(h: HCtx, f: Flags, upgradeOf?: ReleaseRecord[]): number {
  const failWord = upgradeOf ? 'UPGRADE FAILED' : 'INSTALLATION FAILED';
  const generate = !!(f.flags['generate-name'] || f.flags.g);
  const [a0, a1] = f.args;
  const name = generate ? undefined : a0;
  const ref = generate ? a0 : a1;
  if (!ref) throw new Usage(generate ? 'Error: "helm install" requires at least 1 argument\n\nUsage:  helm install [NAME] [CHART] [flags]' : name ? 'Error: "helm install" requires 2 arguments\n\nUsage:  helm install [NAME] [CHART] [flags]' : 'Error: "helm install" requires at least 1 argument\n\nUsage:  helm install [NAME] [CHART] [flags]');
  const ns = h.ns;
  try {
    const chart = loadChart(h, ref, f.flags.version as string | undefined, 'install');
    const relName = name ?? `${chart.meta.name}-${Math.floor(h.k.now / 1000)}`;
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(relName) || relName.length > 53) throw new HelmError(`release name "${relName}": invalid release name, must match regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$ and the length must not be longer than 53`);
    const hist = history(h.k.ks, ns, relName);
    if (!upgradeOf && hist.length && hist[hist.length - 1].status !== 'uninstalled') throw new HelmError('cannot re-use a name that is still in use');
    if (!getObj(h.k.ks, 'Namespace', undefined, ns)) {
      if (!f.flags['create-namespace']) throw new HelmError(`create: failed to create: namespaces "${ns}" not found`);
      if (!f.flags['dry-run']) putObj(h.k.ks, admit(h.k.ks, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } }, h.k.now, { source: 'helm', mode: 'create' }).obj);
    }
    const prev = upgradeOf?.filter((r) => r.status === 'deployed').pop() ?? upgradeOf?.[upgradeOf.length - 1];
    let config = userValues(h, f);
    if (prev && f.flags['reuse-values'] && !f.flags['reset-values']) config = coalesce(prev.config, config);
    const values = coalesce(JSON.parse(JSON.stringify(chart.values)), config);
    const version = (hist[hist.length - 1]?.version ?? 0) + 1;
    const rendered = render(chart, values, { name: relName, namespace: ns, revision: version, isInstall: !upgradeOf });
    const manifest = manifestText(rendered.docs);
    const record: ReleaseRecord = {
      name: relName,
      namespace: ns,
      version,
      status: 'deployed',
      chart: { name: chart.meta.name, version: String(chart.meta.version), appVersion: chart.meta.appVersion !== undefined ? String(chart.meta.appVersion) : '' },
      config,
      values,
      manifest,
      notes: rendered.notes,
      firstDeployed: prev?.firstDeployed ?? h.k.now,
      lastDeployed: h.k.now,
      description: upgradeOf ? 'Upgrade complete' : 'Install complete',
    };
    if (f.flags['dry-run']) {
      if (upgradeOf) h.ctx.out(`Release "${relName}" has been upgraded. Happy Helming!\n`);
      h.ctx.out(statusText({ ...record, status: upgradeOf ? 'pending-upgrade' : 'pending-install' }, false).replace('TEST SUITE: None\n', 'TEST SUITE: None\nHOOKS:\nMANIFEST:\n' + manifest) + (record.notes.trim() ? `\nNOTES:\n${record.notes.replace(/\n*$/, '\n')}` : ''));
      return 0;
    }
    try {
      applyRelease(h.k.ks, h.k.now, rendered.docs, { name: relName, namespace: ns }, upgradeOf ? 'update' : 'install', prev?.manifest);
    } catch (e) {
      if (!(e instanceof HelmError)) throw e;
      // Ownership conflicts stop before anything is recorded; API errors leave a failed release.
      if (!/^Unable to continue/.test(e.message)) saveRelease(h.k.ks, h.k.now, { ...record, status: 'failed', description: `${upgradeOf ? 'Upgrade' : 'Release'} "${relName}" failed: ${e.message}` });
      throw e;
    }
    if (prev) for (const r of upgradeOf!) if (r.status === 'deployed') saveRelease(h.k.ks, h.k.now, { ...r, status: 'superseded' });
    saveRelease(h.k.ks, h.k.now, record);
    if (f.flags.wait || f.flags.atomic) {
      if (!waitReady(h, manifest, ns, timeoutOf(f))) {
        saveRelease(h.k.ks, h.ctx.state.clock, { ...record, status: 'failed', description: `${upgradeOf ? 'Upgrade' : 'Release'} "${relName}" failed: context deadline exceeded` });
        if (f.flags.atomic) {
          if (prev) {
            rollbackTo(h, relName, prev, `Rollback to ${prev.version}`);
            throw new HelmError(`release ${relName} failed, and has been rolled back due to atomic being set: context deadline exceeded`);
          }
          uninstallRelease(h, relName);
          throw new HelmError(`release ${relName} failed, and has been uninstalled due to atomic being set: context deadline exceeded`);
        }
        throw new HelmError('context deadline exceeded');
      }
    }
    if (upgradeOf) h.ctx.out(`Release "${relName}" has been upgraded. Happy Helming!\n`);
    h.ctx.out(statusText(record));
    return 0;
  } catch (e) {
    if (e instanceof HelmError) throw new HelmError(`${failWord}: ${e.message}`);
    throw e;
  }
}

function upgrade(h: HCtx, f: Flags): number {
  const [name, ref] = f.args;
  if (!name || !ref) throw new Usage('Error: "helm upgrade" requires 2 arguments\n\nUsage:  helm upgrade [RELEASE] [CHART] [flags]');
  const hist = history(h.k.ks, h.ns, name);
  const live = hist.filter((r) => r.status !== 'uninstalled');
  if (!live.length) {
    if (!f.flags.install) throw new HelmError(`UPGRADE FAILED: "${name}" has no deployed releases`);
    h.ctx.out(`Release "${name}" does not exist. Installing it now.\n`);
    return install(h, { ...f, args: [name, ref] });
  }
  if (!live.some((r) => r.status === 'deployed') && live[live.length - 1].status === 'failed' && live.length === 1) {
    throw new HelmError(`UPGRADE FAILED: "${name}" has no deployed releases`);
  }
  return install(h, { ...f, args: [name, ref] }, hist);
}

// ------------------------------------------------------------------ rollback / uninstall

function rollbackTo(h: HCtx, name: string, target: ReleaseRecord, description: string): ReleaseRecord {
  const hist = history(h.k.ks, h.ns, name);
  const current = hist[hist.length - 1];
  const docs = manifestToDocs(target.manifest);
  const now = h.ctx.state.clock;
  applyRelease(h.k.ks, now, docs, { name, namespace: h.ns }, 'update', current.manifest);
  for (const r of hist) if (r.status === 'deployed') saveRelease(h.k.ks, now, { ...r, status: 'superseded' });
  const rec: ReleaseRecord = { ...target, version: current.version + 1, status: 'deployed', lastDeployed: now, description };
  saveRelease(h.k.ks, now, rec);
  return rec;
}

function manifestToDocs(manifest: string) {
  return manifest
    .split(/^---\n/m)
    .filter((c) => c.trim())
    .map((c) => {
      const source = /^# Source: (.*)$/m.exec(c)?.[1] ?? '';
      return { source, text: c, obj: parse(c) };
    });
}

function uninstallRelease(h: HCtx, name: string): void {
  const hist = history(h.k.ks, h.ns, name);
  const cur = hist[hist.length - 1];
  for (const o of manifestObjects(cur.manifest, h.ns).reverse()) removeResource(h.k.ks, h.k.now, o);
  deleteReleaseSecrets(h.k.ks, h.ns, name);
}

// ------------------------------------------------------------------ the command

const HELP = `The Kubernetes package manager

Common actions for Helm:

- helm search:    search for charts
- helm pull:      download a chart to your local directory to view
- helm install:   upload the chart to Kubernetes
- helm list:      list releases of charts

Usage:
  helm [command]

Available Commands:
  create      create a new chart with the given name
  get         download extended information of a named release
  history     fetch release history
  install     install a chart
  lint        examine a chart for possible issues
  list        list releases
  pull        download a chart from a repository and (optionally) unpack it in local directory
  repo        add, list, remove, update, and index chart repositories
  rollback    roll back a release to a previous revision
  search      search for a keyword in charts
  show        show information of a chart
  status      display the status of the named release
  template    locally render templates
  uninstall   uninstall a release
  upgrade     upgrade a release
  version     print the client version information
`;

const NOT_SIMULATED = new Set(['dependency', 'dep', 'package', 'push', 'registry', 'plugin', 'test', 'verify', 'env', 'completion', 'diff', 'mapkubeapis', 'secrets', 'kubeconform']);

export const helm: CommandDef = {
  name: 'helm',
  summary: 'the Kubernetes package manager (simulated)',
  run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
      ctx.out(HELP);
      return 0;
    }
    if (sub === 'version') {
      ctx.out('version.BuildInfo{Version:"v3.16.2", GitCommit:"13654a52f7c70a143b1dd51416d633e1071faffb", GitTreeState:"clean", GoVersion:"go1.22.7"}\n');
      return 0;
    }
    try {
      return run(ctx, sub, rest);
    } catch (e) {
      if (e instanceof HelmError) {
        ctx.err(`Error: ${e.message}\n`);
        return 1;
      }
      if (e instanceof Usage) {
        ctx.err(e.message + '\n');
        return 1;
      }
      throw e;
    } finally {
      if (ctx.state.kube) settle(ctx.state);
    }
  },
};

setDeleter((ks, now, o: KObj) => {
  // kubectl's delete semantics, minus the CLI output.
  deleteObject({ ks, now, ctx: undefined as never, out: () => undefined, err: () => undefined, note: () => undefined } as unknown as KCtx, o);
});

function ctxFor(ctx: CommandContext, f: Flags): HCtx {
  const k = kctx(ctx);
  return { ctx, k, ns: (f.flags.namespace as string | undefined) ?? k.ks.namespace };
}

function needRelease(h: HCtx, name: string | undefined, cmd: string): ReleaseRecord[] {
  if (!name) throw new Usage(`Error: "helm ${cmd}" requires 1 argument\n\nUsage:  helm ${cmd} RELEASE_NAME [flags]`);
  const hist = history(h.k.ks, h.ns, name);
  if (!hist.length) throw new HelmError(cmd === 'uninstall' ? `uninstall: Release not loaded: ${name}: release: not found` : 'release: not found');
  return hist;
}

function run(ctx: CommandContext, sub: string, argv: string[]): number {
  if (['install', 'i', 'upgrade', 'rollback', 'uninstall', 'delete', 'del', 'un', 'list', 'ls', 'history', 'hist', 'status', 'get'].includes(sub)) {
    const denied = runnerClusterAccess(ctx, 'helm');
    if (denied) throw new HelmError(denied.replace(/^Error: /, ''));
  }
  switch (sub) {
    case 'install':
    case 'i': {
      const f = parseFlags(argv, INSTALL_BOOL, INSTALL_VALUE, { f: 'values', g: 'generate-name', o: 'output' });
      return install(ctxFor(ctx, f), f);
    }
    case 'upgrade': {
      const f = parseFlags(argv, INSTALL_BOOL, INSTALL_VALUE, { f: 'values', i: 'install', o: 'output' });
      return upgrade(ctxFor(ctx, f), f);
    }
    case 'rollback': {
      const f = parseFlags(argv, ['wait', 'force', 'dry-run', 'cleanup-on-fail', 'recreate-pods'], ['timeout', 'history-max']);
      const h = ctxFor(ctx, f);
      const [name, rev] = f.args;
      const hist = needRelease(h, name, 'rollback');
      const current = hist[hist.length - 1];
      const want = rev && rev !== '0' ? Number(rev) : current.version - 1;
      const target = hist.find((r) => r.version === want);
      if (!target) throw new HelmError(want < 1 ? 'release has no previous version to rollback to' : `release: not found`);
      rollbackTo(h, name, target, `Rollback to ${want}`);
      ctx.out('Rollback was a success! Happy Helming!\n');
      return 0;
    }
    case 'uninstall':
    case 'delete':
    case 'del':
    case 'un': {
      const f = parseFlags(argv, ['keep-history', 'dry-run', 'wait', 'no-hooks', 'ignore-not-found'], ['timeout', 'cascade', 'description']);
      const h = ctxFor(ctx, f);
      if (!f.args.length) throw new Usage('Error: "helm uninstall" requires at least 1 argument\n\nUsage:  helm uninstall RELEASE_NAME [...] [flags]');
      for (const name of f.args) {
        if (f.flags['ignore-not-found'] && !history(h.k.ks, h.ns, name).length) continue;
        needRelease(h, name, 'uninstall');
        uninstallRelease(h, name);
        ctx.out(`release "${name}" uninstalled\n`);
      }
      return 0;
    }
    case 'list':
    case 'ls': {
      const f = parseFlags(argv, ['A', 'all-namespaces', 'a', 'all', 'q', 'short', 'deployed', 'failed', 'superseded', 'uninstalled', 'pending', 'no-headers'], ['o', 'output', 'f', 'filter', 'max', 'l', 'selector'], { A: 'all-namespaces', a: 'all', q: 'short', o: 'output', f: 'filter', l: 'selector' });
      const h = ctxFor(ctx, f);
      let rels = latestReleases(h.k.ks, f.flags['all-namespaces'] ? undefined : h.ns);
      const want = ['deployed', 'failed', 'superseded', 'uninstalled', 'pending'].filter((s) => f.flags[s]);
      if (!f.flags.all) rels = rels.filter((r) => (want.length ? want.includes(r.status.replace(/-.*/, '')) : ['deployed', 'failed'].includes(r.status)));
      if (f.flags.filter) rels = rels.filter((r) => new RegExp(f.flags.filter as string).test(r.name));
      if (f.flags.short) {
        ctx.out(rels.map((r) => r.name + '\n').join(''));
        return 0;
      }
      if (f.flags.output === 'json' || f.flags.output === 'yaml') {
        const data = rels.map((r) => ({ name: r.name, namespace: r.namespace, revision: String(r.version), updated: goTime(r.lastDeployed), status: r.status, chart: `${r.chart.name}-${r.chart.version}`, app_version: r.chart.appVersion }));
        ctx.out(f.flags.output === 'json' ? JSON.stringify(data) + '\n' : stringify(data));
        return 0;
      }
      const rows = rels.map((r) => [r.name, r.namespace, String(r.version), goTime(r.lastDeployed), r.status, `${r.chart.name}-${r.chart.version}`, r.chart.appVersion]);
      ctx.out(uitable(f.flags['no-headers'] ? rows : [['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION'], ...rows]));
      return 0;
    }
    case 'history':
    case 'hist': {
      const f = parseFlags(argv, [], ['max', 'o', 'output'], { o: 'output' });
      const h = ctxFor(ctx, f);
      const hist = needRelease(h, f.args[0], 'history');
      ctx.out(uitable([['REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION', 'DESCRIPTION'], ...hist.map((r) => [String(r.version), ansic(r.lastDeployed), r.status, `${r.chart.name}-${r.chart.version}`, r.chart.appVersion, r.description])]));
      return 0;
    }
    case 'status': {
      const f = parseFlags(argv, ['show-desc', 'show-resources'], ['revision', 'o', 'output'], { o: 'output' });
      const h = ctxFor(ctx, f);
      const hist = needRelease(h, f.args[0], 'status');
      const r = f.flags.revision ? hist.find((x) => x.version === Number(f.flags.revision)) : hist[hist.length - 1];
      if (!r) throw new HelmError('release: not found');
      ctx.out(statusText(r));
      return 0;
    }
    case 'get': {
      const [what, ...rest] = argv;
      const f = parseFlags(rest, ['a', 'all'], ['revision', 'o', 'output'], { a: 'all', o: 'output' });
      const h = ctxFor(ctx, f);
      if (!['values', 'manifest', 'notes', 'all', 'hooks', 'metadata'].includes(what ?? '')) throw new Usage(`Error: unknown command "${what ?? ''}" for "helm get"\nAvailable Commands: all, hooks, manifest, metadata, notes, values`);
      const hist = needRelease(h, f.args[0], `get ${what}`);
      const r = f.flags.revision ? hist.find((x) => x.version === Number(f.flags.revision)) : hist[hist.length - 1];
      if (!r) throw new HelmError('release: not found');
      if (what === 'values') {
        const v = f.flags.all ? r.values : r.config;
        if (f.flags.output === 'json') ctx.out(JSON.stringify(v) + '\n');
        else ctx.out(`${f.flags.all ? 'COMPUTED' : 'USER-SUPPLIED'} VALUES:\n${Object.keys(v ?? {}).length ? toYaml(v) : 'null'}\n`);
      } else if (what === 'manifest') ctx.out(r.manifest);
      else if (what === 'notes') ctx.out(r.notes.trim() ? `NOTES:\n${r.notes.replace(/\n*$/, '\n')}` : '');
      else if (what === 'hooks') ctx.out('');
      else if (what === 'metadata') ctx.out(`NAME: ${r.name}\nCHART: ${r.chart.name}\nVERSION: ${r.chart.version}\nAPP_VERSION: ${r.chart.appVersion}\nNAMESPACE: ${r.namespace}\nREVISION: ${r.version}\nSTATUS: ${r.status}\nDEPLOYED_AT: ${new Date(r.lastDeployed).toISOString().replace(/\.\d+Z$/, 'Z')}\n`);
      else ctx.out(`NAME: ${r.name}\nLAST DEPLOYED: ${ansic(r.lastDeployed)}\nNAMESPACE: ${r.namespace}\nSTATUS: ${r.status}\nREVISION: ${r.version}\nTEST SUITE: None\nUSER-SUPPLIED VALUES:\n${Object.keys(r.config ?? {}).length ? toYaml(r.config) : 'null'}\n\nCOMPUTED VALUES:\n${toYaml(r.values)}\n\nHOOKS:\nMANIFEST:\n${r.manifest}${r.notes.trim() ? `\nNOTES:\n${r.notes.replace(/\n*$/, '\n')}` : ''}`);
      return 0;
    }
    case 'template': {
      const f = parseFlags(argv, [...INSTALL_BOOL, 'include-crds', 'validate'], [...INSTALL_VALUE, 's', 'show-only', 'kube-version', 'api-versions'], { f: 'values', s: 'show-only', g: 'generate-name' });
      const h = ctxFor(ctx, f);
      const [a0, a1] = f.args;
      const ref = a1 ?? a0;
      const name = a1 ? a0 : 'release-name';
      if (!ref) throw new Usage('Error: "helm template" requires at least 1 argument\n\nUsage:  helm template [NAME] [CHART] [flags]');
      const chart = loadChart(h, ref, f.flags.version as string | undefined, 'template');
      const values = coalesce(JSON.parse(JSON.stringify(chart.values)), userValues(h, f));
      const r = render(chart, values, { name, namespace: h.ns, revision: 1, isInstall: true });
      let docs = [...r.docs, ...r.hooks];
      if (f.flags['show-only']) {
        const want = f.multi['show-only'].map((s) => `${chart.meta.name}/${s}`);
        docs = docs.filter((d) => want.includes(d.source));
        if (!docs.length) throw new HelmError(`could not find template ${f.multi['show-only'][0]} in chart`);
      }
      ctx.out(manifestText(docs));
      return 0;
    }
    case 'lint': {
      const f = parseFlags(argv, ['strict', 'quiet'], ['f', 'values', 'set', 'set-string'], { f: 'values' });
      const h = ctxFor(ctx, f);
      const paths = f.args.length ? f.args : ['.'];
      let failed = 0;
      for (const p of paths) {
        ctx.out(`==> Linting ${p}\n`);
        const msgs: string[] = [];
        let bad = false;
        try {
          const chart = loadChartDir(ctx.vfs, resolvePath(ctx.state.cwd, p), p);
          if (!chart.meta.icon) msgs.push('[INFO] Chart.yaml: icon is recommended');
          const values = coalesce(JSON.parse(JSON.stringify(chart.values)), userValues(h, f));
          try {
            render(chart, values, { name: 'release-name', namespace: h.ns, revision: 1, isInstall: true });
          } catch (e) {
            if (!(e instanceof HelmError)) throw e;
            const file = /([^\s:()]+\/templates\/[^\s:()]+)/.exec(e.message)?.[1] ?? 'x/templates/';
            msgs.push(`[ERROR] ${file.replace(/^[^/]+\//, '')}: ${e.message}`);
            bad = true;
          }
        } catch (e) {
          if (!(e instanceof HelmError)) throw e;
          msgs.push(`[ERROR] Chart.yaml: ${e.message}`);
          bad = true;
        }
        if (msgs.length) ctx.out(msgs.join('\n') + '\n');
        ctx.out('\n');
        if (bad) {
          ctx.out(`Error: 1 chart(s) linted, 1 chart(s) failed\n`);
          failed++;
        }
      }
      if (failed) return 1;
      ctx.out(`${paths.length} chart(s) linted, 0 chart(s) failed\n`);
      return 0;
    }
    case 'create': {
      const f = parseFlags(argv, [], ['p', 'starter'], { p: 'starter' });
      const name = f.args[0];
      if (!name) throw new Usage('Error: "helm create" requires 1 argument\n\nUsage:  helm create NAME [flags]');
      const base = name.split('/').pop()!;
      if (!/^[a-zA-Z0-9._-]+$/.test(base)) throw new HelmError(`chart name must match the regular expression "^[a-zA-Z0-9._-]+$"`);
      const dir = resolvePath(ctx.state.cwd, name);
      ctx.out(`Creating ${name}\n`);
      for (const [rel, content] of Object.entries(scaffold(base))) {
        const abs = joinPath(dir, rel);
        const parent = abs.replace(/\/[^/]+$/, '');
        if (!ctx.vfs.exists(parent)) ctx.vfs.mkdir(parent, { parents: true });
        ctx.vfs.writeFile(abs, content);
      }
      if (!ctx.vfs.exists(joinPath(dir, 'charts'))) ctx.vfs.mkdir(joinPath(dir, 'charts'), { parents: true });
      return 0;
    }
    case 'repo': {
      const [what, ...rest] = argv;
      const f = parseFlags(rest, ['force-update', 'no-headers'], ['o', 'output', 'username', 'password'], { o: 'output' });
      const list = repos(ctx);
      switch (what) {
        case 'add': {
          const [name, url] = f.args;
          if (!name || !url) throw new Usage('Error: "helm repo add" requires 2 arguments\n\nUsage:  helm repo add [NAME] [URL] [flags]');
          if (list[name] === url.replace(/\/$/, '') || list[name] === url) {
            ctx.out(`"${name}" already exists with the same configuration, skipping\n`);
            return 0;
          }
          if (list[name] && !f.flags['force-update']) throw new HelmError(`repository name (${name}) already exists, please specify a different name`);
          if (!repoKey(url)) {
            const host = /^[a-z]+:\/\/([^/]+)/.exec(url)?.[1] ?? url;
            throw new HelmError(`looks like "${url}" is not a valid chart repository or cannot be reached: Get "${url.replace(/\/$/, '')}/index.yaml": dial tcp: lookup ${host}: no such host`);
          }
          saveRepos(ctx, { ...list, [name]: url.replace(/\/$/, '') });
          ctx.out(`"${name}" has been added to your repositories\n`);
          return 0;
        }
        case 'list':
        case 'ls':
          if (!Object.keys(list).length) throw new HelmError('no repositories to show');
          ctx.out(uitable([['NAME', 'URL'], ...Object.entries(list)]));
          return 0;
        case 'update':
        case 'up':
          if (!Object.keys(list).length) throw new HelmError('no repositories found. You must add one before updating');
          ctx.out(`Hang tight while we grab the latest from your chart repositories...\n${Object.keys(list).map((n) => `...Successfully got an update from the "${n}" chart repository\n`).join('')}Update Complete. ⎈Happy Helming!⎈\n`);
          return 0;
        case 'remove':
        case 'rm': {
          for (const n of f.args) {
            if (!list[n]) throw new HelmError(`no repo named "${n}" found`);
            delete list[n];
            ctx.out(`"${n}" has been removed from your repositories\n`);
          }
          saveRepos(ctx, list);
          return 0;
        }
      }
      throw new Usage(`Error: unknown command "${what ?? ''}" for "helm repo"\nAvailable Commands: add, index, list, remove, update`);
    }
    case 'search': {
      const [where, ...rest] = argv;
      if (where === 'hub') throw new HelmError('devquest is offline: search the Artifact Hub in a browser, or use `helm search repo` after `helm repo add`');
      if (where !== 'repo') throw new Usage(`Error: unknown command "${where ?? ''}" for "helm search"\nAvailable Commands: hub, repo`);
      const f = parseFlags(rest, ['l', 'versions', 'r', 'regexp'], ['version', 'o', 'output'], { l: 'versions', r: 'regexp', o: 'output' });
      const list = repos(ctx);
      if (!Object.keys(list).length) throw new HelmError('no repositories configured');
      const kw = (f.args[0] ?? '').toLowerCase();
      const rows: string[][] = [];
      for (const [name, url] of Object.entries(list)) {
        const key = repoKey(url);
        const seen = new Set<string>();
        for (const c of REPO_CHARTS[key ?? ''] ?? []) {
          if (!f.flags.versions && seen.has(c.name)) continue;
          seen.add(c.name);
          const full = `${name}/${c.name}`;
          if (kw && !full.toLowerCase().includes(kw) && !c.description.toLowerCase().includes(kw)) continue;
          rows.push([full, c.version, c.appVersion, c.description.length > 50 ? c.description.slice(0, 47) + '...' : c.description]);
        }
      }
      if (!rows.length) {
        ctx.out('No results found\n');
        return 0;
      }
      ctx.out(uitable([['NAME', 'CHART VERSION', 'APP VERSION', 'DESCRIPTION'], ...rows]));
      return 0;
    }
    case 'show':
    case 'inspect': {
      const [what, ...rest] = argv;
      const f = parseFlags(rest, [], ['version', 'jsonpath']);
      const h = ctxFor(ctx, f);
      if (!['values', 'chart', 'readme', 'all', 'crds'].includes(what ?? '')) throw new Usage(`Error: unknown command "${what ?? ''}" for "helm show"\nAvailable Commands: all, chart, crds, readme, values`);
      if (!f.args[0]) throw new Usage(`Error: "helm show ${what}" requires 1 argument\n\nUsage:  helm show ${what} [CHART] [flags]`);
      const chart = loadChart(h, f.args[0], f.flags.version as string | undefined, 'show');
      if (what === 'values') ctx.out(chart.files['values.yaml'] ?? '');
      else if (what === 'chart') ctx.out(chart.files['Chart.yaml'] ?? '');
      else if (what === 'readme') ctx.out(chart.files['README.md'] ?? '');
      else if (what === 'crds') ctx.out('');
      else ctx.out(`${chart.files['Chart.yaml'] ?? ''}---\n${chart.files['values.yaml'] ?? ''}`);
      return 0;
    }
    case 'pull':
    case 'fetch': {
      const f = parseFlags(argv, ['untar'], ['version', 'd', 'destination', 'untardir'], { d: 'destination' });
      const h = ctxFor(ctx, f);
      const ref = f.args[0];
      if (!ref) throw new Usage('Error: "helm pull" requires at least 1 argument\n\nUsage:  helm pull [chart URL | repo/chartname] [...] [flags]');
      if (!ref.includes('/')) throw new HelmError(`non-absolute URLs should be in form of repo_name/path_to_chart, got: ${ref}`);
      const chart = loadChart(h, ref, f.flags.version as string | undefined, 'pull');
      if (!f.flags.untar) {
        ctx.note(`devquest: chart archives (${chart.meta.name}-${chart.meta.version}.tgz) aren't simulated; use \`helm pull ${ref} --untar\` to get the chart directory.\n`);
        return 0;
      }
      const dir = resolvePath(ctx.state.cwd, joinPath((f.flags.destination as string) ?? '.', (f.flags.untardir as string) ?? chart.meta.name));
      if (ctx.vfs.exists(dir)) throw new HelmError(`failed to untar: a file or directory with the name ${dir} already exists`);
      for (const [rel, content] of Object.entries(chart.files)) {
        const abs = joinPath(dir, rel);
        const parent = abs.replace(/\/[^/]+$/, '');
        if (!ctx.vfs.exists(parent)) ctx.vfs.mkdir(parent, { parents: true });
        ctx.vfs.writeFile(abs, content);
      }
      return 0;
    }
  }
  if (NOT_SIMULATED.has(sub)) {
    ctx.err(`devquest: 'helm ${sub}' is real, but not simulated here\n`);
    return 1;
  }
  ctx.err(`Error: unknown command "${sub}" for "helm"\nRun 'helm --help' for usage.\n`);
  return 1;
}

export const helmCommands = [helm];
