/** The object store: resource kinds, lookup helpers, ids, events, and the cluster's initial state. */
import { sha1, utf8 } from '../git/sha1';
import type { SimState } from '../state';
import type { AppSpec, J, KEvent, KObj, KubeState, Meta } from './types';

export interface ResourceInfo {
  kind: string;
  plural: string;
  singular: string;
  short: string[];
  apiVersion: string;
  namespaced: boolean;
}

export const RESOURCES: ResourceInfo[] = [
  { kind: 'Pod', plural: 'pods', singular: 'pod', short: ['po'], apiVersion: 'v1', namespaced: true },
  { kind: 'Service', plural: 'services', singular: 'service', short: ['svc'], apiVersion: 'v1', namespaced: true },
  { kind: 'Endpoints', plural: 'endpoints', singular: 'endpoints', short: ['ep'], apiVersion: 'v1', namespaced: true },
  { kind: 'ConfigMap', plural: 'configmaps', singular: 'configmap', short: ['cm'], apiVersion: 'v1', namespaced: true },
  { kind: 'Secret', plural: 'secrets', singular: 'secret', short: [], apiVersion: 'v1', namespaced: true },
  { kind: 'Namespace', plural: 'namespaces', singular: 'namespace', short: ['ns'], apiVersion: 'v1', namespaced: false },
  { kind: 'Node', plural: 'nodes', singular: 'node', short: ['no'], apiVersion: 'v1', namespaced: false },
  { kind: 'Event', plural: 'events', singular: 'event', short: ['ev'], apiVersion: 'v1', namespaced: true },
  { kind: 'Deployment', plural: 'deployments', singular: 'deployment', short: ['deploy'], apiVersion: 'apps/v1', namespaced: true },
  { kind: 'ReplicaSet', plural: 'replicasets', singular: 'replicaset', short: ['rs'], apiVersion: 'apps/v1', namespaced: true },
  { kind: 'DaemonSet', plural: 'daemonsets', singular: 'daemonset', short: ['ds'], apiVersion: 'apps/v1', namespaced: true },
  { kind: 'Job', plural: 'jobs', singular: 'job', short: [], apiVersion: 'batch/v1', namespaced: true },
  { kind: 'StatefulSet', plural: 'statefulsets', singular: 'statefulset', short: ['sts'], apiVersion: 'apps/v1', namespaced: true },
  { kind: 'CronJob', plural: 'cronjobs', singular: 'cronjob', short: ['cj'], apiVersion: 'batch/v1', namespaced: true },
  { kind: 'PersistentVolumeClaim', plural: 'persistentvolumeclaims', singular: 'persistentvolumeclaim', short: ['pvc'], apiVersion: 'v1', namespaced: true },
  { kind: 'PersistentVolume', plural: 'persistentvolumes', singular: 'persistentvolume', short: ['pv'], apiVersion: 'v1', namespaced: false },
  { kind: 'StorageClass', plural: 'storageclasses', singular: 'storageclass', short: ['sc'], apiVersion: 'storage.k8s.io/v1', namespaced: false },
  { kind: 'Ingress', plural: 'ingresses', singular: 'ingress', short: ['ing'], apiVersion: 'networking.k8s.io/v1', namespaced: true },
  { kind: 'IngressClass', plural: 'ingressclasses', singular: 'ingressclass', short: [], apiVersion: 'networking.k8s.io/v1', namespaced: false },
  { kind: 'NetworkPolicy', plural: 'networkpolicies', singular: 'networkpolicy', short: ['netpol'], apiVersion: 'networking.k8s.io/v1', namespaced: true },
  { kind: 'HorizontalPodAutoscaler', plural: 'horizontalpodautoscalers', singular: 'horizontalpodautoscaler', short: ['hpa'], apiVersion: 'autoscaling/v2', namespaced: true },
  { kind: 'ServiceAccount', plural: 'serviceaccounts', singular: 'serviceaccount', short: ['sa'], apiVersion: 'v1', namespaced: true },
  { kind: 'Role', plural: 'roles', singular: 'role', short: [], apiVersion: 'rbac.authorization.k8s.io/v1', namespaced: true },
  { kind: 'RoleBinding', plural: 'rolebindings', singular: 'rolebinding', short: [], apiVersion: 'rbac.authorization.k8s.io/v1', namespaced: true },
  { kind: 'ClusterRole', plural: 'clusterroles', singular: 'clusterrole', short: [], apiVersion: 'rbac.authorization.k8s.io/v1', namespaced: false },
  { kind: 'ClusterRoleBinding', plural: 'clusterrolebindings', singular: 'clusterrolebinding', short: [], apiVersion: 'rbac.authorization.k8s.io/v1', namespaced: false },
];

