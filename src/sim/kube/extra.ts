/**
 * Controllers added in the second Kubernetes step: storage (PVC binding + local-path
 * provisioning), StatefulSets, CronJobs, the HorizontalPodAutoscaler, ServiceAccounts,
 * NoExecute taint eviction — plus the CPU/memory usage model behind `kubectl top` and HPA.
 */
import { makeDir } from '../vfs/vfs';
import { bump, emit, getObj, iso, listObjs, matches, newMeta, ownedBy, ownerRef, parseIso, putObj, removeObj, suffix } from './cluster';
import { scheduleTimes, parseCron } from './cron';
import { resolveImage } from './images';
import { cpuMilli, memBytes } from './quantity';
import type { J, KObj, KubeState } from './types';

const SEC = 1000;

type Helpers = {
  podFromTemplate: (ks: KubeState, now: number, owner: KObj, template: J, name: string, extraLabels: Record<string, string>) => KObj;
  deletePod: (ks: KubeState, now: number, pod: KObj) => void;
  isPodReady: (p: KObj) => boolean;
  isTerminating: (o: KObj) => boolean;
  templateHash: (t: J) => string;
  tolerates: (pod: J, taint: J) => boolean;
};
let h: Helpers;
export function setHelpers(x: Helpers): void {
  h = x;
}

const rate = (o: J, key: string, now: number, every: number) => {
  const last = o._rate?.[key] ?? -Infinity;
  if (now - last < every) return false;
  o._rate = { ...(o._rate ?? {}), [key]: now };
  return true;
};

// ------------------------------------------------------------------ service accounts

export function serviceAccountController(ks: KubeState, now: number): void {
  for (const n of listObjs(ks, 'Namespace')) {
    if (h.isTerminating(n)) continue;
    if (!getObj(ks, 'ServiceAccount', n.metadata.name, 'default')) {
      putObj(ks, { apiVersion: 'v1', kind: 'ServiceAccount', metadata: newMeta(ks, Math.min(now, parseIso(n.metadata.creationTimestamp) || now), 'default', n.metadata.name) });
    }
  }
}

// ------------------------------------------------------------------ storage

function pvcRequest(pvc: KObj): string {
  return pvc.spec?.resources?.requests?.storage ?? '1Gi';
}

export function podsUsingClaim(ks: KubeState, pvc: KObj): KObj[] {
  return listObjs(ks, 'Pod', pvc.metadata.namespace).filter(
    (p) => !['Succeeded', 'Failed'].includes(p.status?.phase) && (p.spec.volumes ?? []).some((v: J) => v.persistentVolumeClaim?.claimName === pvc.metadata.name),
  );
}

function provision(ks: KubeState, now: number, pvc: KObj, sc: KObj, node: string): void {
  const ns = pvc.metadata.namespace!;
  const modes: string[] = pvc.spec.accessModes ?? [];
  if (sc.provisioner === 'rancher.io/local-path' && modes.some((m) => m !== 'ReadWriteOnce' && m !== 'ReadWriteOncePod')) {
    if (rate(pvc.status, 'provfail', now, 60 * SEC)) {
      emit(ks, now, pvc, 'Warning', 'ProvisioningFailed', `failed to provision volume with StorageClass "${sc.metadata.name}": Only support ReadWriteOnce access mode`, `rancher.io/local-path_local-path-provisioner-7b4bcb8tv9-2jhkn_${pvc.metadata.uid.slice(0, 8)}`);
    }
    return;
  }
  const pvName = `pvc-${pvc.metadata.uid}`;
  const src = `rancher.io/local-path_local-path-provisioner-7b4bcb8tv9-2jhkn_${suffix('prov', 8)}`;
  emit(ks, now, pvc, 'Normal', 'Provisioning', `External provisioner is provisioning volume for claim "${ns}/${pvc.metadata.name}"`, src);
  const pv: KObj = {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: newMeta(ks, now, pvName, undefined, {
      annotations: { 'local.path.provisioner/selected-node': node, 'pv.kubernetes.io/provisioned-by': sc.provisioner },
    }),
    spec: {
      accessModes: modes,
      capacity: { storage: pvcRequest(pvc) },
      claimRef: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: pvc.metadata.name, namespace: ns, resourceVersion: pvc.metadata.resourceVersion, uid: pvc.metadata.uid },
      hostPath: { path: `/var/local-path-provisioner/${pvName}_${ns}_${pvc.metadata.name}`, type: 'DirectoryOrCreate' },
      nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [node] }] }] } },
      persistentVolumeReclaimPolicy: sc.reclaimPolicy ?? 'Delete',
      storageClassName: sc.metadata.name,
      volumeMode: 'Filesystem',
    },
    status: { phase: 'Bound', lastPhaseTransitionTime: iso(now) },
  };
  putObj(ks, pv);
  (ks.volumes ??= {})[pvName] = makeDir('root', 'root', now, 0o777);
  bindClaim(ks, now, pvc, pv);
  emit(ks, now, pvc, 'Normal', 'ProvisioningSucceeded', `Successfully provisioned volume ${pvName}`, src);
}

