/**
 * Argo CD inside the cluster: Applications watch a Git repo (plain YAML or a Helm chart), the
 * controller compares desired vs live state (Synced / OutOfSync, health), and syncs on demand or
 * automatically (prune, selfHeal). Plus the install manifests and Argo's health rules.
 */
import { parseAllDocuments, parse as parseYaml } from 'yaml';
import { applySet, chartFromFiles, coalesce, render, repoChart } from '../helm/chart';
import { KNOWN_REPOS } from '../helm/repo';
import { commitTree, resolveRev } from '../git/repo';
import { blobText } from '../git/ops';
import type { Repo } from '../git/types';
import type { SimState } from '../state';
import { getObj, infoOf, iso, listObjs, putObj, removeObj, resourceFor } from './cluster';
import { admit, AdmissionError } from './manifest';
import { clean } from './printers';
import type { J, KObj, KubeState } from './types';

export const ARGO_IMAGE = 'quay.io/argoproj/argocd:v2.13.1';
export const TRACKING_LABEL = 'app.kubernetes.io/instance';
const POLL_MS = 180_000;
const COMPARE_MS = 5_000;

// ------------------------------------------------------------------ install

const deployment = (name: string, image: string, port: number) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: argocd
  labels:
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/part-of: argocd
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${name}
    spec:
      containers:
      - name: ${name.replace(/^argocd-/, '')}
        image: ${image}
        ports:
        - containerPort: ${port}
`;

const service = (name: string, port: number, target: number) => `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: argocd
spec:
  selector:
    app.kubernetes.io/name: ${name}
  ports:
  - name: http
    port: ${port}
    targetPort: ${target}
`;

const INSTALL = [
  'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: argocd\n',
  deployment('argocd-server', ARGO_IMAGE, 8080),
  deployment('argocd-repo-server', ARGO_IMAGE, 8081),
  deployment('argocd-redis', 'public.ecr.aws/docker/library/redis:7.0.15-alpine', 6379),
  deployment('argocd-dex-server', 'ghcr.io/dexidp/dex:v2.41.1', 5556),
  deployment('argocd-applicationset-controller', ARGO_IMAGE, 7000),
  deployment('argocd-notifications-controller', ARGO_IMAGE, 9001),
  `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: argocd-application-controller
  namespace: argocd
  labels:
    app.kubernetes.io/name: argocd-application-controller
    app.kubernetes.io/part-of: argocd
spec:
  serviceName: argocd-application-controller
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: argocd-application-controller
  template:
    metadata:
      labels:
        app.kubernetes.io/name: argocd-application-controller
    spec:
      containers:
      - name: application-controller
        image: ${ARGO_IMAGE}
        ports:
        - containerPort: 8082