export function resourceFor(word: string): ResourceInfo | undefined {
  const find = (w: string) => RESOURCES.find((r) => r.plural === w || r.singular === w || r.short.includes(w) || r.kind.toLowerCase() === w);
  const w = word.toLowerCase();
  // "deployments.apps", "ingresses.networking.k8s.io", "roles.rbac.authorization.k8s.io"
  return find(w) ?? (w.includes('.') ? find(w.slice(0, w.indexOf('.'))) : undefined);
}

export function infoOf(kind: string): ResourceInfo {
  return RESOURCES.find((r) => r.kind === kind)!;
}

/** "deployment.apps/web" style name kubectl prints. */
export function qualified(kind: string, name: string): string {
  const r = infoOf(kind);
  const group = r.apiVersion.includes('/') ? '.' + r.apiVersion.split('/')[0] : '';
  return `${r.singular}${group}/${name}`;
}

// ------------------------------------------------------------------ ids & time

export function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export function parseIso(s: string | undefined): number {
  return s ? Date.parse(s) : 0;
}

export function uid(seed: string): string {
  const h = sha1(utf8(seed));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const ALPHA = 'bcdfghjklmnpqrstvwxz2456789';

/** Random-looking but deterministic suffix (pod-template-hash style alphabet). */
export function suffix(seed: string, len: number): string {
  const h = sha1(utf8(seed));
  let out = '';
  for (let i = 0; out.length < len; i++) out += ALPHA[parseInt(h.slice(i * 2, i * 2 + 2), 16) % ALPHA.length];
  return out;
}

export function nextSeq(ks: KubeState): number {
  return ++ks.seq;
}

export function newMeta(ks: KubeState, now: number, name: string, namespace: string | undefined, extra: Partial<Meta> = {}): Meta {
  const seq = nextSeq(ks);
  return {
    name,
    ...(namespace !== undefined ? { namespace } : {}),
    uid: uid(`${name}/${namespace}/${seq}`),
    resourceVersion: String(1000 + seq),
    creationTimestamp: iso(now),
    ...extra,
  };
}

export function bump(ks: KubeState, o: KObj): void {
  o.metadata.resourceVersion = String(1000 + nextSeq(ks));
}

// ------------------------------------------------------------------ store

const keyOf = (ns: string | undefined, name: string) => (ns ? `${ns}/${name}` : name);

export function getObj(ks: KubeState, kind: string, ns: string | undefined, name: string): KObj | undefined {
  return ks.objects[kind]?.[keyOf(infoOf(kind).namespaced ? ns : undefined, name)];
}

export function listObjs(ks: KubeState, kind: string, ns?: string): KObj[] {
  const all = Object.values(ks.objects[kind] ?? {});
  return (ns === undefined ? all : all.filter((o) => o.metadata.namespace === ns)).sort((a, b) =>
    (a.metadata.namespace ?? '') === (b.metadata.namespace ?? '') ? (a.metadata.name < b.metadata.name ? -1 : 1) : (a.metadata.namespace ?? '') < (b.metadata.namespace ?? '') ? -1 : 1,
  );
}

export function putObj(ks: KubeState, o: KObj): void {
  (ks.objects[o.kind] ??= {})[keyOf(o.metadata.namespace, o.metadata.name)] = o;
}

export function removeObj(ks: KubeState, o: KObj): void {
  delete ks.objects[o.kind]?.[keyOf(o.metadata.namespace, o.metadata.name)];
  if (o.kind === 'Pod') delete ks.runtime[o.metadata.uid];
}

export function ownedBy(ks: KubeState, kind: string, owner: KObj): KObj[] {
  return listObjs(ks, kind, owner.metadata.namespace).filter((o) => o.metadata.ownerReferences?.some((r) => r.uid === owner.metadata.uid));
}

export function ownerRef(o: KObj) {
  return { apiVersion: o.apiVersion, kind: o.kind, name: o.metadata.name, uid: o.metadata.uid, controller: true, blockOwnerDeletion: true };
}

/** Does a label set match a selector (matchLabels / matchExpressions or a plain map)? */
export function matches(labels: Record<string, string> | undefined, selector: J): boolean {
  if (!selector) return false;
  const l = labels ?? {};
  const ml: Record<string, string> = selector.matchLabels ?? (selector.matchExpressions ? {} : selector);
  for (const [k, v] of Object.entries(ml)) if (l[k] !== v) return false;
  for (const e of selector.matchExpressions ?? []) {
    const has = e.key in l;
    if (e.operator === 'In' && !(has && e.values.includes(l[e.key]))) return false;
    if (e.operator === 'NotIn' && has && e.values.includes(l[e.key])) return false;
    if (e.operator === 'Exists' && !has) return false;
    if (e.operator === 'DoesNotExist' && has) return false;
  }
  return Object.keys(ml).length > 0 || (selector.matchExpressions ?? []).length > 0;
}

// ------------------------------------------------------------------ events

export function emit(ks: KubeState, now: number, o: KObj, type: 'Normal' | 'Warning', reason: string, message: string, source: string): void {
  const ns = o.metadata.namespace ?? 'default';
  const same = ks.events.find((e) => e.involved.uid === o.metadata.uid && e.reason === reason && e.message === message);
  if (same) {
    same.count++;
    same.last = now;
    return;
  }
  ks.events.push({ namespace: ns, involved: { kind: o.kind, name: o.metadata.name, uid: o.metadata.uid }, type, reason, message, source, first: now, last: now, count: 1 });
  if (ks.events.length > 600) ks.events.splice(0, ks.events.length - 600);
}

export function eventsFor(ks: KubeState, o: KObj): KEvent[] {
  return ks.events.filter((e) => e.involved.uid === o.metadata.uid).sort((a, b) => a.last - b.last);
}

// ------------------------------------------------------------------ bootstrap

export const CLUSTER = 'devquest';
export const NODES = [
  { name: `${CLUSTER}-control-plane`, ip: '172.18.0.2', cidr: '10.244.0.0/24', controlPlane: true },
  { name: `${CLUSTER}-worker`, ip: '172.18.0.3', cidr: '10.244.1.0/24', controlPlane: false },
  { name: `${CLUSTER}-worker2`, ip: '172.18.0.4', cidr: '10.244.2.0/24', controlPlane: false },
];
export const K8S_VERSION = 'v1.31.2';

/** Behaviour of the system images the cluster itself runs. */
export const SYSTEM_IMAGES: Record<string, AppSpec> = {
  'registry.k8s.io/etcd:3.5.15-0': { listen: [2379, 2380], logs: ['{"level":"info","msg":"serving client traffic securely","address":"172.18.0.2:2379"}'], memMi: 60, cpuM: 25 },
  'registry.k8s.io/kube-apiserver:v1.31.2': { listen: [6443], logs: ['I1103 08:59:58.000000       1 controller.go:615] quota admission added evaluator for: deployments.apps'], memMi: 280, cpuM: 45 },
  'registry.k8s.io/kube-controller-manager:v1.31.2': { listen: [10257], logs: ['I1103 08:59:59.000000       1 controllermanager.go:797] "Started controller" controller="deployment-controller"'], memMi: 50, cpuM: 15 },
  'registry.k8s.io/kube-scheduler:v1.31.2': { listen: [10259], logs: ['I1103 08:59:59.000000       1 leaderelection.go:268] successfully acquired lease kube-system/kube-scheduler'], memMi: 22, cpuM: 4 },
  'registry.k8s.io/kube-proxy:v1.31.2': { logs: ['I1103 08:59:59.000000       1 server_linux.go:66] "Using iptables proxy"'], memMi: 18, cpuM: 1 },
  'docker.io/kindest/kindnetd:v20241023-a345ebe4': { logs: ['I1103 08:59:59.000000       1 main.go:139] hostIP = 172.18.0.2'], memMi: 12, cpuM: 1 },
  'registry.k8s.io/coredns/coredns:v1.11.3': {
    listen: [53, 8080, 8181],
    http: { '/health': { body: 'OK' }, '/ready': { body: 'OK' } },
    logs: ['.:53', '[INFO] plugin/reload: Running configuration SHA512 = 591cf328cccc12bc490481273e738df59329c62c0b729d94e8b61db9961c2fa5', 'CoreDNS-1.11.3', 'linux/amd64, go1.21.11, a6338e9'],
    memMi: 14,
    cpuM: 3,
  },
  'registry.k8s.io/metrics-server/metrics-server:v0.7.2': { listen: [10250], http: { '/livez': { body: 'ok' }, '/readyz': { body: 'ok' } }, logs: ['I1103 08:59:59.000000       1 serving.go:374] Generated self-signed cert in-memory', 'I1103 09:00:00.000000       1 secure_serving.go:213] Serving securely on [::]:10250'], memMi: 21, cpuM: 4 },
  'registry.k8s.io/ingress-nginx/controller:v1.11.3': {
    listen: [80, 443, 10254],
    http: { '/healthz': { body: 'ok' } },
    logs: ['-------------------------------------------------------------------------------', 'NGINX Ingress controller', '  Release:       v1.11.3', '  Build:         0106de65cfccb74405a6dfa7d9daffc6f0a6ef1a', '  Repository:    https://github.com/kubernetes/ingress-nginx', '  nginx version: nginx/1.25.5', '', '-------------------------------------------------------------------------------', 'I1103 09:00:00.000000       7 controller.go:213] "Backend successfully reloaded"'],
    memMi: 95,
    cpuM: 3,
  },
  'docker.io/kindest/local-path-provisioner:v20241023-a345ebe4': { logs: ['I1103 08:59:59.000000 1 controller.go:811] Starting provisioner controller'], memMi: 9, cpuM: 1 },
};

function ns(ks: KubeState, name: string, created: number): KObj {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: newMeta(ks, created, name, undefined, { labels: { 'kubernetes.io/metadata.name': name } }), spec: { finalizers: ['kubernetes'] }, status: { phase: 'Active' } };
}