function bindClaim(ks: KubeState, now: number, pvc: KObj, pv: KObj): void {
  pvc.spec.volumeName = pv.metadata.name;
  pvc.metadata.annotations = {
    ...(pvc.metadata.annotations ?? {}),
    'pv.kubernetes.io/bind-completed': 'yes',
    'pv.kubernetes.io/bound-by-controller': 'yes',
    ...(pv.metadata.annotations?.['pv.kubernetes.io/provisioned-by'] ? { 'volume.beta.kubernetes.io/storage-provisioner': pv.metadata.annotations['pv.kubernetes.io/provisioned-by'], 'volume.kubernetes.io/storage-provisioner': pv.metadata.annotations['pv.kubernetes.io/provisioned-by'] } : {}),
  };
  pvc.metadata.finalizers = ['kubernetes.io/pvc-protection'];
  pvc.status = { phase: 'Bound', accessModes: pv.spec.accessModes, capacity: { ...pv.spec.capacity } };
  pv.status = { phase: 'Bound', lastPhaseTransitionTime: iso(now) };
  pv.spec.claimRef = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: pvc.metadata.name, namespace: pvc.metadata.namespace, resourceVersion: pvc.metadata.resourceVersion, uid: pvc.metadata.uid };
  (ks.volumes ??= {})[pv.metadata.name] ??= makeDir('root', 'root', now, 0o777);
  bump(ks, pvc);
}

export function storageController(ks: KubeState, now: number): void {
  for (const pvc of listObjs(ks, 'PersistentVolumeClaim')) {
    pvc.status ??= { phase: 'Pending' };
    if (h.isTerminating(pvc)) {
      if (podsUsingClaim(ks, pvc).length) continue;
      const pv = pvc.spec.volumeName ? getObj(ks, 'PersistentVolume', undefined, pvc.spec.volumeName) : undefined;
      if (pv) {
        if ((pv.spec.persistentVolumeReclaimPolicy ?? 'Delete') === 'Delete') {
          removeObj(ks, pv);
          delete ks.volumes?.[pv.metadata.name];
        } else {
          pv.status = { phase: 'Released', lastPhaseTransitionTime: iso(now) };
        }
      }
      removeObj(ks, pvc);
      continue;
    }
    if (pvc.status.phase === 'Bound') continue;
    const className = pvc.spec.storageClassName;
    if (!className) {
      // Static binding to an available PersistentVolume.
      const want = memBytes(pvcRequest(pvc));
      const pv = listObjs(ks, 'PersistentVolume').find(
        (v) => v.status?.phase === 'Available' && (v.spec.storageClassName ?? '') === '' && memBytes(v.spec.capacity?.storage) >= want && (pvc.spec.accessModes ?? []).every((m: string) => (v.spec.accessModes ?? []).includes(m)),
      );
      if (pv) bindClaim(ks, now, pvc, pv);
      else if (rate(pvc.status, 'nopv', now, 60 * SEC)) emit(ks, now, pvc, 'Normal', 'FailedBinding', 'no persistent volumes available for this claim and no storage class is set', 'persistentvolume-controller');
      continue;
    }
    const sc = getObj(ks, 'StorageClass', undefined, className);
    if (!sc) {
      if (rate(pvc.status, 'nosc', now, 60 * SEC)) emit(ks, now, pvc, 'Warning', 'ProvisioningFailed', `storageclass.storage.k8s.io "${className}" not found`, 'persistentvolume-controller');
      continue;
    }
    const selected = pvc.metadata.annotations?.['volume.kubernetes.io/selected-node'];
    if (sc.volumeBindingMode === 'WaitForFirstConsumer' && !selected) {
      if (rate(pvc.status, 'wffc', now, 60 * SEC)) emit(ks, now, pvc, 'Normal', 'WaitForFirstConsumer', 'waiting for first consumer to be created before binding', 'persistentvolume-controller');
      continue;
    }
    if (rate(pvc.status, 'ext', now, 60 * SEC)) {
      emit(ks, now, pvc, 'Normal', 'ExternalProvisioning', `Waiting for a volume to be created either by the external provisioner '${sc.provisioner}' or manually by the system administrator. If volume creation is delayed, please verify that the provisioner is running and correctly registered.`, 'persistentvolume-controller');
    }
    provision(ks, now, pvc, sc, selected ?? 'devquest-worker');
  }
}