`,
  service('argocd-server', 80, 8080),
  service('argocd-repo-server', 8081, 8081),
  service('argocd-redis', 6379, 6379),
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: argocd-initial-admin-secret\n  namespace: argocd\ntype: Opaque\ndata:\n  password: ' + btoa('tW8x3QpZr1eKvB2m') + '\n',
  'apiVersion: argoproj.io/v1alpha1\nkind: AppProject\nmetadata:\n  name: default\n  namespace: argocd\nspec:\n  sourceRepos: ["*"]\n  destinations:\n  - namespace: "*"\n    server: "*"\n  clusterResourceWhitelist:\n  - group: "*"\n    kind: "*"\n',
];

/** Install Argo CD (CRDs, the argocd namespace and its components). */
export function installArgo(ks: KubeState, now: number): void {
  ks.crds = [...new Set([...(ks.crds ?? []), 'applications.argoproj.io', 'appprojects.argoproj.io', 'applicationsets.argoproj.io'])];
  for (const text of INSTALL) {
    const r = admit(ks, parseYaml(text), now, { source: 'install.yaml', mode: 'apply' });
    if (r.action === 'created') putObj(ks, r.obj);
  }
}

export function argoInstalled(ks: KubeState): boolean {
  return (ks.crds ?? []).includes('applications.argoproj.io');
}

function controllerUp(ks: KubeState): boolean {
  return (getObj(ks, 'StatefulSet', 'argocd', 'argocd-application-controller')?.status?.readyReplicas ?? 0) > 0;
}

// ------------------------------------------------------------------ desired state

export interface Desired {
  revision?: string;
  docs: J[];
  error?: string;
  sourceType: 'Directory' | 'Helm';
  fetchedAt: number;
}

function findRemote(host: SimState, url: string): Repo | undefined {
  const remotes = host.git?.remotes ?? {};
  const norm = (u: string) => u.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
  const key = Object.keys(remotes).find((k) => norm(k) === norm(url));
  return key ? remotes[key] : undefined;
}

const genErr = (msg: string) => `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = ${msg}`;

export function renderApp(host: SimState, app: KObj, now: number): Desired {
  const src = app.spec.source ?? app.spec.sources?.[0] ?? {};
  const destNs = app.spec.destination?.namespace;
  const repoURL = String(src.repoURL ?? '');
  // Helm repository source (chart: + targetRevision: version).
  if (src.chart) {
    const known = Object.entries(KNOWN_REPOS).find(([, u]) => u === repoURL.replace(/\/$/, ''));
    if (!known) return { docs: [], error: genErr(`failed to fetch chart: failed to get index: Get "${repoURL}/index.yaml": dial tcp: lookup ${repoURL.replace(/^https?:\/\//, '').split('/')[0]}: no such host`), sourceType: 'Helm', fetchedAt: now };
    const chart = repoChart(known[0], src.chart, src.targetRevision);
    if (!chart) return { docs: [], error: genErr(`chart "${src.chart}" version "${src.targetRevision}" not found in repository ${repoURL}`), sourceType: 'Helm', fetchedAt: now };
    return helmDocs(chart, src, app, destNs, String(src.targetRevision), now);
  }
  const remote = findRemote(host, repoURL);
  if (!remote) return { docs: [], error: genErr('failed to list refs: repository not found: Repository not found.'), sourceType: 'Directory', fetchedAt: now };
  const want = String(src.targetRevision ?? 'HEAD');
  const sha = want === 'HEAD' ? remote.heads['branch' in remote.head ? remote.head.branch : 'main'] : remote.heads[want] ?? remote.tags[want] ?? resolveRev(remote, want) ?? undefined;
  if (!sha) return { docs: [], error: genErr(`unable to resolve '${want}' to a commit SHA`), sourceType: 'Directory', fetchedAt: now };
  const tree = commitTree(remote, sha);
  const base = String(src.path ?? '.').replace(/^\.\/?/, '').replace(/\/$/, '');
  const prefix = base ? `${base}/` : '';
  const files: Record<string, string> = {};
  for (const [p, e] of Object.entries(tree)) if (p.startsWith(prefix)) files[p.slice(prefix.length)] = blobText(remote, e.sha);
  if (!Object.keys(files).length) return { revision: sha, docs: [], error: genErr(`${base || '.'}: app path does not exist`), sourceType: 'Directory', fetchedAt: now };
  if (files['kustomization.yaml'] || files['kustomization.yml']) return { revision: sha, docs: [], error: genErr('devquest: Kustomize sources are not simulated; use a directory of YAML files or a Helm chart'), sourceType: 'Directory', fetchedAt: now };
  if (files['Chart.yaml']) {
    try {
      const chart = chartFromFiles(files);
      return { ...helmDocs(chart, src, app, destNs, sha, now, files), revision: sha };
    } catch (e) {
      return { revision: sha, docs: [], error: genErr((e as Error).message), sourceType: 'Helm', fetchedAt: now };
    }
  }
  const recurse = !!src.directory?.recurse;
  const docs: J[] = [];
  for (const [p, text] of Object.entries(files).sort()) {
    if (!/\.(ya?ml|json)$/.test(p) || (!recurse && p.includes('/'))) continue;
    for (const d of parseAllDocuments(text)) {
      if (d.errors.length) return { revision: sha, docs: [], error: genErr(`Failed to unmarshal "${p}": ${d.errors[0].message.split('\n')[0]}`), sourceType: 'Directory', fetchedAt: now };
      const o = d.toJS();
      if (o && typeof o === 'object' && o.kind) docs.push(o);
    }
  }
  return { revision: sha, docs, sourceType: 'Directory', fetchedAt: now };
}

