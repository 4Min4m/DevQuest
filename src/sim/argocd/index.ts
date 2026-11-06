/** The `argocd` CLI (v2.13, core mode: it talks to the cluster directly, like `argocd login --core`). */
import { parse as parseYaml } from 'yaml';
import type { CommandContext, CommandDef } from '../shell/types';
import { getObj, iso, listObjs, putObj } from '../kube/cluster';
import { advance, settle } from '../kube/controllers';
import { argoCache, argoInstalled, refreshApp, renderApp, syncApp, TRACKING_LABEL } from '../kube/argocd';
import { kctx } from '../kube/cli/common';
import { admit, AdmissionError } from '../kube/manifest';
import { kyaml } from '../kube/printers';
import type { J, KObj, KubeState } from '../kube/types';

class ArgoError extends Error {}

const FATA = (msg: string) => new ArgoError(`{"level":"fatal","msg":"${msg.replace(/"/g, '\\"')}","time":"2026-11-03T09:00:00Z"}`);

interface Parsed {
  flags: Record<string, string | true>;
  multi: Record<string, string[]>;
  args: string[];
}

function parse(argv: string[], bool: string[], value: string[], alias: Record<string, string> = {}): Parsed {
  const out: Parsed = { flags: {}, multi: {}, args: [] };
  const vals = new Set(['app-namespace', ...value]);
  const al: Record<string, string> = { N: 'app-namespace', ...alias };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a) ?? (/^-([A-Za-z])$/.exec(a) ? [a, a[1]] : null);
    if (m) {
      const name = al[m[1]] ?? m[1];
      if (vals.has(name)) {
        const v = m[2] ?? argv[++i];
        if (v === undefined) throw new ArgoError(`Error: flag needs an argument: ${a}`);
        out.flags[name] = v;
        (out.multi[name] ??= []).push(v);
      } else if (bool.includes(name)) out.flags[name] = m[2] === 'false' ? 'false' : true;
      else throw new ArgoError(`Error: unknown flag: ${a}`);
      continue;
    }
    out.args.push(a);
  }
  return out;
}

const short = (sha?: string) => (sha ? sha.slice(0, 7) : '');

function cluster(ctx: CommandContext): KubeState {
  const ks = kctx(ctx).ks;
  if (!argoInstalled(ks)) throw FATA('the server could not find the requested resource (get applications.argoproj.io)');
  return ks;
}

function appRef(ks: KubeState, ref: string | undefined, p: Parsed): KObj {
  if (!ref) throw new ArgoError('Error: requires at least 1 arg(s), only received 0');
  const [ns, name] = ref.includes('/') ? ref.split('/') : [(p.flags['app-namespace'] as string | undefined) ?? 'argocd', ref];
  const app = getObj(ks, 'Application', ns, name);
  if (!app) throw FATA(`rpc error: code = NotFound desc = applications.argoproj.io "${name}" not found`);
  return app;
}

function policyText(app: KObj): string {
  const a = app.spec.syncPolicy?.automated;
  if (!a) return 'Manual';
  const extras = [a.prune ? 'Prune' : '', a.selfHeal ? 'SelfHeal' : ''].filter(Boolean);
  return `Automated${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

function table(rows: string[][]): string {
  const w: number[] = [];
  for (const r of rows) r.forEach((c, i) => (w[i] = Math.max(w[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ').trimEnd() + '\n').join('');
}

function summary(app: KObj): string {
  const st = app.status ?? {};
  const src = app.spec.source ?? {};
  const rev = st.sync?.revision;
  let out =
    `Name:               ${app.metadata.namespace}/${app.metadata.name}\n` +
    `Project:            ${app.spec.project}\n` +
    `Server:             ${app.spec.destination?.server ?? app.spec.destination?.name ?? ''}\n` +
    `Namespace:          ${app.spec.destination?.namespace ?? ''}\n` +
    `URL:                https://argocd.example.com/applications/${app.metadata.name}\n` +
    `Source:\n- Repo:             ${src.repoURL ?? ''}\n  Target:           ${src.targetRevision ?? 'HEAD'}\n` +
    (src.chart ? `  Chart:            ${src.chart}\n` : `  Path:             ${src.path ?? ''}\n`) +
    (src.helm?.valueFiles?.length ? `  Helm Values:      ${src.helm.valueFiles.join(',')}\n` : '') +
    `SyncWindow:         Sync Allowed\n` +
    `Sync Policy:        ${policyText(app)}\n` +
    `Sync Status:        ${st.sync?.status ?? 'Unknown'}${rev ? ` to ${src.targetRevision ?? 'HEAD'} (${short(rev)})` : ''}\n` +
    `Health Status:      ${st.health?.status ?? 'Unknown'}\n`;
  if (st.conditions?.length) {
    out += '\n' + table([['CONDITION', 'MESSAGE', 'LAST TRANSITION'], ...st.conditions.map((c: J) => [c.type, c.message, c.lastTransitionTime ?? ''])]);
  }
  return out;
}