export interface VolumeGate {
  fail?: string;
  /** Node a bound local volume pins the pod to. */
  node?: string;
  /** Claims the scheduler must select a node for (WaitForFirstConsumer). */
  wffc: KObj[];
}

export function volumeGate(ks: KubeState, pod: KObj): VolumeGate {
  const gate: VolumeGate = { wffc: [] };
  for (const v of pod.spec.volumes ?? []) {
    const name = v.persistentVolumeClaim?.claimName;
    if (!name) continue;
    const pvc = getObj(ks, 'PersistentVolumeClaim', pod.metadata.namespace, name);
    if (!pvc) return { fail: `persistentvolumeclaim "${name}" not found`, wffc: [] };
    if (h.isTerminating(pvc)) return { fail: `persistentvolumeclaim "${name}" is being deleted`, wffc: [] };
    if (pvc.status?.phase === 'Bound') {
      const pv = getObj(ks, 'PersistentVolume', undefined, pvc.spec.volumeName);
      const node = pv?.spec.nodeAffinity?.required?.nodeSelectorTerms?.[0]?.matchExpressions?.[0]?.values?.[0];
      if (node) gate.node = node;
      continue;
    }
    const sc = pvc.spec.storageClassName ? getObj(ks, 'StorageClass', undefined, pvc.spec.storageClassName) : undefined;
    if (sc?.volumeBindingMode === 'WaitForFirstConsumer') {
      if (pvc.metadata.annotations?.['volume.kubernetes.io/selected-node']) return { fail: 'waiting for the volume to be provisioned', wffc: [] };
      gate.wffc.push(pvc);
    } else return { fail: 'pod has unbound immediate PersistentVolumeClaims', wffc: [] };
  }
  return gate;
}

/** Kubelet side: the PersistentVolume's data directory for a pod volume (shared by reference). */
export function claimData(ks: KubeState, pod: KObj, claimName: string) {
  const pvc = getObj(ks, 'PersistentVolumeClaim', pod.metadata.namespace, claimName);
  if (!pvc?.spec.volumeName) return undefined;
  return (ks.volumes ??= {})[pvc.spec.volumeName];
}

// ------------------------------------------------------------------ pod anti-affinity

export function antiAffinityBlocks(ks: KubeState, pod: KObj, node: KObj): boolean {
  const terms: J[] = pod.spec.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? [];
  return terms.some((t) => {
    if (t.topologyKey !== 'kubernetes.io/hostname') return false;
    return listObjs(ks, 'Pod', pod.metadata.namespace).some((p) => p !== pod && p.spec.nodeName === node.metadata.name && !h.isTerminating(p) && matches(p.metadata.labels, t.labelSelector));
  });
}

export function antiAffinityPenalty(ks: KubeState, pod: KObj, node: KObj): number {
  const terms: J[] = pod.spec.affinity?.podAntiAffinity?.preferredDuringSchedulingIgnoredDuringExecution ?? [];
  let penalty = 0;
  for (const t of terms) {
    const term = t.podAffinityTerm;
    if (term?.topologyKey !== 'kubernetes.io/hostname') continue;
    const n = listObjs(ks, 'Pod', pod.metadata.namespace).filter((p) => p !== pod && p.spec.nodeName === node.metadata.name && !h.isTerminating(p) && matches(p.metadata.labels, term.labelSelector)).length;
    penalty += n * (t.weight ?? 1);
  }
  return penalty;
}

// ------------------------------------------------------------------ taints: NoExecute eviction