function helmDocs(chart: ReturnType<typeof chartFromFiles>, src: J, app: KObj, ns: string, revision: string, now: number, files: Record<string, string> = {}): Desired {
  try {
    let values = JSON.parse(JSON.stringify(chart.values));
    for (const f of src.helm?.valueFiles ?? []) {
      const text = files[String(f).replace(/^\.\//, '')];
      if (text === undefined) return { revision, docs: [], error: genErr(`Error: open .argocd-source-${app.metadata.name}.yaml: ${f}: no such file or directory`), sourceType: 'Helm', fetchedAt: now };
      values = coalesce(values, parseYaml(text) ?? {});
    }
    if (src.helm?.values) values = coalesce(values, parseYaml(String(src.helm.values)) ?? {});
    if (src.helm?.valuesObject) values = coalesce(values, src.helm.valuesObject);
    for (const p of src.helm?.parameters ?? []) applySet(values, `${p.name}=${p.value}`, !!p.forceString);
    const r = render(chart, values, { name: src.helm?.releaseName ?? app.metadata.name, namespace: ns, revision: 1, isInstall: true });
    return { revision, docs: r.docs.map((d) => d.obj), sourceType: 'Helm', fetchedAt: now };
  } catch (e) {
    return { revision, docs: [], error: genErr((e as Error).message), sourceType: 'Helm', fetchedAt: now };
  }
}

// ------------------------------------------------------------------ compare

/** Desired fields must match live ones; live may have more (defaults, status). */
function subset(desired: J, live: J): boolean {
  if (desired === null || desired === undefined) return true;
  if (Array.isArray(desired)) return Array.isArray(live) && desired.length === live.length && desired.every((d, i) => subset(d, live[i]));
  if (typeof desired === 'object') return typeof live === 'object' && live !== null && Object.entries(desired).every(([k, v]) => subset(v, live[k]));
  // YAML 8080 vs "8080", true vs "true"
  return String(desired) === String(live);
}

function comparable(o: J): J {
  const { metadata, status: _s, ...rest } = o;
  void _s;
  const ann = { ...(metadata?.annotations ?? {}) };
  delete ann['kubectl.kubernetes.io/last-applied-configuration'];
  return { ...rest, metadata: { labels: metadata?.labels, annotations: Object.keys(ann).length ? ann : undefined } };
}

const nsOf = (o: J, destNs: string) => (resourceFor(o.kind)?.namespaced === false ? undefined : o.metadata?.namespace ?? destNs);

export function liveOf(ks: KubeState, o: J, destNs: string): KObj | undefined {
  const info = resourceFor(String(o.kind ?? ''));
  if (!info) return undefined;
  return getObj(ks, info.kind, nsOf(o, destNs), String(o.metadata?.name ?? ''));
}

const HEALTH_ORDER = ['Healthy', 'Suspended', 'Progressing', 'Missing', 'Degraded', 'Unknown'];

export function healthOf(o: KObj | undefined): string | undefined {
  if (!o) return 'Missing';
  const s = o.status ?? {};
  switch (o.kind) {
    case 'Deployment': {
      if ((s.conditions ?? []).some((c: J) => c.reason === 'ProgressDeadlineExceeded')) return 'Degraded';
      if (o.spec.paused) return 'Suspended';
      const want = o.spec.replicas ?? 1;
      if ((s.observedGeneration ?? 0) < (o.metadata.generation ?? 1) || (s.updatedReplicas ?? 0) < want || (s.availableReplicas ?? 0) < want || (s.replicas ?? 0) > want) return 'Progressing';
      return 'Healthy';
    }
    case 'StatefulSet':
      return (s.readyReplicas ?? 0) < (o.spec.replicas ?? 1) ? 'Progressing' : 'Healthy';
    case 'DaemonSet':
      return (s.numberReady ?? 0) < (s.desiredNumberScheduled ?? 0) ? 'Progressing' : 'Healthy';
    case 'Pod': {
      if (s.phase === 'Failed') return 'Degraded';
      if ((s.containerStatuses ?? []).some((c: J) => /CrashLoopBackOff|ImagePullBackOff|ErrImagePull/.test(c.state?.waiting?.reason ?? ''))) return 'Degraded';
      if (s.phase === 'Running' && (s.conditions ?? []).some((c: J) => c.type === 'Ready' && c.status === 'True')) return 'Healthy';
      if (s.phase === 'Succeeded') return 'Healthy';
      return 'Progressing';
    }
    case 'PersistentVolumeClaim':
      return s.phase === 'Bound' ? 'Healthy' : 'Progressing';
    case 'Service':
      return o.spec.type === 'LoadBalancer' && !(s.loadBalancer?.ingress ?? []).length ? 'Progressing' : 'Healthy';
    case 'Ingress':
      return (s.loadBalancer?.ingress ?? []).length ? 'Healthy' : 'Progressing';
    case 'Job':
      return s.failed && (s.conditions ?? []).some((c: J) => c.type === 'Failed') ? 'Degraded' : s.succeeded ? 'Healthy' : 'Progressing';
    case 'HorizontalPodAutoscaler':
      return 'Healthy';
    case 'Application':
      return o.status?.health?.status ?? 'Unknown';
  }
  return undefined;
}

const groupOf = (kind: string) => {
  const v = infoOf(kind)?.apiVersion ?? 'v1';
  return v.includes('/') ? v.split('/')[0] : '';
};

export interface ResourceStatus {
  group: string;
  version: string;
  kind: string;
  namespace?: string;
  name: string;
  status: 'Synced' | 'OutOfSync';
  health?: { status: string };
  requiresPruning?: boolean;
}

function compare(ks: KubeState, app: KObj, desired: Desired): { resources: ResourceStatus[]; sync: string; health: string } {
  const destNs = app.spec.destination?.namespace;
  const resources: ResourceStatus[] = [];
  const seen = new Set<string>();
  for (const d of desired.docs) {
    const live = liveOf(ks, d, destNs);
    const info = resourceFor(String(d.kind));
    const kind = info?.kind ?? String(d.kind);
    const ns = nsOf(d, destNs);
    seen.add(`${kind}/${ns ?? ''}/${d.metadata?.name}`);
    const inSync = !!live && subset(comparable({ ...d, metadata: { ...d.metadata, labels: { ...(d.metadata?.labels ?? {}), [TRACKING_LABEL]: app.metadata.name } } }), comparable(clean(live)));
    const h = healthOf(live);
    resources.push({ group: groupOf(kind), version: (info?.apiVersion ?? 'v1').split('/').pop()!, kind, namespace: ns, name: String(d.metadata?.name), status: inSync ? 'Synced' : 'OutOfSync', ...(h ? { health: { status: h } } : {}) });
  }
  for (const live of managedObjects(ks, app)) {
    const key = `${live.kind}/${live.metadata.namespace ?? ''}/${live.metadata.name}`;
    if (seen.has(key)) continue;
    resources.push({ group: groupOf(live.kind), version: live.apiVersion.split('/').pop()!, kind: live.kind, namespace: live.metadata.namespace, name: live.metadata.name, status: 'OutOfSync', requiresPruning: true, ...(healthOf(live) ? { health: { status: healthOf(live)! } } : {}) });
  }
  const sync = desired.error ? 'Unknown' : resources.some((r) => r.status === 'OutOfSync') ? 'OutOfSync' : 'Synced';
  let health = 'Healthy';
  for (const r of resources) {
    if (r.requiresPruning) continue;
    const h = r.health?.status;
    if (h && HEALTH_ORDER.indexOf(h) > HEALTH_ORDER.indexOf(health)) health = h;
  }
  return { resources, sync, health };
}

/** Top-level objects carrying this Application's tracking label. */
export function managedObjects(ks: KubeState, app: KObj): KObj[] {
  const out: KObj[] = [];
  for (const kind of Object.keys(ks.objects)) {
    if (['Pod', 'ReplicaSet', 'Endpoints', 'Event', 'ControllerRevision'].includes(kind)) continue;
    for (const o of Object.values(ks.objects[kind])) {
      if (o.metadata.labels?.[TRACKING_LABEL] === app.metadata.name && !o.metadata.ownerReferences?.length && !(o.kind === 'Application' && o.metadata.name === app.metadata.name)) out.push(o);
    }
  }
  return out;
}

// ------------------------------------------------------------------ sync

export interface SyncResult {
  ok: boolean;
  message: string;
  results: { group: string; kind: string; namespace?: string; name: string; status: string; message: string }[];
}

const KIND_ORDER = ['Namespace', 'NetworkPolicy', 'ResourceQuota', 'LimitRange', 'ServiceAccount', 'Secret', 'ConfigMap', 'StorageClass', 'PersistentVolume', 'PersistentVolumeClaim', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding', 'Service', 'DaemonSet', 'Pod', 'ReplicaSet', 'Deployment', 'StatefulSet', 'Job', 'CronJob', 'Ingress'];
const wave = (d: J) => Number(d.metadata?.annotations?.['argocd.argoproj.io/sync-wave'] ?? 0);
const rank = (k: string) => (KIND_ORDER.indexOf(k) < 0 ? KIND_ORDER.length : KIND_ORDER.indexOf(k));

function deleteLive(ks: KubeState, o: KObj, now: number): void {
  if (o.kind === 'Pod') {
    o.metadata.deletionTimestamp ??= iso(now);
    return;
  }
  if (o.kind === 'Service') {
    const ep = getObj(ks, 'Endpoints', o.metadata.namespace, o.metadata.name);
    if (ep) removeObj(ks, ep);
  }
  removeObj(ks, o);
}

export function syncApp(host: SimState, ks: KubeState, app: KObj, now: number, opts: { prune: boolean; revision?: string; desired?: Desired; initiatedBy: string }): SyncResult {
  const desired = opts.desired ?? renderApp(host, opts.revision ? { ...app, spec: { ...app.spec, source: { ...app.spec.source, targetRevision: opts.revision } } } : app, now);
  const destNs = app.spec.destination?.namespace;
  const results: SyncResult['results'] = [];
  const st = (app.status ??= {});
  const fail = (message: string): SyncResult => {
    st.operationState = { operation: { sync: { revision: desired.revision }, initiatedBy: { username: opts.initiatedBy } }, phase: 'Failed', message, startedAt: iso(now), finishedAt: iso(now), syncResult: { revision: desired.revision, resources: results } };
    st.conditions = [{ type: 'SyncError', message, lastTransitionTime: iso(now) }];
    return { ok: false, message, results };
  };
  if (desired.error) return fail(`ComparisonError: ${desired.error}`);
  const createNs = (app.spec.syncPolicy?.syncOptions ?? []).includes('CreateNamespace=true');
  if (destNs && !getObj(ks, 'Namespace', undefined, destNs)) {
    if (!createNs) return fail(`one or more objects failed to apply, reason: namespaces "${destNs}" not found`);
    const r = admit(ks, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: destNs } }, now, { source: 'argocd', mode: 'apply' });
    if (r.action === 'created') putObj(ks, r.obj);
  }
  const docs = [...desired.docs].sort((a, b) => wave(a) - wave(b) || rank(a.kind) - rank(b.kind));
  for (const d of docs) {
    const o = JSON.parse(JSON.stringify(d));
    o.metadata ??= {};
    o.metadata.labels = { ...(o.metadata.labels ?? {}), [TRACKING_LABEL]: app.metadata.name };
    const ns = nsOf(o, destNs);
    if (ns) o.metadata.namespace = ns;
    const kind = resourceFor(String(o.kind))?.kind ?? String(o.kind);
    try {
      const existed = !!liveOf(ks, o, destNs);
      const r = admit(ks, o, now, { source: 'argocd', mode: 'apply', namespace: ns });
      if (r.action === 'created') putObj(ks, r.obj);
      const verb = existed ? (r.action === 'unchanged' ? 'unchanged' : 'configured') : 'created';
      results.push({ group: groupOf(kind), kind, namespace: ns, name: o.metadata.name, status: 'Synced', message: `${resourceFor(kind)?.singular ?? kind.toLowerCase()}${groupOf(kind) ? '.' + groupOf(kind) : ''}/${o.metadata.name} ${verb}` });
    } catch (e) {
      if (!(e instanceof AdmissionError)) throw e;
      results.push({ group: groupOf(kind), kind, namespace: ns, name: o.metadata?.name, status: 'SyncFailed', message: e.message.replace(/^Error from server \(\w+\): /, '').replace(/^error when [^:]+: /, '') });
    }
  }
  const failed = results.filter((r) => r.status === 'SyncFailed');
  if (failed.length) return fail(`one or more objects failed to apply, reason: ${failed[0].message}`);
  if (opts.prune) {
    const keep = new Set(docs.map((d) => `${resourceFor(String(d.kind))?.kind}/${nsOf(d, destNs) ?? ''}/${d.metadata?.name}`));
    for (const live of managedObjects(ks, app)) {
      if (keep.has(`${live.kind}/${live.metadata.namespace ?? ''}/${live.metadata.name}`)) continue;
      deleteLive(ks, live, now);
      results.push({ group: groupOf(live.kind), kind: live.kind, namespace: live.metadata.namespace, name: live.metadata.name, status: 'Pruned', message: 'pruned' });
    }
  }
  const history: J[] = (st.history ??= []);
  const id = history.length ? history[history.length - 1].id + 1 : 0;
  history.push({ id, revision: desired.revision, deployedAt: iso(now), deployStartedAt: iso(now), source: { ...(app.spec.source ?? {}) } });
  while (history.length > 10) history.shift();
  st.operationState = { operation: { sync: { revision: desired.revision, prune: opts.prune }, initiatedBy: opts.initiatedBy === 'automated' ? { automated: true } : { username: opts.initiatedBy } }, phase: 'Succeeded', message: 'successfully synced (all tasks run)', startedAt: iso(now), finishedAt: iso(now + 1000), syncResult: { revision: desired.revision, resources: results } };
  delete st.conditions;
  const cache = argoCache(ks, app);
  cache.syncedRevision = desired.revision;
  cache.attempted = desired.revision;
  cache.comparedAt = 0;
  return { ok: true, message: 'successfully synced (all tasks run)', results };
}

export function argoCache(ks: KubeState, app: KObj): J {
  return ((ks.argo ??= {})[`${app.metadata.namespace}/${app.metadata.name}`] ??= {});
}

/** Force a fresh look at Git on the next tick (argocd app get --refresh, sync). */
export function refreshApp(host: SimState, ks: KubeState, app: KObj, now: number): void {
  const cache = argoCache(ks, app);
  cache.desired = renderApp(host, app, now);
  cache.comparedAt = 0;
  updateStatus(ks, app, now);
}

function updateStatus(ks: KubeState, app: KObj, now: number): void {
  const cache = argoCache(ks, app);
  const desired: Desired = cache.desired;
  const { resources, sync, health } = compare(ks, app, desired);
  const st = (app.status ??= {});
  st.sync = { status: sync, revision: desired.revision, comparedTo: { source: app.spec.source, destination: app.spec.destination } };
  st.health = { status: desired.error && !resources.length ? 'Healthy' : health };
  st.resources = resources;
  st.reconciledAt = iso(desired.fetchedAt);
  st.sourceType = desired.sourceType;
  st.summary = { images: [...new Set(resources.flatMap((r) => (r.kind === 'Deployment' ? (getObj(ks, 'Deployment', r.namespace, r.name)?.spec.template.spec.containers ?? []).map((c: J) => c.image) : [])))] };
  if (desired.error) st.conditions = [{ type: 'ComparisonError', message: desired.error, lastTransitionTime: iso(now) }];
  else if (st.conditions?.some((c: J) => c.type === 'ComparisonError')) delete st.conditions;
  cache.comparedAt = now;
}

/** The application controller's work for one tick. */
export function argoController(host: SimState, ks: KubeState, now: number): void {
  if (!argoInstalled(ks) || !controllerUp(ks)) return;
  for (const app of listObjs(ks, 'Application')) {
    const cache = argoCache(ks, app);
    if (app.metadata.deletionTimestamp) {
      if (app.metadata.finalizers?.includes('resources-finalizer.argocd.argoproj.io')) for (const o of managedObjects(ks, app)) deleteLive(ks, o, now);
      removeObj(ks, app);
      delete ks.argo![`${app.metadata.namespace}/${app.metadata.name}`];
      continue;
    }
    const specKey = JSON.stringify(app.spec);
    if (!cache.desired || now - cache.desired.fetchedAt >= POLL_MS || cache.specKey !== specKey) {
      cache.desired = renderApp(host, app, now);
      cache.specKey = specKey;
      cache.comparedAt = 0;
    }
    if (now - (cache.comparedAt ?? 0) < COMPARE_MS) continue;
    updateStatus(ks, app, now);
    const auto = app.spec.syncPolicy?.automated;
    if (!auto || app.status.sync.status !== 'OutOfSync' || cache.desired.error) continue;
    const newRevision = cache.attempted !== cache.desired.revision;
    const drifted = !!auto.selfHeal && app.status.resources.some((r: ResourceStatus) => r.status === 'OutOfSync' && !r.requiresPruning);
    const prunable = !!auto.prune && app.status.resources.some((r: ResourceStatus) => r.requiresPruning);
    if (newRevision || drifted || (prunable && newRevision)) {
      cache.attempted = cache.desired.revision;
      syncApp(host, ks, app, now, { prune: !!auto.prune, desired: cache.desired, initiatedBy: 'automated' });
      updateStatus(ks, app, now);
    }
  }
}