function resourceTable(app: KObj, messages: Record<string, string> = {}): string {
  const rows = [['GROUP', 'KIND', 'NAMESPACE', 'NAME', 'STATUS', 'HEALTH', 'HOOK', 'MESSAGE']];
  for (const r of app.status?.resources ?? []) {
    rows.push([r.group ?? '', r.kind, r.namespace ?? '', r.name, r.status + (r.requiresPruning ? '' : ''), r.health?.status ?? '', '', messages[`${r.kind}/${r.name}`] ?? (r.requiresPruning ? 'ignored (requires pruning)' : '')]);
  }
  return rows.length > 1 ? '\n' + table(rows) : '';
}

function setFromFlags(app: KObj, p: Parsed): void {
  const spec = app.spec;
  spec.source ??= {};
  if (p.flags.repo) spec.source.repoURL = p.flags.repo;
  if (p.flags.path) spec.source.path = p.flags.path;
  if (p.flags.revision) spec.source.targetRevision = p.flags.revision;
  if (p.flags['helm-chart']) spec.source.chart = p.flags['helm-chart'];
  if (p.flags['dest-server']) spec.destination = { ...(spec.destination ?? {}), server: p.flags['dest-server'] };
  if (p.flags['dest-name']) spec.destination = { ...(spec.destination ?? {}), name: p.flags['dest-name'] };
  if (p.flags['dest-namespace']) spec.destination = { ...(spec.destination ?? {}), namespace: p.flags['dest-namespace'] };
  if (p.flags.project) spec.project = p.flags.project;
  if (p.multi.values) spec.source.helm = { ...(spec.source.helm ?? {}), valueFiles: p.multi.values };
  if (p.multi['helm-set'] || p.multi.parameter) {
    const params = [...(spec.source.helm?.parameters ?? [])];
    for (const kv of [...(p.multi['helm-set'] ?? []), ...(p.multi.parameter ?? [])]) {
      const eq = kv.indexOf('=');
      const name = kv.slice(0, eq);
      const i = params.findIndex((x: J) => x.name === name);
      if (i >= 0) params[i] = { name, value: kv.slice(eq + 1) };
      else params.push({ name, value: kv.slice(eq + 1) });
    }
    spec.source.helm = { ...(spec.source.helm ?? {}), parameters: params };
  }
  if (p.flags['sync-policy'] !== undefined) {
    const v = String(p.flags['sync-policy']);
    if (/^(automated|automatic|auto)$/.test(v)) spec.syncPolicy = { ...(spec.syncPolicy ?? {}), automated: { ...(spec.syncPolicy?.automated ?? {}) } };
    else if (/^(none|manual)$/.test(v)) {
      if (spec.syncPolicy) delete spec.syncPolicy.automated;
    } else throw new ArgoError(`Error: invalid sync policy: ${v}`);
  }
  for (const [flag, key] of [['auto-prune', 'prune'], ['self-heal', 'selfHeal']] as const) {
    if (p.flags[flag] === undefined) continue;
    if (!spec.syncPolicy?.automated) throw FATA(`Cannot set --${flag}: application not configured with automatic sync`);
    spec.syncPolicy.automated[key] = p.flags[flag] !== 'false';
  }
  for (const opt of p.multi['sync-option'] ?? []) {
    const opts: string[] = spec.syncPolicy?.syncOptions ?? [];
    spec.syncPolicy = { ...(spec.syncPolicy ?? {}), syncOptions: [...opts.filter((o) => o.split('=')[0] !== opt.split('=')[0]), opt] };
  }
}

const APP_FLAGS_BOOL = ['auto-prune', 'self-heal', 'upsert', 'directory-recurse', 'validate', 'yes', 'y', 'cascade'];
const APP_FLAGS_VALUE = ['repo', 'path', 'revision', 'dest-server', 'dest-name', 'dest-namespace', 'project', 'sync-policy', 'sync-option', 'values', 'helm-set', 'parameter', 'helm-chart', 'file', 'o', 'output', 'label', 'l'];