export function taintEviction(ks: KubeState, now: number): void {
  for (const n of listObjs(ks, 'Node')) {
    const taints = (n.spec.taints ?? []).filter((t: J) => t.effect === 'NoExecute');
    if (!taints.length) continue;
    for (const p of listObjs(ks, 'Pod').filter((x) => x.spec.nodeName === n.metadata.name && !h.isTerminating(x))) {
      if (taints.some((t: J) => !h.tolerates(p, t))) {
        emit(ks, now, p, 'Normal', 'TaintManagerEviction', `Marking for deletion Pod ${p.metadata.namespace}/${p.metadata.name}`, 'taint-eviction-controller');
        h.deletePod(ks, now, p);
      }
    }
  }
}

// ------------------------------------------------------------------ statefulsets

function ordinalOf(sts: KObj, pod: KObj): number {
  const m = new RegExp(`^${sts.metadata.name}-(\\d+)$`).exec(pod.metadata.name);
  return m ? Number(m[1]) : -1;
}

export function statefulSetController(ks: KubeState, now: number): void {
  for (const sts of listObjs(ks, 'StatefulSet')) {
    if (h.isTerminating(sts)) continue;
    const ns = sts.metadata.namespace!;
    const name = sts.metadata.name;
    const want = sts.spec.replicas ?? 1;
    const rev = `${name}-${h.templateHash(sts.spec.template)}`;
    const all = ownedBy(ks, 'Pod', sts);
    const live = all.filter((p) => !h.isTerminating(p));
    const byOrd = new Map(live.map((p) => [ordinalOf(sts, p), p]));
    const parallel = sts.spec.podManagementPolicy === 'Parallel';
    const busy = all.some((p) => h.isTerminating(p));
    let created = false;
    for (let i = 0; i < want; i++) {
      const p = byOrd.get(i);
      if (p) {
        if (!parallel && !h.isPodReady(p)) break;
        continue;
      }
      if (busy && !parallel) break;
      // Claims from volumeClaimTemplates: <template>-<sts>-<ordinal>, kept when pods go away.
      const volumes: J[] = [...(sts.spec.template.spec.volumes ?? [])];
      for (const t of sts.spec.volumeClaimTemplates ?? []) {
        const claim = `${t.metadata.name}-${name}-${i}`;
        if (!getObj(ks, 'PersistentVolumeClaim', ns, claim)) {
          const dflt = listObjs(ks, 'StorageClass').find((c) => c.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true');
          putObj(ks, {
            apiVersion: 'v1',
            kind: 'PersistentVolumeClaim',
            metadata: newMeta(ks, now, claim, ns, { labels: { ...(sts.spec.selector?.matchLabels ?? {}) } }),
            spec: { volumeMode: 'Filesystem', ...t.spec, storageClassName: t.spec.storageClassName ?? dflt?.metadata.name },
            status: { phase: 'Pending' },
          });
          emit(ks, now, sts, 'Normal', 'SuccessfulCreate', `create Claim ${claim} Pod ${name}-${i} in StatefulSet ${name} success`, 'statefulset-controller');
        }
        volumes.push({ name: t.metadata.name, persistentVolumeClaim: { claimName: claim } });
      }
      const pod = h.podFromTemplate(ks, now, sts, sts.spec.template, `${name}-${i}`, {
        'apps.kubernetes.io/pod-index': String(i),
        'controller-revision-hash': rev,
        'statefulset.kubernetes.io/pod-name': `${name}-${i}`,
      });
      delete pod.metadata.generateName;
      pod.metadata.generateName = `${name}-`;
      pod.spec.hostname = `${name}-${i}`;
      if (sts.spec.serviceName) pod.spec.subdomain = sts.spec.serviceName;
      if (volumes.length) pod.spec.volumes = volumes;
      putObj(ks, pod);
      emit(ks, now, sts, 'Normal', 'SuccessfulCreate', `create Pod ${name}-${i} in StatefulSet ${name} successful`, 'statefulset-controller');
      created = true;
      if (!parallel) break;
    }
    // Scale down from the highest ordinal, one at a time.
    if (!created && !busy) {
      const extra = live.filter((p) => ordinalOf(sts, p) >= want).sort((a, b) => ordinalOf(sts, b) - ordinalOf(sts, a));
      if (extra.length) {
        h.deletePod(ks, now, extra[0]);
        emit(ks, now, sts, 'Normal', 'SuccessfulDelete', `delete Pod ${extra[0].metadata.name} in StatefulSet ${name} successful`, 'statefulset-controller');
      } else {
        // Rolling update: replace the highest outdated ordinal once everything is ready.
        const partition = sts.spec.updateStrategy?.rollingUpdate?.partition ?? 0;
        const outdated = live.filter((p) => p.metadata.labels?.['controller-revision-hash'] !== rev && ordinalOf(sts, p) >= partition).sort((a, b) => ordinalOf(sts, b) - ordinalOf(sts, a));
        if (outdated.length && sts.spec.updateStrategy?.type !== 'OnDelete' && live.every(h.isPodReady)) {
          h.deletePod(ks, now, outdated[0]);
          emit(ks, now, sts, 'Normal', 'SuccessfulDelete', `delete Pod ${outdated[0].metadata.name} in StatefulSet ${name} successful`, 'statefulset-controller');
        }
      }
    }
    const ready = live.filter(h.isPodReady).length;
    const updated = live.filter((p) => p.metadata.labels?.['controller-revision-hash'] === rev).length;
    sts.status = {
      availableReplicas: ready,
      collisionCount: 0,
      currentReplicas: live.length - (live.length - updated),
      currentRevision: rev,
      observedGeneration: sts.metadata.generation ?? 1,
      readyReplicas: ready,
      replicas: live.length,
      updateRevision: rev,
      updatedReplicas: updated,
    };
    for (const k of ['readyReplicas', 'availableReplicas', 'updatedReplicas', 'currentReplicas']) if (!sts.status[k]) delete sts.status[k];
  }
}

// ------------------------------------------------------------------ cronjobs

export function cronJobController(ks: KubeState, now: number): void {
  for (const cj of listObjs(ks, 'CronJob')) {
    if (h.isTerminating(cj)) continue;
    const st = (cj.status ??= {});
    const jobs = ownedBy(ks, 'Job', cj);
    const done = (j: KObj) => (j.status?.conditions ?? []).find((c: J) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True');
    const active = jobs.filter((j) => !done(j) && !h.isTerminating(j));
    const cron = parseCron(cj.spec.schedule);
    if (cron && !cj.spec.suspend) {
      const from = st.lastScheduleTime ? parseIso(st.lastScheduleTime) : parseIso(cj.metadata.creationTimestamp);
      const times = scheduleTimes(cron, from, now, 5);
      const latest = times[times.length - 1];
      if (latest !== undefined) {
        st.lastScheduleTime = iso(latest);
        const policy = cj.spec.concurrencyPolicy ?? 'Allow';
        if (policy === 'Forbid' && active.length) {
          emit(ks, now, cj, 'Normal', 'JobAlreadyActive', 'Not starting job because prior execution is running and concurrency policy is Forbid', 'cronjob-controller');
        } else {
          if (policy === 'Replace') for (const j of active) removeObj(ks, j);
          const jobName = `${cj.metadata.name}-${Math.floor(latest / 60000)}`;
          if (!getObj(ks, 'Job', cj.metadata.namespace, jobName)) {
            const tpl = cj.spec.jobTemplate;
            const jobUid = newMeta(ks, now, jobName, cj.metadata.namespace).uid;
            const autoLabels = { 'batch.kubernetes.io/controller-uid': jobUid, 'batch.kubernetes.io/job-name': jobName, 'controller-uid': jobUid, 'job-name': jobName };
            putObj(ks, {
              apiVersion: 'batch/v1',
              kind: 'Job',
              metadata: { ...newMeta(ks, now, jobName, cj.metadata.namespace, { labels: { ...(tpl.metadata?.labels ?? {}) }, ownerReferences: [ownerRef(cj)], annotations: { 'batch.kubernetes.io/cronjob-scheduled-timestamp': iso(latest) }, generation: 1 }), uid: jobUid },
              spec: {
                backoffLimit: 6,
                completionMode: 'NonIndexed',
                completions: 1,
                parallelism: 1,
                suspend: false,
                ...tpl.spec,
                selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': jobUid } },
                template: { metadata: { ...(tpl.spec.template.metadata ?? {}), labels: { ...(tpl.spec.template.metadata?.labels ?? {}), ...autoLabels } }, spec: tpl.spec.template.spec },
              },
              status: {},
            });
            emit(ks, now, cj, 'Normal', 'SuccessfulCreate', `Created job ${jobName}`, 'cronjob-controller');
          }
        }
      }
    }
    // History limits.
    const finished = ownedBy(ks, 'Job', cj).filter(done).sort((a, b) => parseIso(a.metadata.creationTimestamp) - parseIso(b.metadata.creationTimestamp));
    for (const [type, limit] of [['Complete', cj.spec.successfulJobsHistoryLimit ?? 3], ['Failed', cj.spec.failedJobsHistoryLimit ?? 1]] as const) {
      const list = finished.filter((j) => done(j)?.type === type);
      for (const j of list.slice(0, Math.max(0, list.length - limit))) {
        for (const p of ownedBy(ks, 'Pod', j)) removeObj(ks, p);
        removeObj(ks, j);
        emit(ks, now, cj, 'Normal', 'SuccessfulDelete', `Deleted job ${j.metadata.name}`, 'cronjob-controller');
      }
    }
    for (const j of finished) {
      if (!j.status._seen) {
        j.status._seen = true;
        emit(ks, now, cj, 'Normal', 'SawCompletedJob', `Saw completed job: ${j.metadata.name}, condition: ${done(j)?.type}`, 'cronjob-controller');
        if (done(j)?.type === 'Complete') st.lastSuccessfulTime = j.status.completionTime;
      }
    }
    const act = ownedBy(ks, 'Job', cj).filter((j) => !done(j));
    if (act.length) st.active = act.map((j) => ({ apiVersion: 'batch/v1', kind: 'Job', name: j.metadata.name, namespace: j.metadata.namespace, resourceVersion: j.metadata.resourceVersion, uid: j.metadata.uid }));
    else delete st.active;
  }
}

// ------------------------------------------------------------------ usage model (metrics-server)

/** The Deployment / StatefulSet a pod belongs to ("ns/name"). */
export function workloadOf(ks: KubeState, pod: KObj): string | null {
  const ref = pod.metadata.ownerReferences?.find((r) => r.controller);
  if (!ref) return null;
  const ns = pod.metadata.namespace;
  if (ref.kind === 'ReplicaSet') {
    const rs = getObj(ks, 'ReplicaSet', ns, ref.name);
    const d = rs?.metadata.ownerReferences?.find((r) => r.kind === 'Deployment');
    return d ? `${ns}/${d.name}` : `${ns}/${ref.name}`;
  }
  return `${ns}/${ref.name}`;
}

const LOAD_RE = /(?:wget|curl)[^;|&]*?https?:\/\/([a-z0-9-]+)(?![a-z0-9-])/;

/** Extra CPU demand (millicores) on a workload: configured load plus load-generator pods hitting its Service. */
export function demandFor(ks: KubeState, workload: string): number {
  let demand = ks.load?.[workload] ?? 0;
  const [ns, name] = workload.split('/');
  for (const gen of listObjs(ks, 'Pod', ns)) {
    if (gen.status?.phase !== 'Running' || h.isTerminating(gen)) continue;
    const cmd = [...(gen.spec.containers[0]?.command ?? []), ...(gen.spec.containers[0]?.args ?? [])].join(' ');
    if (!/while|for /.test(cmd)) continue;
    const m = LOAD_RE.exec(cmd);
    if (!m) continue;
    const svc = getObj(ks, 'Service', ns, m[1]);
    if (!svc?.spec.selector) continue;
    const target = getObj(ks, 'Deployment', ns, name) ?? getObj(ks, 'StatefulSet', ns, name);
    if (target && matches(target.spec.template.metadata?.labels, svc.spec.selector)) demand += 600;
  }
  return demand;
}

/** CPU (millicores) and memory (MiB) a running pod uses right now. */
export function podUsage(ks: KubeState, pod: KObj): { cpu: number; mem: number } {
  let cpu = 0;
  let mem = 0;
  const workload = workloadOf(ks, pod);
  let share = 0;
  if (workload) {
    const demand = demandFor(ks, workload);
    if (demand) {
      const peers = listObjs(ks, 'Pod', pod.metadata.namespace).filter((p) => workloadOf(ks, p) === workload && p.status?.phase === 'Running' && !h.isTerminating(p));
      share = demand / Math.max(1, peers.length);
    }
  }
  for (const [i, c] of (pod.spec.containers ?? []).entries()) {
    const cs = ks.runtime[pod.metadata.uid]?.containers[c.name];
    if (cs?.state !== 'running') continue;
    const img = resolveImage(ks, c.image);
    if (!img.ok) continue;
    const limit = cpuMilli(c.resources?.limits?.cpu) || Infinity;
    cpu += Math.min(limit, (img.image.spec.cpuM ?? 1) + (i === 0 ? share : 0));
    mem += (img.image.spec.memMi ?? 5) + (i === 0 ? Math.round(share / 20) : 0);
  }
  return { cpu: Math.round(cpu), mem };
}

// ------------------------------------------------------------------ HPA

export function hpaController(ks: KubeState, now: number): void {
  for (const hpa of listObjs(ks, 'HorizontalPodAutoscaler')) {
    const st = (hpa.status ??= {});
    if (st._lastSync && now - st._lastSync < 15 * SEC) continue;
    st._lastSync = now;
    const ref = hpa.spec.scaleTargetRef ?? {};
    const ns = hpa.metadata.namespace!;
    const target = getObj(ks, ref.kind === 'StatefulSet' ? 'StatefulSet' : 'Deployment', ns, ref.name);
    const cond = (type: string, status: string, reason: string, message: string) => ({ type, status, reason, message, lastTransitionTime: iso(now) });
    if (!target) {
      st.conditions = [cond('AbleToScale', 'False', 'FailedGetScale', `the HPA controller was unable to get the target's current scale: ${ref.kind === 'StatefulSet' ? 'statefulsets' : 'deployments'}/scale.apps "${ref.name}" not found`)];
      if (rate(st, 'noscale', now, 60 * SEC)) emit(ks, now, hpa, 'Warning', 'FailedGetScale', `${ref.kind === 'StatefulSet' ? 'statefulsets' : 'deployments'}/scale.apps "${ref.name}" not found`, 'horizontal-pod-autoscaler');
      continue;
    }
    const pods = listObjs(ks, 'Pod', ns).filter((p) => matches(p.metadata.labels, target.spec.selector) && p.status?.phase === 'Running' && !h.isTerminating(p));
    const current = target.spec.replicas ?? 1;
    const min = hpa.spec.minReplicas ?? 1;
    const max = hpa.spec.maxReplicas;
    const metrics: J[] = hpa.spec.metrics ?? [];
    let desired = current;
    const currentMetrics: J[] = [];
    let failure: string | null = null;
    let reason = '';
    const ms = getObj(ks, 'Deployment', 'kube-system', 'metrics-server');
    if (!ms || !(ms.status?.availableReplicas > 0)) failure = 'failed to get cpu utilization: unable to get metrics for resource cpu: no metrics returned from resource metrics API';
    for (const m of metrics) {
      if (failure) break;
      if (m.type !== 'Resource') continue;
      const res = m.resource.name;
      let sumUse = 0;
      let sumReq = 0;
      for (const p of pods) {
        for (const c of p.spec.containers) {
          const req = res === 'cpu' ? cpuMilli(c.resources?.requests?.cpu) : memBytes(c.resources?.requests?.memory) / 1024 ** 2;
          if (!req && m.resource.target?.type === 'Utilization') {
            failure = `failed to get ${res} utilization: missing request for ${res} in container ${c.name} of Pod ${p.metadata.name}`;
            break;
          }
          sumReq += req;
        }
        if (failure) break;
        const u = podUsage(ks, p);
        sumUse += res === 'cpu' ? u.cpu : u.mem;
      }
      if (failure) break;
      if (!pods.length) continue;
      if (m.resource.target?.type === 'Utilization') {
        const util = Math.round((sumUse / sumReq) * 100);
        const t = m.resource.target.averageUtilization ?? 80;
        const ratio = util / t;
        const want = Math.abs(ratio - 1) <= 0.1 ? current : Math.ceil(pods.length * ratio);
        if (want > desired || desired === current) desired = want;
        reason = `${res} resource utilization (percentage of request) ${want > current ? 'above' : 'below'} target`;
        currentMetrics.push({ type: 'Resource', resource: { name: res, current: { averageUtilization: util, averageValue: res === 'cpu' ? `${Math.round(sumUse / pods.length)}m` : `${Math.round(sumUse / pods.length)}Mi` } } });
      } else {
        const avg = sumUse / pods.length;
        const t = res === 'cpu' ? cpuMilli(m.resource.target.averageValue) : memBytes(m.resource.target.averageValue) / 1024 ** 2;
        const want = Math.ceil(pods.length * (avg / t));
        desired = Math.max(desired === current ? 0 : desired, want);
        reason = `${res} resource above target`;
        currentMetrics.push({ type: 'Resource', resource: { name: res, current: { averageValue: res === 'cpu' ? `${Math.round(avg)}m` : `${Math.round(avg)}Mi` } } });
      }
    }
    if (failure) {
      st.currentReplicas = target.status?.replicas ?? current;
      st.desiredReplicas = current;
      st.currentMetrics = null;
      st.conditions = [
        cond('AbleToScale', 'True', 'SucceededGetScale', 'the HPA controller was able to get the target\'s current scale'),
        cond('ScalingActive', 'False', 'FailedGetResourceMetric', `the HPA was unable to compute the replica count: ${failure}`),
      ];
      if (rate(st, 'metric', now, 30 * SEC)) emit(ks, now, hpa, 'Warning', 'FailedGetResourceMetric', failure, 'horizontal-pod-autoscaler');
      if (rate(st, 'compute', now, 30 * SEC)) emit(ks, now, hpa, 'Warning', 'FailedComputeMetricsReplicas', `invalid metrics (1 invalid out of 1), first error is: failed to get ${failure.includes('memory') ? 'memory' : 'cpu'} resource metric value: ${failure}`, 'horizontal-pod-autoscaler');
      continue;
    }
    let limited = '';
    if (desired > max) {
      desired = max;
      limited = 'TooManyReplicas';
    }
    if (desired < min) {
      desired = min;
      limited = 'TooFewReplicas';
    }
    // Scale-down stabilization: use the highest recommendation of the last 5 minutes.
    const recs: [number, number][] = (st._recs ?? []).filter(([t]: [number, number]) => now - t < 300 * SEC);
    recs.push([now, desired]);
    st._recs = recs;
    if (desired < current) desired = Math.min(current, Math.max(...recs.map(([, d]) => d)));
    if (desired !== current) {
      target.spec.replicas = desired;
      target.metadata.generation = (target.metadata.generation ?? 1) + 1;
      st.lastScaleTime = iso(now);
      emit(ks, now, hpa, 'Normal', 'SuccessfulRescale', `New size: ${desired}; reason: ${desired > current ? reason || 'cpu resource utilization (percentage of request) above target' : 'All metrics below target'}`, 'horizontal-pod-autoscaler');
    }
    st.currentReplicas = target.status?.replicas ?? current;
    st.desiredReplicas = desired;
    st.currentMetrics = currentMetrics;
    st.conditions = [
      cond('AbleToScale', 'True', desired !== current ? 'SucceededRescale' : 'ReadyForNewScale', desired !== current ? `the HPA controller was able to update the target scale to ${desired}` : 'recommended size matches current size'),
      cond('ScalingActive', 'True', 'ValidMetricFound', 'the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)'),
      limited
        ? cond('ScalingLimited', 'True', limited, limited === 'TooManyReplicas' ? 'the desired replica count is more than the maximum replica count' : 'the desired replica count is less than the minimum replica count')
        : cond('ScalingLimited', 'False', 'DesiredWithinRange', 'the desired count is within the acceptable range'),
    ];
  }
}

// ------------------------------------------------------------------ ingress status

export function isNginxClass(ing: KObj): boolean {
  return ing.spec?.ingressClassName === 'nginx' || ing.metadata.annotations?.['kubernetes.io/ingress.class'] === 'nginx';
}

/** ingress-nginx (as kind deploys it) publishes "localhost" as the address of the Ingresses it serves. */
export function ingressStatusController(ks: KubeState, now: number): void {
  const ctrl = getObj(ks, 'Deployment', 'ingress-nginx', 'ingress-nginx-controller');
  const up = (ctrl?.status?.availableReplicas ?? 0) > 0;
  for (const ing of listObjs(ks, 'Ingress')) {
    const served = up && isNginxClass(ing);
    const want = served ? { ingress: [{ hostname: 'localhost' }] } : {};
    if (JSON.stringify(ing.status?.loadBalancer ?? {}) !== JSON.stringify(want)) {
      ing.status = { loadBalancer: want };
      if (served) emit(ks, now, ing, 'Normal', 'Sync', 'Scheduled for sync', 'nginx-ingress-controller');
    }
  }
}