function node(ks: KubeState, n: (typeof NODES)[number], created: number): KObj {
  const labels: Record<string, string> = {
    'beta.kubernetes.io/arch': 'amd64',
    'beta.kubernetes.io/os': 'linux',
    'kubernetes.io/arch': 'amd64',
    'kubernetes.io/hostname': n.name,
    'kubernetes.io/os': 'linux',
  };
  if (n.controlPlane) {
    labels['node-role.kubernetes.io/control-plane'] = '';
    labels['ingress-ready'] = 'true';
  }
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: newMeta(ks, created, n.name, undefined, { labels }),
    spec: { podCIDR: n.cidr, podCIDRs: [n.cidr], providerID: `kind://docker/${CLUSTER}/${n.name}`, ...(n.controlPlane ? { taints: [{ effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane' }] } : {}) },
    status: {
      addresses: [
        { address: n.ip, type: 'InternalIP' },
        { address: n.name, type: 'Hostname' },
      ],
      allocatable: { cpu: '2', 'ephemeral-storage': '61202244Ki', memory: '4015412Ki', pods: '110' },
      capacity: { cpu: '2', 'ephemeral-storage': '61202244Ki', memory: '4015412Ki', pods: '110' },
      conditions: [
        { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', message: 'kubelet has sufficient memory available' },
        { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', message: 'kubelet has no disk pressure' },
        { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID', message: 'kubelet has sufficient PID available' },
        { type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is posting ready status' },
      ],
      nodeInfo: {
        architecture: 'amd64',
        containerRuntimeVersion: 'containerd://1.7.18',
        kernelVersion: '6.8.0-48-generic',
        kubeProxyVersion: K8S_VERSION,
        kubeletVersion: K8S_VERSION,
        operatingSystem: 'linux',
        osImage: 'Debian GNU/Linux 12 (bookworm)',
      },
    },
  };
}

function container(name: string, image: string, extra: J = {}): J {
  return { name, image, imagePullPolicy: 'IfNotPresent', resources: {}, terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File', ...extra };
}

function podSpec(containers: J[], extra: J = {}): J {
  return { containers, dnsPolicy: 'ClusterFirst', restartPolicy: 'Always', schedulerName: 'default-scheduler', securityContext: {}, terminationGracePeriodSeconds: 30, ...extra };
}

/** A fresh kind-style cluster that has been running for 10 days. */
export function createKubeState(now: number): KubeState {
  const ks: KubeState = {
    objects: {},
    runtime: {},
    events: [],
    nodeImages: Object.fromEntries(NODES.map((n) => [n.name, [] as string[]])),
    images: {},
    currentContext: `kind-${CLUSTER}`,
    namespace: 'default',
    lastTick: now - 10 * 86400_000,
    seq: 0,
    forwards: [],
  };
  const t0 = ks.lastTick;
  for (const n of ['default', 'kube-node-lease', 'kube-public', 'kube-system', 'local-path-storage']) putObj(ks, ns(ks, n, t0));
  for (const n of NODES) putObj(ks, node(ks, n, t0));
  const cp = NODES[0].name;
  // Static control-plane pods (mirror pods, already bound to the control-plane node).
  for (const [comp, image, prio] of [
    ['etcd', 'registry.k8s.io/etcd:3.5.15-0', 2000001000],
    ['kube-apiserver', 'registry.k8s.io/kube-apiserver:v1.31.2', 2000001000],
    ['kube-controller-manager', 'registry.k8s.io/kube-controller-manager:v1.31.2', 2000001000],
    ['kube-scheduler', 'registry.k8s.io/kube-scheduler:v1.31.2', 2000001000],
  ] as const) {
    putObj(ks, {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: newMeta(ks, t0, `${comp}-${cp}`, 'kube-system', { labels: { component: comp, tier: 'control-plane' } }),
      spec: podSpec([container(comp, image, { resources: { requests: { cpu: comp === 'etcd' ? '100m' : comp === 'kube-apiserver' ? '250m' : comp === 'kube-scheduler' ? '100m' : '200m' } } })], {
        nodeName: cp,
        hostNetwork: true,
        priority: prio,
        priorityClassName: 'system-node-critical',
        tolerations: [{ effect: 'NoExecute', operator: 'Exists' }],
      }),
      status: { phase: 'Pending' },
    });
  }
  const sys = (kind: string, name: string, labels: Record<string, string>, template: J, extra: J = {}) =>
    putObj(ks, {
      apiVersion: 'apps/v1',
      kind,
      metadata: newMeta(ks, t0, name, 'kube-system', { labels, generation: 1, annotations: kind === 'Deployment' ? { 'deployment.kubernetes.io/revision': '1' } : undefined }),
      spec: { selector: { matchLabels: labels }, template: { metadata: { labels }, spec: template }, ...extra },
      status: {},
    });
  const tolerateAll = { tolerations: [{ operator: 'Exists' }] };
  sys('DaemonSet', 'kube-proxy', { 'k8s-app': 'kube-proxy' }, podSpec([container('kube-proxy', 'registry.k8s.io/kube-proxy:v1.31.2')], { ...tolerateAll, hostNetwork: true, priorityClassName: 'system-node-critical' }), {
    updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } },
  });
  sys('DaemonSet', 'kindnet', { app: 'kindnet' }, podSpec([container('kindnet-cni', 'docker.io/kindest/kindnetd:v20241023-a345ebe4', { resources: { requests: { cpu: '100m', memory: '50Mi' }, limits: { cpu: '100m', memory: '50Mi' } } })], { ...tolerateAll, hostNetwork: true }), {
    updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } },
  });
  sys(
    'Deployment',
    'coredns',
    { 'k8s-app': 'kube-dns' },
    podSpec([container('coredns', 'registry.k8s.io/coredns/coredns:v1.11.3', { resources: { requests: { cpu: '100m', memory: '70Mi' }, limits: { memory: '170Mi' } }, ports: [{ containerPort: 53, name: 'dns', protocol: 'UDP' }] })], {
      priorityClassName: 'system-cluster-critical',
      tolerations: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }],
      nodeSelector: { 'kubernetes.io/os': 'linux' },
    }),
    { replicas: 2, strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: 1 } }, revisionHistoryLimit: 10, progressDeadlineSeconds: 600 },
  );
  putObj(ks, {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: newMeta(ks, t0, 'local-path-provisioner', 'local-path-storage', { generation: 1, annotations: { 'deployment.kubernetes.io/revision': '1' } }),
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'local-path-provisioner' } },
      template: { metadata: { labels: { app: 'local-path-provisioner' } }, spec: podSpec([container('local-path-provisioner', 'docker.io/kindest/local-path-provisioner:v20241023-a345ebe4')], { tolerations: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] }) },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } },
      revisionHistoryLimit: 10,
      progressDeadlineSeconds: 600,
    },
    status: {},
  });
  // Default StorageClass (kind's local-path provisioner).
  putObj(ks, {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: newMeta(ks, t0, 'standard', undefined, { annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }),
    provisioner: 'rancher.io/local-path',
    reclaimPolicy: 'Delete',
    volumeBindingMode: 'WaitForFirstConsumer',
  });
  // metrics-server (kubectl top, HPA).
  putObj(ks, {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: newMeta(ks, t0, 'metrics-server', 'kube-system', { labels: { 'k8s-app': 'metrics-server' }, generation: 1, annotations: { 'deployment.kubernetes.io/revision': '1' } }),
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'k8s-app': 'metrics-server' } },
      template: { metadata: { labels: { 'k8s-app': 'metrics-server' } }, spec: podSpec([container('metrics-server', 'registry.k8s.io/metrics-server/metrics-server:v0.7.2', { resources: { requests: { cpu: '100m', memory: '200Mi' } } })], { priorityClassName: 'system-cluster-critical' }) },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: 0 } },
      revisionHistoryLimit: 10,
      progressDeadlineSeconds: 600,
    },
    status: {},
  });
  // ingress-nginx, as installed for kind (host port 80 → the controller).
  putObj(ks, ns(ks, 'ingress-nginx', t0));
  const ingLabels = { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' };
  putObj(ks, {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: newMeta(ks, t0, 'ingress-nginx-controller', 'ingress-nginx', { labels: ingLabels, generation: 1, annotations: { 'deployment.kubernetes.io/revision': '1' } }),
    spec: {
      replicas: 1,
      selector: { matchLabels: ingLabels },
      template: {
        metadata: { labels: ingLabels },
        spec: podSpec([container('controller', 'registry.k8s.io/ingress-nginx/controller:v1.11.3', { ports: [{ containerPort: 80, hostPort: 80, name: 'http', protocol: 'TCP' }, { containerPort: 443, hostPort: 443, name: 'https', protocol: 'TCP' }], resources: { requests: { cpu: '100m', memory: '90Mi' } } })], {
          nodeSelector: { 'ingress-ready': 'true', 'kubernetes.io/os': 'linux' },
          tolerations: [{ effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane', operator: 'Equal' }],
        }),
      },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: 1 } },
      revisionHistoryLimit: 10,
      progressDeadlineSeconds: 600,
    },
    status: {},
  });
  putObj(ks, {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: newMeta(ks, t0, 'ingress-nginx-controller', 'ingress-nginx', { labels: ingLabels }),
    spec: {
      clusterIP: '10.96.88.20',
      clusterIPs: ['10.96.88.20'],
      ports: [
        { appProtocol: 'http', name: 'http', nodePort: 31080, port: 80, protocol: 'TCP', targetPort: 'http' },
        { appProtocol: 'https', name: 'https', nodePort: 31443, port: 443, protocol: 'TCP', targetPort: 'https' },
      ],
      selector: ingLabels,
      sessionAffinity: 'None',
      type: 'NodePort',
      externalTrafficPolicy: 'Cluster',
    },
    status: { loadBalancer: {} },
  });
  putObj(ks, { apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: newMeta(ks, t0, 'nginx', undefined, { labels: ingLabels }), spec: { controller: 'k8s.io/ingress-nginx' } });
  // RBAC: the built-in user-facing ClusterRoles, and cluster-admin for kubeadm's admin group.
  const rule = (apiGroups: string[], resources: string[], verbs: string[]) => ({ apiGroups, resources, verbs });
  const READ = ['get', 'list', 'watch'];
  const WRITE = ['create', 'delete', 'deletecollection', 'patch', 'update'];
  const viewRules = [
    rule([''], ['configmaps', 'endpoints', 'persistentvolumeclaims', 'pods', 'pods/log', 'pods/status', 'replicationcontrollers', 'services', 'serviceaccounts', 'events', 'namespaces', 'limitranges', 'resourcequotas'], READ),
    rule(['apps'], ['daemonsets', 'deployments', 'deployments/scale', 'replicasets', 'statefulsets'], READ),
    rule(['batch'], ['cronjobs', 'jobs'], READ),
    rule(['autoscaling'], ['horizontalpodautoscalers'], READ),
    rule(['networking.k8s.io'], ['ingresses', 'networkpolicies'], READ),
  ];
  const editRules = [
    rule([''], ['pods', 'pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy', 'configmaps', 'secrets', 'services', 'persistentvolumeclaims', 'serviceaccounts', 'endpoints', 'replicationcontrollers'], WRITE),
    rule([''], ['secrets'], READ),
    rule(['apps'], ['daemonsets', 'deployments', 'deployments/rollback', 'deployments/scale', 'replicasets', 'replicasets/scale', 'statefulsets', 'statefulsets/scale'], WRITE),
    rule(['batch'], ['cronjobs', 'jobs'], WRITE),
    rule(['autoscaling'], ['horizontalpodautoscalers'], WRITE),
    rule(['networking.k8s.io'], ['ingresses', 'networkpolicies'], WRITE),
    ...viewRules,
  ];
  const adminRules = [rule(['rbac.authorization.k8s.io'], ['rolebindings', 'roles'], [...READ, ...WRITE]), ...editRules];
  for (const [name, rules] of [
    ['cluster-admin', [rule(['*'], ['*'], ['*']), { nonResourceURLs: ['*'], verbs: ['*'] }]],
    ['admin', adminRules],
    ['edit', editRules],
    ['view', viewRules],
  ] as const) {
    putObj(ks, { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: newMeta(ks, t0, name, undefined, { labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' } }), rules: rules as unknown as J[] });
  }
  putObj(ks, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: newMeta(ks, t0, 'kubeadm:cluster-admins', undefined),
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
    subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'kubeadm:cluster-admins' }],
  });
  putObj(ks, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: newMeta(ks, t0, 'cluster-admin', undefined, { labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' } }),
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
    subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:masters' }],
  });
  putObj(ks, {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: newMeta(ks, t0, 'kubernetes', 'default', { labels: { component: 'apiserver', provider: 'kubernetes' } }),
    spec: { clusterIP: '10.96.0.1', clusterIPs: ['10.96.0.1'], ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 6443 }], sessionAffinity: 'None', type: 'ClusterIP' },
    status: { loadBalancer: {} },
  });
  putObj(ks, {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: newMeta(ks, t0, 'kube-dns', 'kube-system', { labels: { 'k8s-app': 'kube-dns', 'kubernetes.io/name': 'CoreDNS' } }),
    spec: {
      clusterIP: '10.96.0.10',
      clusterIPs: ['10.96.0.10'],
      ports: [
        { name: 'dns', port: 53, protocol: 'UDP', targetPort: 53 },
        { name: 'dns-tcp', port: 53, protocol: 'TCP', targetPort: 53 },
        { name: 'metrics', port: 9153, protocol: 'TCP', targetPort: 9153 },
      ],
      selector: { 'k8s-app': 'kube-dns' },
      sessionAffinity: 'None',
      type: 'ClusterIP',
    },
    status: { loadBalancer: {} },
  });
  return ks;
}

/** The cluster behind `kubectl`, created on first use (and caught up to now). */
export function clusterOf(state: SimState): KubeState {
  const host = state.context?.host ?? state;
  if (!host.kube) host.kube = createKubeState(host.clock);
  return host.kube;
}