function waitOutput(ctx: CommandContext, ks: KubeState, app: KObj, seconds: number, want: { health?: boolean; sync?: boolean }): boolean {
  for (let t = 0; t < seconds; t += 5) {
    const cur = getObj(ks, 'Application', app.metadata.namespace, app.metadata.name);
    const okH = !want.health || cur?.status?.health?.status === 'Healthy';
    const okS = !want.sync || cur?.status?.sync?.status === 'Synced';
    if (cur && okH && okS) return true;
    advance(ctx.state, 5000);
  }
  return false;
}

function appCmd(ctx: CommandContext, argv: string[]): number {
  const [sub, ...rest] = argv;
  const ks = cluster(ctx);
  const now = ctx.state.clock;
  switch (sub) {
    case 'list':
    case 'ls': {
      const p = parse(rest, [], ['o', 'output', 'project', 'p', 'selector', 'l', 'repo', 'r']);
      const apps = listObjs(ks, 'Application');
      if (p.flags.o === 'name' || p.flags.output === 'name') {
        ctx.out(apps.map((a) => `${a.metadata.namespace}/${a.metadata.name}\n`).join(''));
        return 0;
      }
      ctx.out(
        table([
          ['NAME', 'CLUSTER', 'NAMESPACE', 'PROJECT', 'STATUS', 'HEALTH', 'SYNCPOLICY', 'CONDITIONS', 'REPO', 'PATH', 'TARGET'],
          ...apps.map((a) => [
            `${a.metadata.namespace}/${a.metadata.name}`,
            a.spec.destination?.server ?? a.spec.destination?.name ?? '',
            a.spec.destination?.namespace ?? '',
            a.spec.project,
            a.status?.sync?.status ?? 'Unknown',
            a.status?.health?.status ?? 'Unknown',
            a.spec.syncPolicy?.automated ? (a.spec.syncPolicy.automated.prune ? 'Auto-Prune' : 'Auto') : 'Manual',
            a.status?.conditions?.map((c: J) => c.type).join(',') || '<none>',
            a.spec.source?.repoURL ?? '',
            a.spec.source?.path ?? '',
            a.spec.source?.targetRevision ?? 'HEAD',
          ]),
        ]),
      );
      return 0;
    }
    case 'get': {
      const p = parse(rest, ['refresh', 'hard-refresh', 'show-params', 'show-operation'], ['o', 'output']);
      const app = appRef(ks, p.args[0], p);
      if (p.flags.refresh || p.flags['hard-refresh']) refreshApp(ctx.state, ks, app, now);
      const o = p.flags.o ?? p.flags.output;
      if (o === 'yaml' || o === 'json') {
        ctx.out(o === 'yaml' ? kyaml(app) : JSON.stringify(app, null, 2) + '\n');
        return 0;
      }
      ctx.out(summary(app) + resourceTable(app));
      return 0;
    }
    case 'create': {
      const p = parse(rest, APP_FLAGS_BOOL, APP_FLAGS_VALUE, { f: 'file', p: 'parameter' });
      let app: KObj;
      if (p.flags.file) {
        let doc: J;
        try {
          doc = admitDoc(ctx, p.flags.file as string);
        } catch (e) {
          throw new ArgoError((e as Error).message);
        }
        app = doc;
      } else {
        const name = p.args[0];
        if (!name) throw new ArgoError('Error: app name or file is required');
        app = { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name, namespace: (p.flags['app-namespace'] as string | undefined) ?? 'argocd', uid: '', creationTimestamp: '', resourceVersion: '' }, spec: { project: 'default', source: { targetRevision: 'HEAD' }, destination: {} } };
        setFromFlags(app, p);
        if (!app.spec.source.repoURL) throw FATA('application spec for ' + name + ' is invalid: InvalidSpecError: spec.source.repoURL and either source.path, source.chart, or source.ref are required for source');
        if (!app.spec.destination.server && !app.spec.destination.name) throw FATA(`application spec for ${name} is invalid: InvalidSpecError: Destination server missing from app spec`);
      }
      const name = app.metadata.name;
      const ns = app.metadata.namespace ?? 'argocd';
      // Validate the source like argocd-server does.
      const probe = renderApp(ctx.state, app, now);
      if (probe.error && /repository not found|app path does not exist|unable to resolve/.test(probe.error)) {
        throw FATA(`rpc error: code = InvalidArgument desc = application spec for ${name} is invalid: InvalidSpecError: Unable to generate manifests in ${app.spec.source?.path ?? ''}: ${probe.error.replace(/^Failed to load target state: failed to generate manifest for source 1 of 1: /, '')}`);
      }
      const existing = getObj(ks, 'Application', ns, name);
      if (existing && JSON.stringify(existing.spec) !== JSON.stringify(app.spec) && !p.flags.upsert) throw FATA('rpc error: code = InvalidArgument desc = existing application spec is different, use upsert flag to force update');
      try {
        const r = admit(ks, { apiVersion: app.apiVersion, kind: 'Application', metadata: { name, namespace: ns, ...(app.metadata.finalizers ? { finalizers: app.metadata.finalizers } : {}) }, spec: app.spec }, now, { source: 'argocd', mode: 'apply' });
        if (r.action === 'created') putObj(ks, r.obj);
      } catch (e) {
        if (e instanceof AdmissionError) throw FATA(e.message);
        throw e;
      }
      ctx.out(`application '${name}' ${existing ? 'updated' : 'created'}\n`);
      return 0;
    }
    case 'set': {
      const p = parse(rest, APP_FLAGS_BOOL, APP_FLAGS_VALUE, { p: 'parameter' });
      const app = appRef(ks, p.args[0], p);
      setFromFlags(app, p);
      argoCache(ks, app).specKey = '';
      return 0;
    }
    case 'sync': {
      const p = parse(rest, ['prune', 'dry-run', 'force', 'async', 'apply-out-of-sync-only', 'replace', 'preview-changes', 'assumeYes'], ['revision', 'timeout', 'resource', 'label', 'l', 'retry-limit']);
      const app = appRef(ks, p.args[0], p);
      if (app.status?.operationState?.phase === 'Running') throw FATA('rpc error: code = FailedPrecondition desc = another operation is already in progress');
      const before = JSON.parse(JSON.stringify(app.status?.resources ?? []));
      refreshApp(ctx.state, ks, app, now);
      const res = syncApp(ctx.state, ks, app, now, { prune: !!p.flags.prune || !!app.spec.syncPolicy?.automated?.prune, revision: p.flags.revision as string | undefined, initiatedBy: 'admin' });
      const t = iso(now).replace('Z', '+00:00');
      ctx.out(table([['TIMESTAMP', 'GROUP', 'KIND', 'NAMESPACE', 'NAME', 'STATUS', 'HEALTH', 'HOOK', 'MESSAGE'], ...before.map((r: J) => [t, r.group ?? '', r.kind, r.namespace ?? '', r.name, r.status, r.health?.status ?? '', '', ''])]));
      if (!p.flags.async) advance(ctx.state, 2000);
      const cur = getObj(ks, 'Application', app.metadata.namespace, app.metadata.name)!;
      refreshApp(ctx.state, ks, cur, ctx.state.clock);
      const op = cur.status?.operationState ?? {};
      const messages = Object.fromEntries(res.results.map((r) => [`${r.kind}/${r.name}`, r.message]));
      ctx.out(`\n${summary(cur)}\nOperation:          Sync\nSync Revision:      ${op.syncResult?.revision ?? ''}\nPhase:              ${op.phase ?? ''}\nStart:              ${now ? iso(now).replace('T', ' ').replace('Z', ' +0000 UTC') : ''}\nFinished:           ${iso(now + 1000).replace('T', ' ').replace('Z', ' +0000 UTC')}\nDuration:           1s\nMessage:            ${op.message ?? ''}\n${resourceTable(cur, messages)}`);
      if (!res.ok) throw FATA(`Operation has completed with phase: Failed`);
      return 0;
    }
    case 'wait': {
      const p = parse(rest, ['health', 'sync', 'operation', 'suspended', 'degraded'], ['timeout']);
      const app = appRef(ks, p.args[0], p);
      const secs = Number(p.flags.timeout ?? 300);
      const want = { health: !!p.flags.health || (!p.flags.sync && !p.flags.health), sync: !!p.flags.sync || (!p.flags.sync && !p.flags.health) };
      const ok = waitOutput(ctx, ks, app, secs, want);
      const cur = getObj(ks, 'Application', app.metadata.namespace, app.metadata.name)!;
      ctx.out(table([['TIMESTAMP', 'GROUP', 'KIND', 'NAMESPACE', 'NAME', 'STATUS', 'HEALTH', 'HOOK', 'MESSAGE'], ...(cur.status?.resources ?? []).map((r: J) => [iso(ctx.state.clock).replace('Z', '+00:00'), r.group ?? '', r.kind, r.namespace ?? '', r.name, r.status, r.health?.status ?? '', '', ''])]) + '\n' + summary(cur) + resourceTable(cur));
      if (!ok) throw FATA(`timed out (${secs}s) waiting for app "${app.metadata.name}" match desired state`);
      return 0;
    }
    case 'diff': {
      const p = parse(rest, ['refresh', 'hard-refresh', 'local-include'], ['revision', 'local']);
      const app = appRef(ks, p.args[0], p);
      const desired = renderApp(ctx.state, app, now);
      if (desired.error) throw FATA(desired.error);
      let out = '';
      const destNs = app.spec.destination?.namespace;
      for (const d of desired.docs) {
        const ns = d.metadata?.namespace ?? destNs;
        const live = getObj(ks, String(d.kind), ns, String(d.metadata?.name));
        const want = kyaml({ ...d, metadata: { ...d.metadata, labels: { ...(d.metadata?.labels ?? {}), [TRACKING_LABEL]: app.metadata.name } } }).split('\n');
        const r = (app.status?.resources ?? []).find((x: J) => x.kind === d.kind && x.name === d.metadata?.name);
        if (live && r?.status === 'Synced') continue;
        out += `\n===== ${groupOf(String(d.kind))}/${d.kind} ${ns ?? ''}/${d.metadata?.name} ======\n`;
        if (!live) {
          out += want.filter(Boolean).map((l) => `> ${l}`).join('\n') + '\n';
          continue;
        }
        const have = kyaml(pick(liveClean(live), d)).split('\n');
        const wantPicked = kyaml(pick({ ...d, metadata: { name: d.metadata?.name, labels: { ...(d.metadata?.labels ?? {}), [TRACKING_LABEL]: app.metadata.name } } }, d)).split('\n');
        out += lineDiff(have, wantPicked);
      }
      for (const r of app.status?.resources ?? []) {
        if (r.requiresPruning) out += `\n===== ${r.group}/${r.kind} ${r.namespace ?? ''}/${r.name} ======\n< (live object; not in Git — requires pruning)\n`;
      }
      ctx.out(out);
      return out ? 1 : 0;
    }
    case 'history': {
      const p = parse(rest, [], ['o', 'output']);
      const app = appRef(ks, p.args[0], p);
      const h: J[] = app.status?.history ?? [];
      ctx.out(table([['SOURCE', app.spec.source?.repoURL ?? ''], ['ID', 'DATE', 'REVISION'], ...h.map((x) => [String(x.id), x.deployedAt.replace('T', ' ').replace('Z', ' +0000 UTC'), `${x.source?.targetRevision ?? 'HEAD'} (${short(x.revision)})`])]).replace(/^SOURCE {2}/, 'SOURCE  '));
      return 0;
    }
    case 'rollback': {
      const p = parse(rest, ['prune', 'dry-run'], ['timeout']);
      const app = appRef(ks, p.args[0], p);
      if (app.spec.syncPolicy?.automated) throw FATA('rpc error: code = FailedPrecondition desc = rollback cannot be initiated when auto-sync is enabled');
      const h: J[] = app.status?.history ?? [];
      const want = p.args[1] !== undefined ? h.find((x) => String(x.id) === p.args[1]) : h[h.length - 2];
      if (!want) throw FATA(`rpc error: code = InvalidArgument desc = application ${app.metadata.name} does not have deployment with id ${p.args[1] ?? ''}`);
      const res = syncApp(ctx.state, ks, app, now, { prune: !!p.flags.prune, revision: want.revision, initiatedBy: 'admin' });
      advance(ctx.state, 2000);
      const cur = getObj(ks, 'Application', app.metadata.namespace, app.metadata.name)!;
      ctx.out(`${summary(cur)}\nOperation:          Sync\nSync Revision:      ${want.revision}\nPhase:              ${res.ok ? 'Succeeded' : 'Failed'}\nMessage:            ${res.message}\n${resourceTable(cur)}`);
      return res.ok ? 0 : 1;
    }
    case 'delete': {
      const p = parse(rest, ['yes', 'y', 'cascade'], ['propagation-policy']);
      const app = appRef(ks, p.args[0], p);
      if (!p.flags.yes && !p.flags.y) throw new ArgoError(`devquest: argocd asks "Are you sure you want to delete '${app.metadata.name}' and all its resources? [y/n]" — confirm with --yes`);
      if (p.flags.cascade !== 'false') app.metadata.finalizers = ['resources-finalizer.argocd.argoproj.io'];
      app.metadata.deletionTimestamp = iso(now);
      advance(ctx.state, 2000);
      return 0;
    }
    case 'manifests': {
      const p = parse(rest, [], ['source', 'revision']);
      const app = appRef(ks, p.args[0], p);
      const desired = renderApp(ctx.state, app, now);
      if (desired.error) throw FATA(desired.error);
      ctx.out(desired.docs.map((d) => '---\n' + kyaml(d)).join(''));
      return 0;
    }
    case 'terminate-op':
    case 'resources':
    case 'logs':
    case 'patch':
    case 'unset':
    case 'edit':
      throw new ArgoError(`devquest: 'argocd app ${sub}' is real, but not simulated here`);
  }
  throw new ArgoError(`Error: unknown command "${sub ?? ''}" for "argocd app"`);
}

function admitDoc(ctx: CommandContext, path: string): J {
  return parseYaml(ctx.vfs.readFile(ctx.resolve(path)));
}

const groupOf = (kind: string) => ({ Deployment: 'apps', StatefulSet: 'apps', DaemonSet: 'apps', Ingress: 'networking.k8s.io', Job: 'batch', CronJob: 'batch' })[kind] ?? '';

function liveClean(o: KObj): J {
  const { status: _s, ...rest } = JSON.parse(JSON.stringify(o));
  void _s;
  return rest;
}

/** The live object reduced to the fields the desired manifest sets (what `argocd app diff` compares). */
function pick(live: J, shape: J): J {
  if (Array.isArray(shape)) return Array.isArray(live) ? shape.map((s, i) => pick(live[i], s)) : live;
  if (shape && typeof shape === 'object') {
    if (!live || typeof live !== 'object') return live;
    const out: J = {};
    for (const k of Object.keys(shape)) if (k in live) out[k] = k === 'metadata' ? { name: live.metadata?.name, labels: live.metadata?.labels } : pick(live[k], shape[k]);
    return out;
  }
  return live;
}

function lineDiff(a: string[], b: string[]): string {
  let out = '';
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined && a[i] !== '') out += `${i + 1}c${i + 1}\n< ${a[i]}\n---\n> ${b[i] ?? ''}\n`;
    else if (b[i]) out += `${i}a${i + 1}\n> ${b[i]}\n`;
  }
  return out;
}

export const argocd: CommandDef = {
  name: 'argocd',
  summary: 'Argo CD CLI (simulated: app list/get/create/set/sync/wait/diff/history/rollback/delete)',
  run(ctx) {
    const [sub, ...rest] = ctx.args;
    try {
      switch (sub) {
        case undefined:
        case 'help':
        case '--help':
          ctx.out('argocd controls a Argo CD server\n\nUsage:\n  argocd [flags]\n  argocd [command]\n\nAvailable Commands (simulated):\n  app         Manage applications\n  login       Log in to Argo CD\n  version     Print version information\n');
          return 0;
        case 'version':
          ctx.out('argocd: v2.13.1+af54ef8\n  BuildDate: 2024-11-20T17:00:00Z\n  GitCommit: af54ef8db5adfa77a08d4d05b1e3f2a2a20d8e48\n  GitTreeState: clean\n  GoVersion: go1.22.9\n  Compiler: gc\n  Platform: linux/amd64\n');
          return 0;
        case 'login':
          if (rest.includes('--core')) {
            ctx.out("Context 'kubernetes' updated\n");
            return 0;
          }
          ctx.out("'admin:login' logged in successfully\nContext 'argocd-server' updated\n");
          return 0;
        case 'app':
        case 'apps':
        case 'application':
          return appCmd(ctx, rest);
        case 'repo':
        case 'cluster':
        case 'proj':
        case 'account':
        case 'appset':
          throw new ArgoError(`devquest: 'argocd ${sub}' is real, but not simulated here (simulated: app, login, version)`);
      }
      throw new ArgoError(`Error: unknown command "${sub}" for "argocd"`);
    } catch (e) {
      if (e instanceof ArgoError) {
        ctx.err(e.message + '\n');
        return 20;
      }
      throw e;
    } finally {
      if (ctx.state.kube) settle(ctx.state);
    }
  },
};

export const argoCommands = [argocd];
