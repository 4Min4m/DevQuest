/**
 * The control plane and kubelets, simulated in fixed time steps up to "now":
 * deployment / replicaset / daemonset / job controllers, the scheduler, kubelets
 * (image pulls, config, crashes and back-off, OOM, probes), endpoints and GC.
 */
import type { SimState } from '../state';
import { joinPath, normalize } from '../vfs/path';
import type { DirNode } from '../vfs/types';
import { makeDir, Vfs } from '../vfs/vfs';
import {
  bump,
  clusterOf,
  emit,
  getObj,
  infoOf,
  iso,
  listObjs,
  matches,
  newMeta,
  NODES,
  ownedBy,
  ownerRef,
  parseIso,
  putObj,
  removeObj,
  suffix,
} from './cluster';
import { fullRef, imageFs, resolveImage, ResolvedImage } from './images';
import {
  antiAffinityBlocks,
  antiAffinityPenalty,
  claimData,
  cronJobController,
  hpaController,
  ingressStatusController,
  serviceAccountController,
  setHelpers,
  statefulSetController,
  storageController,
  taintEviction,
  volumeGate,
} from './extra';
import { podShell, podState } from './podshell';
import { cpuMilli, intOrPercent, memBytes } from './quantity';
import type { AppSpec, ContainerRun, ContainerRuntime, J, KObj, KubeState, PodRuntime } from './types';

const SEC = 1000;
/** "Never restart" (a finite number so the state stays JSON-serializable). */
const NEVER = Number.MAX_SAFE_INTEGER;

// ------------------------------------------------------------------ helpers

export const isTerminating = (o: KObj) => !!o.metadata.deletionTimestamp;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

export function templateHash(template: J): string {
  return suffix(JSON.stringify(template), 10);
}

export function podsOfNode(ks: KubeState, node: string): KObj[] {
  return listObjs(ks, 'Pod').filter((p) => p.spec.nodeName === node && !['Succeeded', 'Failed'].includes(p.status?.phase));
}

export function podRequests(pod: KObj): { cpu: number; mem: number } {
  let cpu = 0;
  let mem = 0;
  for (const c of pod.spec.containers ?? []) {
    const r = c.resources?.requests ?? c.resources?.limits ?? {};
    cpu += cpuMilli(r.cpu);
    mem += memBytes(r.memory);
  }
  return { cpu, mem };
}

export function isPodReady(p: KObj): boolean {
  return !isTerminating(p) && (p.status?.conditions ?? []).some((c: J) => c.type === 'Ready' && c.status === 'True');
}

// ------------------------------------------------------------------ pods from templates

export function podFromTemplate(ks: KubeState, now: number, owner: KObj, template: J, name: string, extraLabels: Record<string, string>): KObj {
  const meta = newMeta(ks, now, name, owner.metadata.namespace, {
    labels: { ...(template.metadata?.labels ?? {}), ...extraLabels },
    ownerReferences: [ownerRef(owner)],
    generateName: name.replace(/[^-]+$/, ''),
  });
  if (template.metadata?.annotations) meta.annotations = clone(template.metadata.annotations);
  const spec = clone(template.spec);
  spec.serviceAccountName ??= 'default';
  spec.tolerations = [
    ...(spec.tolerations ?? []),
    { effect: 'NoExecute', key: 'node.kubernetes.io/not-ready', operator: 'Exists', tolerationSeconds: 300 },
    { effect: 'NoExecute', key: 'node.kubernetes.io/unreachable', operator: 'Exists', tolerationSeconds: 300 },
  ];
  return { apiVersion: 'v1', kind: 'Pod', metadata: meta, spec, status: { phase: 'Pending', qosClass: qosClass(spec) } };
}

export function qosClass(spec: J): string {
  const cs = spec.containers ?? [];
  const all = cs.every((c: J) => c.resources?.limits?.cpu && c.resources?.limits?.memory && (!c.resources.requests || (c.resources.requests.cpu ?? c.resources.limits.cpu) === c.resources.limits.cpu));
  if (cs.length && all) return 'Guaranteed';
  if (cs.some((c: J) => c.resources?.requests || c.resources?.limits)) return 'Burstable';
  return 'BestEffort';
}

export function deletePod(ks: KubeState, now: number, pod: KObj): void {
  if (isTerminating(pod)) return;
  pod.metadata.deletionTimestamp = iso(now);
  (pod.metadata as J).deletionGracePeriodSeconds = pod.spec.terminationGracePeriodSeconds ?? 30;
  bump(ks, pod);
}

// ------------------------------------------------------------------ deployments

function revisionOf(o: KObj): number {
  return Number(o.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
}

function availableOf(rs: KObj): number {
  return rs.status?.availableReplicas ?? 0;
}

function scaleRs(ks: KubeState, now: number, d: KObj, rs: KObj, to: number): void {
  const from = rs.spec.replicas ?? 0;
  if (from === to) return;
  rs.spec.replicas = to;
  rs.metadata.annotations = { ...(rs.metadata.annotations ?? {}), 'deployment.kubernetes.io/desired-replicas': String(d.spec.replicas ?? 1) };
  bump(ks, rs);
  emit(ks, now, d, 'Normal', 'ScalingReplicaSet', `Scaled ${to > from ? 'up' : 'down'} replica set ${rs.metadata.name} from ${from} to ${to}`, 'deployment-controller');
}

function deploymentController(ks: KubeState, now: number): void {
  for (const d of listObjs(ks, 'Deployment')) {
    if (isTerminating(d)) continue;
    const rss = ownedBy(ks, 'ReplicaSet', d);
    const hash = templateHash(d.spec.template);
    let newRs = rss.find((r) => r.metadata.labels?.['pod-template-hash'] === hash);
    const maxRev = Math.max(0, ...rss.map(revisionOf));
    if (!newRs) {
      const labels = { ...(d.spec.template.metadata?.labels ?? {}), 'pod-template-hash': hash };
      const template = clone(d.spec.template);
      template.metadata = { ...(template.metadata ?? {}), labels };
      newRs = {
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        metadata: newMeta(ks, now, `${d.metadata.name}-${hash}`, d.metadata.namespace, {
          labels,
          annotations: {
            'deployment.kubernetes.io/desired-replicas': String(d.spec.replicas ?? 1),
            'deployment.kubernetes.io/max-replicas': String((d.spec.replicas ?? 1) + 1),
            'deployment.kubernetes.io/revision': String(maxRev + 1),
            ...(d.metadata.annotations?.['kubernetes.io/change-cause'] ? { 'kubernetes.io/change-cause': d.metadata.annotations['kubernetes.io/change-cause'] } : {}),
          },
          ownerReferences: [ownerRef(d)],
          generation: 1,
        }),
        spec: { replicas: 0, selector: { matchLabels: { ...(d.spec.selector?.matchLabels ?? {}), 'pod-template-hash': hash } }, template },
        status: { replicas: 0, observedGeneration: 1 },
      };
      putObj(ks, newRs);
      rss.push(newRs);
    } else if (revisionOf(newRs) < maxRev) {
      // Rolling back to an older template: that ReplicaSet becomes the newest revision.
      newRs.metadata.annotations!['deployment.kubernetes.io/revision'] = String(maxRev + 1);
      if (d.metadata.annotations?.['kubernetes.io/change-cause']) newRs.metadata.annotations!['kubernetes.io/change-cause'] = d.metadata.annotations['kubernetes.io/change-cause'];
    }
    d.metadata.annotations = { ...(d.metadata.annotations ?? {}), 'deployment.kubernetes.io/revision': String(revisionOf(newRs)) };
    const desired = d.spec.replicas ?? 1;
    const olds = rss.filter((r) => r !== newRs).sort((a, b) => revisionOf(a) - revisionOf(b));
    if (!d.spec.paused) {
      if (d.spec.strategy?.type === 'Recreate') {
        for (const o of olds) scaleRs(ks, now, d, o, 0);
        const oldPods = olds.flatMap((o) => ownedBy(ks, 'Pod', o));
        if (!oldPods.length) scaleRs(ks, now, d, newRs, desired);
      } else {
        const ru = d.spec.strategy?.rollingUpdate ?? {};
        const maxSurge = intOrPercent(ru.maxSurge, desired, true, '25%');
        let maxUnavailable = intOrPercent(ru.maxUnavailable, desired, false, '25%');
        if (maxSurge === 0 && maxUnavailable === 0) maxUnavailable = 1;
        const oldTotal = olds.reduce((n, o) => n + (o.spec.replicas ?? 0), 0);
        const cur = newRs.spec.replicas ?? 0;
        if (cur > desired) scaleRs(ks, now, d, newRs, desired);
        else if (cur < desired) {
          const room = desired + maxSurge - (oldTotal + cur);
          if (room > 0) scaleRs(ks, now, d, newRs, Math.min(desired, cur + room));
        }
        // Scale old ReplicaSets down without dropping below the availability floor.
        const minAvailable = desired - maxUnavailable;
        let available = availableOf(newRs) + olds.reduce((n, o) => n + availableOf(o), 0);
        for (const o of olds) {
          const reps = o.spec.replicas ?? 0;
          if (!reps) continue;
          const unhealthy = Math.max(0, reps - availableOf(o));
          const healthyRemovable = Math.max(0, Math.min(reps - unhealthy, available - minAvailable));
          const removable = unhealthy + healthyRemovable;
          if (removable > 0) {
            scaleRs(ks, now, d, o, reps - removable);
            available -= healthyRemovable;
          }
        }
      }
    }
    // Keep revisionHistoryLimit old ReplicaSets.
    const limit = d.spec.revisionHistoryLimit ?? 10;
    const idle = olds.filter((o) => (o.spec.replicas ?? 0) === 0 && !ownedBy(ks, 'Pod', o).length);
    for (const o of idle.slice(0, Math.max(0, idle.length - limit))) removeObj(ks, o);
  }
}

function deploymentStatus(ks: KubeState, now: number): void {
  for (const d of listObjs(ks, 'Deployment')) {
    const rss = ownedBy(ks, 'ReplicaSet', d);
    const hash = templateHash(d.spec.template);
    const newRs = rss.find((r) => r.metadata.labels?.['pod-template-hash'] === hash);
    const desired = d.spec.replicas ?? 1;
    const sum = (f: (r: KObj) => number) => rss.reduce((n, r) => n + f(r), 0);
    const replicas = sum((r) => r.status?.replicas ?? 0);
    const ready = sum((r) => r.status?.readyReplicas ?? 0);
    const available = sum((r) => r.status?.availableReplicas ?? 0);
    const updated = newRs?.status?.replicas ?? 0;
    const ru = d.spec.strategy?.rollingUpdate ?? {};
    const maxUnavailable = d.spec.strategy?.type === 'Recreate' ? desired : intOrPercent(ru.maxUnavailable, desired, false, '25%');
    const prev = d.status ?? {};
    const complete = updated === desired && replicas === desired && available === desired && (newRs?.status?.availableReplicas ?? 0) === desired;
    const sig = `${updated}/${available}/${ready}/${replicas}`;
    const lastProgress = prev._progressSig === sig ? (prev._lastProgress ?? now) : now;
    const deadline = (d.spec.progressDeadlineSeconds ?? 600) * SEC;
    let progressing: J;
    if (complete) progressing = { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable', message: `ReplicaSet "${newRs?.metadata.name}" has successfully progressed.` };
    else if (now - lastProgress > deadline) progressing = { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: `ReplicaSet "${newRs?.metadata.name}" has timed out progressing.` };
    else progressing = { type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated', message: `ReplicaSet "${newRs?.metadata.name}" is progressing.` };
    const availableCond =
      available >= desired - maxUnavailable
        ? { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable', message: 'Deployment has minimum availability.' }
        : { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', message: 'Deployment does not have minimum availability.' };
    const keep = (c: J) => {
      const old = (prev.conditions ?? []).find((x: J) => x.type === c.type);
      const changed = !old || old.status !== c.status || old.reason !== c.reason;
      return { ...c, lastTransitionTime: changed ? iso(now) : old.lastTransitionTime, lastUpdateTime: iso(now) };
    };
    d.status = {
      observedGeneration: d.metadata.generation ?? 1,
      replicas,
      updatedReplicas: updated,
      readyReplicas: ready,
      availableReplicas: available,
      ...(desired - available > 0 ? { unavailableReplicas: Math.max(0, replicas - available) || desired - available } : {}),
      conditions: [keep(availableCond), keep(progressing)],
      _progressSig: sig,
      _lastProgress: lastProgress,
    };
    for (const k of ['readyReplicas', 'availableReplicas', 'updatedReplicas', 'replicas']) if (!d.status[k]) delete d.status[k];
  }
}

// ------------------------------------------------------------------ replicasets

function replicaSetController(ks: KubeState, now: number): void {
  for (const rs of listObjs(ks, 'ReplicaSet')) {
    if (isTerminating(rs)) continue;
    const pods = ownedBy(ks, 'Pod', rs).filter((p) => !isTerminating(p) && !['Succeeded', 'Failed'].includes(p.status?.phase));
    const want = rs.spec.replicas ?? 1;
    if (pods.length < want) {
      for (let i = pods.length; i < want; i++) {
        const name = `${rs.metadata.name}-${suffix(`${rs.metadata.uid}/${ks.seq}`, 5)}`;
        const pod = podFromTemplate(ks, now, rs, rs.spec.template, name, {});
        putObj(ks, pod);
        emit(ks, now, rs, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, 'replicaset-controller');
      }
    } else if (pods.length > want) {
      const rank = (p: KObj) => (!p.spec.nodeName ? 0 : !isPodReady(p) ? 1 : 2);
      const victims = [...pods].sort((a, b) => rank(a) - rank(b) || parseIso(b.metadata.creationTimestamp) - parseIso(a.metadata.creationTimestamp)).slice(0, pods.length - want);
      for (const v of victims) {
        deletePod(ks, now, v);
        emit(ks, now, rs, 'Normal', 'SuccessfulDelete', `Deleted pod: ${v.metadata.name}`, 'replicaset-controller');
      }
    }
  }
}

function replicaSetStatus(ks: KubeState): void {
  for (const rs of listObjs(ks, 'ReplicaSet')) {
    const pods = ownedBy(ks, 'Pod', rs).filter((p) => !isTerminating(p));
    const ready = pods.filter(isPodReady).length;
    rs.status = { replicas: pods.length, fullyLabeledReplicas: pods.length, readyReplicas: ready, availableReplicas: ready, observedGeneration: rs.metadata.generation ?? 1 };
    for (const k of ['readyReplicas', 'availableReplicas', 'fullyLabeledReplicas']) if (!rs.status[k]) delete rs.status[k];
  }
}

// ------------------------------------------------------------------ daemonsets

export function tolerates(pod: J, taint: J): boolean {
  return (pod.spec?.tolerations ?? []).some(
    (t: J) => (t.operator === 'Exists' && !t.key) || (t.key === taint.key && (t.operator === 'Exists' || t.value === taint.value) && (!t.effect || t.effect === taint.effect)),
  );
}

function daemonSetController(ks: KubeState, now: number): void {
  for (const ds of listObjs(ks, 'DaemonSet')) {
    if (isTerminating(ds)) continue;
    const hash = templateHash(ds.spec.template);
    const pods = ownedBy(ks, 'Pod', ds).filter((p) => !isTerminating(p));
    const nodes = listObjs(ks, 'Node').filter((n) => {
      const fake = { spec: ds.spec.template.spec };
      if ((n.spec.taints ?? []).some((t: J) => t.effect !== 'PreferNoSchedule' && !tolerates(fake, t))) return false;
      return matchesNodeSelector(n, ds.spec.template.spec);
    });
    let status = { desired: nodes.length, current: 0, ready: 0, updated: 0 };
    for (const n of nodes) {
      const mine = pods.filter((p) => p.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms?.[0]?.matchFields?.[0]?.values?.[0] === n.metadata.name);
      if (!mine.length) {
        const name = `${ds.metadata.name}-${suffix(`${ds.metadata.uid}/${n.metadata.name}/${ks.seq}`, 5)}`;
        const pod = podFromTemplate(ks, now, ds, ds.spec.template, name, { 'controller-revision-hash': hash, 'pod-template-generation': String(ds.metadata.generation ?? 1) });
        pod.spec.affinity = {
          nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [n.metadata.name] }] }] } },
        };
        pod.spec.tolerations.push({ effect: 'NoSchedule', key: 'node.kubernetes.io/disk-pressure', operator: 'Exists' });
        putObj(ks, pod);
        emit(ks, now, ds, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, 'daemonset-controller');
        continue;
      }
      status.current++;
      if (mine.some(isPodReady)) status.ready++;
      if (mine.some((p) => p.metadata.labels?.['controller-revision-hash'] === hash)) status.updated++;
    }
    // Rolling update: replace one outdated pod at a time once everything else is ready.
    const outdated = pods.filter((p) => p.metadata.labels?.['controller-revision-hash'] !== hash);
    if (outdated.length && status.ready >= status.current) {
      deletePod(ks, now, outdated[0]);
      emit(ks, now, ds, 'Normal', 'SuccessfulDelete', `Deleted pod: ${outdated[0].metadata.name}`, 'daemonset-controller');
    }
    status = { ...status };
    ds.status = {
      currentNumberScheduled: status.current,
      desiredNumberScheduled: status.desired,
      numberAvailable: status.ready,
      numberMisscheduled: 0,
      numberReady: status.ready,
      observedGeneration: ds.metadata.generation ?? 1,
      updatedNumberScheduled: status.updated,
    };
  }
}

// ------------------------------------------------------------------ jobs

function jobController(ks: KubeState, now: number): void {
  for (const job of listObjs(ks, 'Job')) {
    if (isTerminating(job)) continue;
    const st = (job.status ??= {});
    if ((st.conditions ?? []).some((c: J) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True')) continue;
    const pods = ownedBy(ks, 'Pod', job);
    const succeeded = pods.filter((p) => p.status?.phase === 'Succeeded').length;
    const failedPods = pods.filter((p) => p.status?.phase === 'Failed').length;
    const restarts = pods.reduce((n, p) => n + (p.status?.containerStatuses ?? []).reduce((m: number, c: J) => m + c.restartCount, 0), 0);
    const failed = failedPods + restarts;
    const active = pods.filter((p) => !isTerminating(p) && !['Succeeded', 'Failed'].includes(p.status?.phase));
    const completions = job.spec.completions ?? 1;
    const parallelism = job.spec.parallelism ?? 1;
    const backoffLimit = job.spec.backoffLimit ?? 6;
    st.startTime ??= iso(now);
    if (succeeded >= completions) {
      st.completionTime = iso(now);
      st.conditions = [
        { type: 'SuccessCriteriaMet', status: 'True', lastProbeTime: iso(now), lastTransitionTime: iso(now) },
        { type: 'Complete', status: 'True', lastProbeTime: iso(now), lastTransitionTime: iso(now) },
      ];
      emit(ks, now, job, 'Normal', 'Completed', 'Job completed', 'job-controller');
    } else if (failed > backoffLimit) {
      for (const p of active) deletePod(ks, now, p);
      st.conditions = [
        { type: 'FailureTarget', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', lastProbeTime: iso(now), lastTransitionTime: iso(now) },
        { type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', lastProbeTime: iso(now), lastTransitionTime: iso(now) },
      ];
      emit(ks, now, job, 'Warning', 'BackoffLimitExceeded', 'Job has reached the specified backoff limit', 'job-controller');
    } else {
      const want = Math.min(parallelism, completions - succeeded) - active.length;
      for (let i = 0; i < want; i++) {
        const name = `${job.metadata.name}-${suffix(`${job.metadata.uid}/${ks.seq}`, 5)}`;
        const pod = podFromTemplate(ks, now, job, job.spec.template, name, {
          'batch.kubernetes.io/controller-uid': job.metadata.uid,
          'batch.kubernetes.io/job-name': job.metadata.name,
          'controller-uid': job.metadata.uid,
          'job-name': job.metadata.name,
        });
        putObj(ks, pod);
        emit(ks, now, job, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, 'job-controller');
      }
    }
    st.active = active.length || undefined;
    st.succeeded = succeeded || undefined;
    st.failed = failed || undefined;
    st.ready = active.filter(isPodReady).length;
    for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
  }
}

// ------------------------------------------------------------------ scheduler

export function matchesNodeSelector(node: KObj, spec: J): boolean {
  for (const [k, v] of Object.entries(spec.nodeSelector ?? {})) if (node.metadata.labels?.[k] !== v) return false;
  const terms = spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  if (terms?.length) {
    const ok = terms.some((t: J) => {
      for (const f of t.matchFields ?? []) if (f.key === 'metadata.name' && !f.values.includes(node.metadata.name)) return false;
      for (const e of t.matchExpressions ?? []) {
        const v = node.metadata.labels?.[e.key];
        if (e.operator === 'In' && !e.values.includes(v)) return false;
        if (e.operator === 'NotIn' && v !== undefined && e.values.includes(v)) return false;
        if (e.operator === 'Exists' && v === undefined) return false;
        if (e.operator === 'DoesNotExist' && v !== undefined) return false;
      }
      return true;
    });
    if (!ok) return false;
  }
  return true;
}

function scheduler(ks: KubeState, now: number): void {
  const nodes = listObjs(ks, 'Node');
  for (const pod of listObjs(ks, 'Pod')) {
    if (pod.spec.nodeName || isTerminating(pod)) continue;
    const gate = volumeGate(ks, pod);
    if (gate.fail) {
      if (gate.fail.startsWith('waiting')) continue;
      const msg = `0/${nodes.length} nodes are available: ${gate.fail}. preemption: 0/${nodes.length} nodes are available: ${nodes.length} Preemption is not helpful for scheduling.`;
      const last = (pod.status as J)._lastSchedAttempt ?? 0;
      if (now - last >= 60 * SEC || pod.status.conditions?.[0]?.message !== msg) {
        emit(ks, now, pod, 'Warning', 'FailedScheduling', msg, 'default-scheduler');
        pod.status = { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: msg, lastProbeTime: null, lastTransitionTime: iso(now) }], qosClass: pod.status.qosClass, _lastSchedAttempt: now };
      }
      continue;
    }
    const req = podRequests(pod);
    const reasons: Record<string, number> = {};
    const fail = (r: string) => (reasons[r] = (reasons[r] ?? 0) + 1);
    let notHelpful = 0;
    const fits: { node: KObj; score: number }[] = [];
    for (const n of nodes) {
      if (n.spec.unschedulable) {
        fail('node(s) were unschedulable');
        notHelpful++;
        continue;
      }
      const taint = (n.spec.taints ?? []).find((t: J) => (t.effect === 'NoSchedule' || t.effect === 'NoExecute') && !tolerates(pod, t));
      if (taint) {
        fail(`node(s) had untolerated taint {${taint.key}: ${taint.value ?? ''}}`);
        notHelpful++;
        continue;
      }
      if (!matchesNodeSelector(n, pod.spec)) {
        fail("node(s) didn't match Pod's node affinity/selector");
        notHelpful++;
        continue;
      }
      if (gate.node && gate.node !== n.metadata.name) {
        fail('node(s) had volume node affinity conflict');
        notHelpful++;
        continue;
      }
      if (antiAffinityBlocks(ks, pod, n)) {
        fail("node(s) didn't match pod anti-affinity rules");
        notHelpful++;
        continue;
      }
      const used = podsOfNode(ks, n.metadata.name).reduce((a, p) => {
        const r = podRequests(p);
        return { cpu: a.cpu + r.cpu, mem: a.mem + r.mem };
      }, { cpu: 0, mem: 0 });
      const cpuFree = cpuMilli(n.status.allocatable.cpu) - used.cpu;
      const memFree = memBytes(n.status.allocatable.memory) - used.mem;
      let bad = false;
      if (req.cpu > cpuFree) {
        fail('Insufficient cpu');
        bad = true;
      }
      if (req.mem > memFree) {
        fail('Insufficient memory');
        bad = true;
      }
      if (bad) continue;
      // Least-allocated plus spreading pods of the same owner across nodes (default topology spread).
      const owner = pod.metadata.ownerReferences?.[0]?.uid;
      const siblings = owner ? podsOfNode(ks, n.metadata.name).filter((p) => p.metadata.ownerReferences?.[0]?.uid === owner).length : 0;
      fits.push({ node: n, score: antiAffinityPenalty(ks, pod, n) * 100 + siblings * 10 + podsOfNode(ks, n.metadata.name).length * 0.1 + used.cpu / cpuMilli(n.status.allocatable.cpu) + used.mem / memBytes(n.status.allocatable.memory) });
    }
    if (!fits.length) {
      const parts = Object.entries(reasons)
        .map(([r, n]) => `${n} ${r}`)
        .sort();
      const helpful = nodes.length - notHelpful;
      const pre = [notHelpful ? `${notHelpful} Preemption is not helpful for scheduling` : '', helpful ? `${helpful} No preemption victims found for incoming pod` : ''].filter(Boolean).join(', ');
      const msg = `0/${nodes.length} nodes are available: ${parts.join(', ')}. preemption: 0/${nodes.length} nodes are available: ${pre}.`;
      const last = (pod.status as J)._lastSchedAttempt ?? 0;
      if (now - last >= 60 * SEC || pod.status.conditions?.[0]?.message !== msg) {
        emit(ks, now, pod, 'Warning', 'FailedScheduling', msg, 'default-scheduler');
        pod.status = { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: msg, lastProbeTime: null, lastTransitionTime: iso(now) }], qosClass: pod.status.qosClass, _lastSchedAttempt: now };
      }
      continue;
    }
    fits.sort((a, b) => a.score - b.score || (a.node.metadata.name < b.node.metadata.name ? -1 : 1));
    const target = fits[0].node.metadata.name;
    if (gate.wffc.length) {
      // WaitForFirstConsumer: pick the node, let the provisioner create the volume there first.
      for (const pvc of gate.wffc) pvc.metadata.annotations = { ...(pvc.metadata.annotations ?? {}), 'volume.kubernetes.io/selected-node': target };
      continue;
    }
    pod.spec.nodeName = target;
    bump(ks, pod);
    emit(ks, now, pod, 'Normal', 'Scheduled', `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${target}`, 'default-scheduler');
    pod.status = { ...pod.status, conditions: [{ type: 'PodScheduled', status: 'True', lastProbeTime: null, lastTransitionTime: iso(now) }] };
    delete (pod.status as J)._lastSchedAttempt;
  }
}

// ------------------------------------------------------------------ kubelet

function emptyContainer(): ContainerRuntime {
  return { state: 'waiting', reason: 'ContainerCreating', restartCount: 0, runs: [], imagePulled: false, pullFailures: 0, nextAttemptAt: 0, ready: false, started: false, liveFails: 0, readyFails: 0, startupOk: false, startupFails: 0, nextProbeAt: {}, listen: [], answersFrom: 0, env: {} };
}

const b64decode = (s: string) => {
  try {
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return s;
  }
};

/** Resolve a container's environment; returns an error message like kubelet's when a reference is missing. */
export function containerEnv(ks: KubeState, pod: KObj, c: J, image?: AppSpec): { env: Record<string, string> } | { error: string } {
  const ns = pod.metadata.namespace!;
  const env: Record<string, string> = { ...(image?.env ?? {}) };
  for (const from of c.envFrom ?? []) {
    if (from.configMapRef) {
      const cm = getObj(ks, 'ConfigMap', ns, from.configMapRef.name);
      if (!cm) {
        if (from.configMapRef.optional) continue;
        return { error: `configmap "${from.configMapRef.name}" not found` };
      }
      for (const [k, v] of Object.entries(cm.data ?? {})) env[(from.prefix ?? '') + k] = v;
    }
    if (from.secretRef) {
      const s = getObj(ks, 'Secret', ns, from.secretRef.name);
      if (!s) {
        if (from.secretRef.optional) continue;
        return { error: `secret "${from.secretRef.name}" not found` };
      }
      for (const [k, v] of Object.entries(s.data ?? {})) env[(from.prefix ?? '') + k] = b64decode(v);
    }
  }
  for (const e of c.env ?? []) {
    if (e.value !== undefined) env[e.name] = String(e.value).replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (m: string, k: string) => env[k] ?? m);
    else if (e.valueFrom?.configMapKeyRef) {
      const ref = e.valueFrom.configMapKeyRef;
      const cm = getObj(ks, 'ConfigMap', ns, ref.name);
      if (!cm) {
        if (ref.optional) continue;
        return { error: `configmap "${ref.name}" not found` };
      }
      if (cm.data?.[ref.key] === undefined) {
        if (ref.optional) continue;
        return { error: `couldn't find key ${ref.key} in ConfigMap ${ns}/${ref.name}` };
      }
      env[e.name] = cm.data[ref.key];
    } else if (e.valueFrom?.secretKeyRef) {
      const ref = e.valueFrom.secretKeyRef;
      const s = getObj(ks, 'Secret', ns, ref.name);
      if (!s) {
        if (ref.optional) continue;
        return { error: `secret "${ref.name}" not found` };
      }
      if (s.data?.[ref.key] === undefined) {
        if (ref.optional) continue;
        return { error: `couldn't find key ${ref.key} in Secret ${ns}/${ref.name}` };
      }
      env[e.name] = b64decode(s.data[ref.key]);
    } else if (e.valueFrom?.fieldRef) {
      const path = e.valueFrom.fieldRef.fieldPath;
      const v =
        path === 'metadata.name' ? pod.metadata.name
        : path === 'metadata.namespace' ? ns
        : path === 'spec.nodeName' ? pod.spec.nodeName
        : path === 'status.podIP' ? pod.status?.podIP
        : path === 'status.hostIP' ? pod.status?.hostIP
        : path === 'spec.serviceAccountName' ? pod.spec.serviceAccountName
        : undefined;
      env[e.name] = v ?? '';
    }
  }
  return { env };
}

/** Volumes that reference missing ConfigMaps / Secrets (kubelet can't mount them). */
function missingVolume(ks: KubeState, pod: KObj): string | null {
  for (const v of pod.spec.volumes ?? []) {
    if (v.configMap && !v.configMap.optional && !getObj(ks, 'ConfigMap', pod.metadata.namespace, v.configMap.name)) {
      return `MountVolume.SetUp failed for volume "${v.name}" : configmap "${v.configMap.name}" not found`;
    }
    if (v.secret && !v.secret.optional && !getObj(ks, 'Secret', pod.metadata.namespace, v.secret.secretName)) {
      return `MountVolume.SetUp failed for volume "${v.name}" : secret "${v.secret.secretName}" not found`;
    }
  }
  return null;
}

/** Write ConfigMap / Secret volume contents into the container filesystem (kept in sync like kubelet does). */
function syncMounts(ks: KubeState, pod: KObj, c: J, fs: DirNode): void {
  const vfs = new Vfs(fs, { name: 'root', groups: ['root'] });
  for (const m of c.volumeMounts ?? []) {
    const v = (pod.spec.volumes ?? []).find((x: J) => x.name === m.name);
    if (!v) continue;
    if (v.persistentVolumeClaim) {
      const data = claimData(ks, pod, v.persistentVolumeClaim.claimName);
      if (!data) continue;
      const target = normalize(m.mountPath);
      const parentPath = target.replace(/\/[^/]+$/, '') || '/';
      const leaf = target.split('/').pop()!;
      try {
        if (!vfs.exists(parentPath)) vfs.mkdir(parentPath, { parents: true });
        const parent = vfs.lookup(parentPath) as DirNode;
        if (parent.children[leaf] !== data) parent.children[leaf] = data;
      } catch {
        /* ignore */
      }
      continue;
    }
    let files: Record<string, string> | null = null;
    if (v.configMap) files = { ...(getObj(ks, 'ConfigMap', pod.metadata.namespace, v.configMap.name)?.data ?? {}) };
    else if (v.secret) {
      const s = getObj(ks, 'Secret', pod.metadata.namespace, v.secret.secretName);
      files = Object.fromEntries(Object.entries(s?.data ?? {}).map(([k, val]) => [k, b64decode(val)]));
    } else if (v.emptyDir) files = {};
    if (!files) continue;
    if (v.configMap?.items || v.secret?.items) {
      const items = v.configMap?.items ?? v.secret?.items;
      const picked: Record<string, string> = {};
      for (const it of items) if (files[it.key] !== undefined) picked[it.path] = files[it.key];
      files = picked;
    }
    const target = normalize(m.mountPath);
    try {
      if (m.subPath) {
        const content = files[m.subPath];
        if (content !== undefined) {
          vfs.mkdir(target.replace(/\/[^/]+$/, '') || '/', { parents: true });
          vfs.writeFile(target, content);
        }
        continue;
      }
      if (vfs.exists(target) && !v.emptyDir) vfs.remove(target, { recursive: true });
      if (!vfs.exists(target)) vfs.mkdir(target, { parents: true });
      for (const [name, content] of Object.entries(files)) {
        const p = joinPath(target, name);
        vfs.mkdir(p.replace(/\/[^/]+$/, ''), { parents: true });
        vfs.writeFile(p, content);
      }
    } catch {
      /* ignore odd mount paths */
    }
  }
}

const imageTag = (ref: string) => /:([^/:@]+)$/.exec(ref)?.[1] ?? 'latest';

function expand(line: string, env: Record<string, string>, extra: Record<string, string>): string {
  return line.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k: string) => env[k] ?? '').replace(/\{(\w+)\}/g, (m, k: string) => extra[k] ?? m);
}

function nginxTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

interface StartOutcome {
  running: boolean;
  exitCode?: number;
  exitAt?: number;
  listen: number[];
  logs: string[];
  staticRoot?: string;
}

const SHELLS = new Set(['sh', '/bin/sh', 'bash', '/bin/bash', 'ash', 'python3', 'python', 'node', '/bin/ash']);

/** Decide what the container's main process does. */
function startProcess(host: SimState, _ks: KubeState, pod: KObj, c: J, image: ResolvedImage, env: Record<string, string>, fs: DirNode, now: number): StartOutcome {
  const app = image.spec;
  const extra = { time: nginxTime(now), ip: pod.status?.podIP ?? '', pod: pod.metadata.name, tag: imageTag(String(c.image)) };
  if (app.shellImage) {
    // Docker semantics: `command` replaces ENTRYPOINT, `args` replaces CMD.
    let full = [...(c.command ?? app.entrypoint ?? []), ...(c.args ?? (c.command ? [] : app.cmd ?? []))];
    // Like curlimages/curl's entrypoint script: `-- curl -s URL` doesn't run `curl curl -s URL`.
    if (!c.command && c.args?.length && app.entrypoint?.length && c.args[0] === app.entrypoint[0]) full = [...c.args];
    const joined = full.join(' ');
    if (!full.length || (full.length === 1 && SHELLS.has(full[0]))) return { running: false, exitCode: 0, listen: [], logs: [] };
    const http = /(?:python3?|python) -m http\.server(?:\s+(\d+))?/.exec(joined);
    if (http) return { running: true, listen: [Number(http[1] ?? 8000)], logs: [`Serving HTTP on 0.0.0.0 port ${http[1] ?? 8000} (http://0.0.0.0:${http[1] ?? 8000}/) ...`], staticRoot: '/' };
    const sleepOnly = /^(?:\/bin\/)?sleep (\d+|infinity)$/.exec(joined);
    if (sleepOnly) return { running: true, listen: [], logs: [], exitAt: sleepOnly[1] === 'infinity' ? undefined : now + Number(sleepOnly[1]) * SEC, exitCode: 0 };
    const loop = /while true|sleep infinity|tail -f|sleep \d{3,}/.exec(joined);
    if (loop) {
      // Long-running: run the setup before the loop for real (e.g. writing to a volume),
      // then log what the loop echoes once and keep running.
      const logs: string[] = [];
      const isShellC = (full[0] === 'sh' || full[0] === '/bin/sh' || full[0] === 'bash' || full[0] === '/bin/bash') && full[1] === '-c';
      const scriptText = isShellC ? full.slice(2).join(' ') : '';
      const at = scriptText.indexOf(loop[0]);
      const prefix = at > 0 ? scriptText.slice(0, at).replace(/[\s;&]+$/, '') : '';
      if (prefix) {
        const shell = podShell(podState(host, pod, c.name, fs, env, image));
        if (shell) {
          const r = shell.run(prefix);
          logs.push(...r.output.map((o) => o.text).join('').split('\n').filter((l) => l !== ''));
        }
      }
      const rest = at > 0 ? scriptText.slice(at) : joined;
      const echoes = [...rest.matchAll(/echo\s+(?:"([^"]*)"|'([^']*)'|([^;&|]+))/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim());
      logs.push(...echoes.map((e) => e.replace(/\$\(date\)|\$\(date[^)]*\)/g, new Date(now).toUTCString())));
      return { running: true, listen: [], logs };
    }
    // A finite command: run it for real inside the container and keep its output as the log.
    const script = (full[0] === 'sh' || full[0] === '/bin/sh' || full[0] === 'bash' || full[0] === '/bin/bash') && full[1] === '-c' ? full.slice(2).join(' ') : full.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
    const shell = podShell(podState(host, pod, c.name, fs, env, image));
    if (!shell) return { running: false, exitCode: 0, listen: [], logs: [] };
    const r = shell.run(script);
    const text = r.output.map((o) => o.text).join('');
    return { running: false, exitCode: r.exitCode, listen: [], logs: text.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1) };
  }
  for (const k of app.requireEnv ?? []) {
    if (!env[k]) return { running: false, exitCode: 1, listen: [], logs: expand(app.requireEnvMessage ?? `Error: environment variable ${k} is required but not set`, env, extra).split('\n') };
  }
  const vfs = new Vfs(fs, { name: 'root', groups: ['root'] });
  for (const f of app.requireFiles ?? []) {
    if (!vfs.exists(normalize(f))) return { running: false, exitCode: 1, listen: [], logs: [`Error: open ${f}: no such file or directory`] };
  }
  const port = app.portEnv && env[app.portEnv] ? [Number(env[app.portEnv])] : app.listen ?? [];
  const logs = (app.logs ?? []).flatMap((l) => expand(l, env, { ...extra, port: String(port[0] ?? '') }).split('\n'));
  if (app.exitCode !== undefined && !app.exitAfter) return { running: false, exitCode: app.exitCode, listen: [], logs };
  return { running: true, listen: port, logs, exitAt: app.exitCode !== undefined ? now + (app.exitAfter ?? 0) * SEC : undefined, exitCode: app.exitCode, staticRoot: app.staticRoot };
}

function memLimitMi(c: J): number {
  const l = c.resources?.limits?.memory;
  return l ? memBytes(l) / 1024 ** 2 : Infinity;
}

/** Ports by name for probes / services. */
export function containerPort(pod: KObj, port: number | string): number | null {
  if (typeof port === 'number' || /^\d+$/.test(String(port))) return Number(port);
  for (const c of pod.spec.containers ?? []) for (const p of c.ports ?? []) if (p.name === port) return p.containerPort;
  return null;
}

export interface HttpAnswer {
  ok: boolean;
  status?: number;
  body?: string;
  /** Connection-level failure text (probe message). */
  error?: string;
  errorCode?: number;
}

/** Ask a pod for an HTTP path on a port, as of now. */
export function podHttp(ks: KubeState, pod: KObj, port: number, path: string, now: number, opts: { log?: string } = {}): HttpAnswer {
  const ip = pod.status?.podIP ?? '';
  const rt = ks.runtime[pod.metadata.uid];
  for (const c of pod.spec.containers ?? []) {
    const cs = rt?.containers[c.name];
    if (!cs || cs.state !== 'running' || !cs.listen.includes(port)) continue;
    if (now < cs.answersFrom) break;
    const img = resolveImage(ks, c.image);
    if (!img.ok) break;
    const app = img.image.spec;
    const run = cs.runs[cs.runs.length - 1];
    let status = 404;
    let body = '';
    const root = app.staticRoot ?? (app.shellImage ? '/' : undefined);
    if (root && rt?.fs) {
      const vfs = new Vfs(rt.fs, { name: 'root', groups: ['root'] });
      let target = normalize(joinPath(root, path.split('?')[0]));
      try {
        if (vfs.isDir(target)) target = joinPath(target, 'index.html');
        body = vfs.readFile(target);
        status = 200;
      } catch {
        status = 404;
        body = app.staticRoot === '/usr/share/nginx/html' ? '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx/1.27.2</center>\r\n</body>\r\n</html>\r\n' : 'Not Found\n';
      }
      if (app.accessLog && opts.log) run.logs.push({ time: now, text: `${opts.log} - - [${clfTime(now)}] "GET ${path} HTTP/1.1" ${status} ${new TextEncoder().encode(body).length} "-" "${opts.log.startsWith('10.244') && path !== '/' ? 'kube-probe/1.31' : 'curl/8.5.0'}" "-"` });
    } else if (app.http) {
      const route = app.http[path] ?? app.http[path.replace(/\/$/, '')];
      if (route) {
        status = route.status ?? 200;
        body = expand(route.body, cs.env, { pod: pod.metadata.name, ip, port: String(port), tag: imageTag(String(c.image)) });
      } else body = '404 page not found\n';
    } else {
      return { ok: false, error: `Get "http://${ip}:${port}${path}": EOF`, errorCode: 52 };
    }
    return { ok: status < 400, status, body };
  }
  return { ok: false, error: `Get "http://${ip}:${port}${path}": dial tcp ${ip}:${port}: connect: connection refused`, errorCode: 7 };
}

function clfTime(ms: number): string {
  const d = new Date(ms);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${M[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function runProbe(ks: KubeState, pod: KObj, _c: J, cs: ContainerRuntime, probe: J, now: number): { ok: boolean; message: string } {
  const ip = pod.status?.podIP ?? '';
  if (probe.httpGet) {
    const port = containerPort(pod, probe.httpGet.port);
    const path = probe.httpGet.path ?? '/';
    if (port === null) return { ok: false, message: `HTTP probe failed: port "${probe.httpGet.port}" not found` };
    const r = podHttp(ks, pod, port, path, now, { log: '10.244.0.1' });
    if (r.error) return { ok: false, message: r.error };
    return { ok: !!r.ok, message: `HTTP probe failed with statuscode: ${r.status}` };
  }
  if (probe.tcpSocket) {
    const port = containerPort(pod, probe.tcpSocket.port);
    const ok = port !== null && cs.listen.includes(port) && now >= cs.answersFrom;
    return { ok, message: `dial tcp ${ip}:${port}: connect: connection refused` };
  }
  if (probe.exec) {
    const cmd: string[] = probe.exec.command ?? [];
    const rt = ks.runtime[pod.metadata.uid];
    const file = cmd[0] === 'cat' || cmd[0] === 'test' || cmd[0] === 'ls' ? cmd[cmd.length - 1] : null;
    if (file && rt?.fs) {
      const ok = new Vfs(rt.fs, { name: 'root', groups: ['root'] }).exists(normalize(file));
      return { ok, message: ok ? '' : `cat: can't open '${file}': No such file or directory` };
    }
    return { ok: now >= cs.answersFrom, message: 'command failed' };
  }
  return { ok: true, message: '' };
}

function terminate(_ks: KubeState, pod: KObj, _c: J, cs: ContainerRuntime, now: number, code: number, reason: string): void {
  const run = cs.runs[cs.runs.length - 1];
  run.finishedAt = now;
  run.exitCode = code;
  run.reason = reason;
  cs.state = 'terminated';
  cs.reason = reason;
  cs.ready = false;
  cs.listen = [];
  const policy = pod.spec.restartPolicy ?? 'Always';
  const restart = policy === 'Always' || (policy === 'OnFailure' && code !== 0);
  if (restart) {
    const ranLong = now - run.startedAt > 600 * SEC;
    const level = ranLong ? 0 : Math.min(cs.restartCount, 5);
    cs.nextAttemptAt = now + Math.min(10 * 2 ** level, 300) * SEC;
  } else cs.nextAttemptAt = NEVER;
}

function kubeletStep(host: SimState, ks: KubeState, pod: KObj, now: number): void {
  const uidKey = pod.metadata.uid;
  const rt: PodRuntime = (ks.runtime[uidKey] ??= { containers: {} });
  const node = getObj(ks, 'Node', undefined, pod.spec.nodeName);
  if (isTerminating(pod)) {
    const started = parseIso(pod.metadata.deletionTimestamp);
    if (!(rt as J)._killed) {
      for (const c of pod.spec.containers ?? []) if (rt.containers[c.name]?.state === 'running') emit(ks, started, pod, 'Normal', 'Killing', `Stopping container ${c.name}`, 'kubelet');
      (rt as J)._killed = true;
    }
    const anyRunning = Object.values(rt.containers).some((c) => c.state === 'running');
    if (!anyRunning || now - started >= 2 * SEC) removeObj(ks, pod);
    return;
  }
  // Sandbox: IP addresses.
  if (!pod.status.podIP && node) {
    const nodeIdx = NODES.findIndex((n) => n.name === node.metadata.name);
    const hostIp = NODES[nodeIdx]?.ip ?? '172.18.0.3';
    const ip = pod.spec.hostNetwork ? hostIp : `10.244.${nodeIdx}.${2 + (ks.seq++ % 250)}`;
    pod.status.podIP = ip;
    pod.status.podIPs = [{ ip }];
    pod.status.hostIP = hostIp;
    pod.status.hostIPs = [{ ip: hostIp }];
    pod.status.startTime = iso(now);
  }
  const mountErr = missingVolume(ks, pod);
  if (mountErr) {
    if (!rt.lastMountWarn || now - rt.lastMountWarn >= 120 * SEC) {
      emit(ks, now, pod, 'Warning', 'FailedMount', mountErr, 'kubelet');
      rt.lastMountWarn = now;
    }
    for (const c of pod.spec.containers ?? []) rt.containers[c.name] ??= emptyContainer();
    return;
  }
  for (const [i, c] of (pod.spec.containers ?? []).entries()) {
    const cs = (rt.containers[c.name] ??= emptyContainer());
    const pulled = resolveImage(ks, c.image);
    const policy = c.imagePullPolicy ?? (fullRef(c.image).endsWith(':latest') ? 'Always' : 'IfNotPresent');
    // ---- image
    if (!cs.imagePulled) {
      if (now < cs.nextAttemptAt) {
        if (cs.reason === 'ErrImagePull') {
          cs.reason = 'ImagePullBackOff';
          cs.message = `Back-off pulling image "${c.image}"`;
          emit(ks, now, pod, 'Normal', 'BackOff', `Back-off pulling image "${c.image}"`, 'kubelet');
        }
        continue;
      }
      const cached = (ks.nodeImages[pod.spec.nodeName] ?? []).includes(fullRef(c.image));
      if (cs.pullStartedAt === undefined && pulled.ok && cached && policy !== 'Always') {
        emit(ks, now, pod, 'Normal', 'Pulled', `Container image "${c.image}" already present on machine`, 'kubelet');
        cs.imagePulled = true;
      } else if (cs.pullStartedAt === undefined) {
        cs.pullStartedAt = now;
        emit(ks, now, pod, 'Normal', 'Pulling', `Pulling image "${c.image}"`, 'kubelet');
        continue;
      } else if (now - cs.pullStartedAt < 2 * SEC) continue;
      else if (pulled.ok) {
        const secs = (1.2 + (pulled.image.size % 900) / 1000).toFixed(3);
        emit(ks, now, pod, 'Normal', 'Pulled', `Successfully pulled image "${c.image}" in ${secs}s (${secs}s including waiting). Image size: ${pulled.image.size} bytes.`, 'kubelet');
        cs.imagePulled = true;
        if (!(ks.nodeImages[pod.spec.nodeName] ??= []).includes(fullRef(c.image))) ks.nodeImages[pod.spec.nodeName].push(fullRef(c.image));
      } else {
        cs.pullFailures++;
        cs.pullStartedAt = undefined;
        cs.state = 'waiting';
        cs.reason = 'ErrImagePull';
        cs.message = `rpc error: code = NotFound desc = ${pulled.message}`;
        emit(ks, now, pod, 'Warning', 'Failed', `Failed to pull image "${c.image}": ${pulled.message}`, 'kubelet');
        emit(ks, now, pod, 'Warning', 'Failed', 'Error: ErrImagePull', 'kubelet');
        cs.nextAttemptAt = now + Math.min(10 * 2 ** (cs.pullFailures - 1), 300) * SEC;
        continue;
      }
    }
    if (!pulled.ok) continue;
    if (i === 0 && !rt.fs) rt.fs = imageFs(pulled.image, now);
    if (i === 0 && rt.fs) syncMounts(ks, pod, c, rt.fs);
    const app = pulled.image.spec;
    // ---- running container: exits, OOM and probes
    if (cs.state === 'running') {
      const run = cs.runs[cs.runs.length - 1];
      const exitAt = (run as J)._exitAt as number | undefined;
      if (memLimitMi(c) < (app.memMi ?? 0) && now - run.startedAt >= SEC) {
        terminate(ks, pod, c, cs, now, 137, 'OOMKilled');
        continue;
      }
      if (exitAt !== undefined && now >= exitAt) {
        const code = (run as J)._exitCode ?? 0;
        terminate(ks, pod, c, cs, now, code, code === 0 ? 'Completed' : 'Error');
        continue;
      }
      const due = (kind: string, probe: J) => {
        const start = run.startedAt + (probe.initialDelaySeconds ?? 0) * SEC;
        if (now < start) return false;
        if (now < (cs.nextProbeAt[kind] ?? 0)) return false;
        cs.nextProbeAt[kind] = now + (probe.periodSeconds ?? 10) * SEC;
        return true;
      };
      let killed = false;
      if (c.startupProbe && !cs.startupOk) {
        if (due('startup', c.startupProbe)) {
          const r = runProbe(ks, pod, c, cs, c.startupProbe, now);
          if (r.ok) {
            cs.startupOk = true;
            cs.started = true;
          } else {
            cs.startupFails++;
            emit(ks, now, pod, 'Warning', 'Unhealthy', `Startup probe failed: ${r.message}`, 'kubelet');
            if (cs.startupFails >= (c.startupProbe.failureThreshold ?? 3)) {
              emit(ks, now, pod, 'Normal', 'Killing', `Container ${c.name} failed startup probe, will be restarted`, 'kubelet');
              terminate(ks, pod, c, cs, now, 137, 'Error');
              killed = true;
            }
          }
        }
      } else cs.started = true;
      if (killed) continue;
      if (c.livenessProbe && (cs.startupOk || !c.startupProbe) && due('liveness', c.livenessProbe)) {
        const r = runProbe(ks, pod, c, cs, c.livenessProbe, now);
        if (r.ok) cs.liveFails = 0;
        else {
          cs.liveFails++;
          emit(ks, now, pod, 'Warning', 'Unhealthy', `Liveness probe failed: ${r.message}`, 'kubelet');
          if (cs.liveFails >= (c.livenessProbe.failureThreshold ?? 3)) {
            emit(ks, now, pod, 'Normal', 'Killing', `Container ${c.name} failed liveness probe, will be restarted`, 'kubelet');
            terminate(ks, pod, c, cs, now, 137, 'Error');
            continue;
          }
        }
      }
      if (!c.readinessProbe) cs.ready = cs.started;
      else if ((cs.startupOk || !c.startupProbe) && due('readiness', c.readinessProbe)) {
        const r = runProbe(ks, pod, c, cs, c.readinessProbe, now);
        if (r.ok) {
          cs.readyFails = 0;
          cs.ready = true;
        } else {
          cs.readyFails++;
          emit(ks, now, pod, 'Warning', 'Unhealthy', `Readiness probe failed: ${r.message}`, 'kubelet');
          if (cs.readyFails >= (c.readinessProbe.failureThreshold ?? 3) || !cs.ready) cs.ready = false;
        }
      }
      continue;
    }
    // ---- (re)start
    if (cs.state === 'terminated' && cs.nextAttemptAt === NEVER) continue;
    if (now < cs.nextAttemptAt) {
      if (cs.state === 'terminated' && cs.runs.length) {
        cs.state = 'waiting';
        cs.reason = 'CrashLoopBackOff';
        cs.message = `back-off ${Math.round((cs.nextAttemptAt - (cs.runs[cs.runs.length - 1].finishedAt ?? now)) / SEC)}s restarting failed container=${c.name} pod=${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`;
        emit(ks, now, pod, 'Warning', 'BackOff', `Back-off restarting failed container ${c.name} in pod ${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`, 'kubelet');
      }
      continue;
    }
    const envOrErr = containerEnv(ks, pod, c, app);
    if ('error' in envOrErr) {
      if (cs.message !== `Error: ${envOrErr.error}` || !rt.lastConfigWarn || now - rt.lastConfigWarn >= 30 * SEC) {
        emit(ks, now, pod, 'Warning', 'Failed', `Error: ${envOrErr.error}`, 'kubelet');
        rt.lastConfigWarn = now;
      }
      cs.state = 'waiting';
      cs.reason = 'CreateContainerConfigError';
      cs.message = envOrErr.error;
      continue;
    }
    if (cs.runs.length) cs.restartCount++;
    emit(ks, now, pod, 'Normal', 'Created', `Created container ${c.name}`, 'kubelet');
    emit(ks, now, pod, 'Normal', 'Started', `Started container ${c.name}`, 'kubelet');
    const out = startProcess(host, ks, pod, c, pulled.image, envOrErr.env, rt.fs!, now);
    const run: ContainerRun = { startedAt: now, logs: out.logs.map((text) => ({ time: now, text })) };
    cs.runs.push(run);
    if (cs.runs.length > 6) cs.runs.splice(0, cs.runs.length - 6);
    cs.env = envOrErr.env;
    cs.liveFails = 0;
    cs.readyFails = 0;
    cs.startupOk = false;
    cs.startupFails = 0;
    cs.nextProbeAt = {};
    cs.message = undefined;
    if (!out.running) {
      cs.state = 'running';
      terminate(ks, pod, c, cs, now, out.exitCode ?? 0, (out.exitCode ?? 0) === 0 ? 'Completed' : 'Error');
      continue;
    }
    cs.state = 'running';
    cs.reason = '';
    cs.listen = out.listen;
    cs.answersFrom = now + (app.warmupSec ?? 0) * SEC;
    cs.started = !c.startupProbe;
    cs.ready = !c.readinessProbe && !c.startupProbe;
    (run as J)._exitAt = out.exitAt;
    (run as J)._exitCode = out.exitCode;
  }
  podStatus(ks, pod, rt, now);
}

function podStatus(_ks: KubeState, pod: KObj, rt: PodRuntime, now: number): void {
  const statuses: J[] = [];
  let anyRunning = false;
  let allTerminated = true;
  let allSucceeded = true;
  let allStartedOnce = true;
  for (const c of pod.spec.containers ?? []) {
    const cs = rt.containers[c.name];
    if (!cs) {
      allTerminated = false;
      allStartedOnce = false;
      continue;
    }
    const last = cs.runs[cs.runs.length - 1];
    const prev = cs.state === 'running' || cs.state === 'waiting' ? cs.runs[cs.runs.length - (cs.state === 'running' ? 2 : 1)] : cs.runs[cs.runs.length - 2];
    const cid = (r: ContainerRun) => ((r as J)._id ??= `containerd://${suffix(pod.metadata.uid + r.startedAt, 12)}${suffix(String(r.startedAt), 12)}`);
    const terminated = (r: ContainerRun) => ({ terminated: { containerID: cid(r), exitCode: r.exitCode, finishedAt: iso(r.finishedAt ?? now), reason: r.reason, startedAt: iso(r.startedAt) } });
    let state: J;
    if (cs.state === 'running') state = { running: { startedAt: iso(last.startedAt) } };
    else if (cs.state === 'terminated') state = terminated(last);
    else state = { waiting: { reason: cs.reason, ...(cs.message ? { message: cs.message } : {}) } };
    if (cs.state === 'running') anyRunning = true;
    if (cs.state !== 'terminated' || cs.nextAttemptAt !== NEVER) allTerminated = false;
    if (!(cs.state === 'terminated' && last?.exitCode === 0)) allSucceeded = false;
    if (!cs.runs.length) allStartedOnce = false;
    const pulled = cs.imagePulled;
    statuses.push({
      containerID: last ? cid(last) : undefined,
      image: pulled ? fullRef(c.image).replace(/^docker\.io\/library\//, 'docker.io/library/') : c.image,
      imageID: pulled ? ((cs as J)._imageID ??= `${fullRef(c.image).replace(/:[^:/]+$/, '')}@sha256:${suffix(c.image, 32)}${suffix(c.image + '#', 32)}`) : '',
      lastState: prev && prev.finishedAt !== undefined && cs.state !== 'terminated' ? terminated(prev) : cs.state === 'terminated' && prev?.finishedAt !== undefined ? terminated(prev) : {},
      name: c.name,
      ready: cs.ready,
      restartCount: cs.restartCount,
      started: cs.state === 'running' && cs.started,
      state,
    });
    for (const s of statuses) if (s.containerID === undefined) delete s.containerID;
  }
  const ready = statuses.length > 0 && statuses.every((s) => s.ready);
  let phase = 'Pending';
  if (allTerminated && statuses.length) phase = allSucceeded ? 'Succeeded' : 'Failed';
  else if (allStartedOnce && (anyRunning || statuses.some((s) => s.state.waiting?.reason === 'CrashLoopBackOff' || s.state.terminated))) phase = 'Running';
  const cond = (type: string, ok: boolean, reason?: string) => {
    const old = (pod.status.conditions ?? []).find((c: J) => c.type === type);
    const status = ok ? 'True' : 'False';
    return { type, status, ...(reason && !ok ? { reason } : {}), lastProbeTime: null, lastTransitionTime: old && old.status === status ? old.lastTransitionTime : iso(now) };
  };
  pod.status = {
    ...pod.status,
    phase,
    conditions: [
      cond('PodReadyToStartContainers', !!pod.status.podIP),
      cond('Initialized', true),
      cond('Ready', ready, phase === 'Succeeded' ? 'PodCompleted' : 'ContainersNotReady'),
      cond('ContainersReady', ready, phase === 'Succeeded' ? 'PodCompleted' : 'ContainersNotReady'),
      cond('PodScheduled', true),
    ],
    containerStatuses: statuses,
  };
}

// ------------------------------------------------------------------ services

export function allocateClusterIP(ks: KubeState, seed: string): string {
  const used = new Set(listObjs(ks, 'Service').map((s) => s.spec.clusterIP));
  for (let i = 0; ; i++) {
    const n = parseInt(suffix(seed + i, 4).split('').map((ch) => ch.charCodeAt(0) % 10).join(''), 10);
    const ip = `10.96.${(n % 250) + 1}.${(Math.floor(n / 250) % 250) + 2}`;
    if (!used.has(ip)) return ip;
  }
}

export function allocateNodePort(ks: KubeState, seed: string): number {
  const used = new Set(listObjs(ks, 'Service').flatMap((s) => (s.spec.ports ?? []).map((p: J) => p.nodePort)));
  for (let i = 0; ; i++) {
    const n = 30000 + (parseInt(suffix(seed + i, 3).split('').map((ch) => ch.charCodeAt(0) % 10).join(''), 10) * 7 + i) % 2768;
    if (!used.has(n)) return n;
  }
}

function endpointsController(ks: KubeState, now: number): void {
  for (const svc of listObjs(ks, 'Service')) {
    if (!svc.spec.selector) continue;
    const ns = svc.metadata.namespace!;
    const pods = listObjs(ks, 'Pod', ns).filter((p) => matches(p.metadata.labels, svc.spec.selector) && p.status?.podIP && !isTerminating(p) && !['Succeeded', 'Failed'].includes(p.status.phase));
    const addr = (p: KObj) => ({ ip: p.status.podIP, nodeName: p.spec.nodeName, targetRef: { kind: 'Pod', name: p.metadata.name, namespace: ns, uid: p.metadata.uid } });
    const ready = pods.filter(isPodReady);
    const notReady = pods.filter((p) => !isPodReady(p));
    const ports = (svc.spec.ports ?? []).map((sp: J) => {
      const target = pods.length ? containerPort(pods[0], sp.targetPort ?? sp.port) : typeof sp.targetPort === 'number' ? sp.targetPort : sp.port;
      return { ...(sp.name ? { name: sp.name } : {}), port: target ?? sp.port, protocol: sp.protocol ?? 'TCP' };
    });
    const subsets = pods.length ? [{ ...(ready.length ? { addresses: ready.map(addr) } : {}), ...(notReady.length ? { notReadyAddresses: notReady.map(addr) } : {}), ports }] : undefined;
    let ep = getObj(ks, 'Endpoints', ns, svc.metadata.name);
    if (!ep) {
      ep = { apiVersion: 'v1', kind: 'Endpoints', metadata: newMeta(ks, now, svc.metadata.name, ns, { labels: { ...(svc.metadata.labels ?? {}) } }) };
      putObj(ks, ep);
    }
    if (JSON.stringify(ep.subsets) !== JSON.stringify(subsets)) {
      if (subsets) ep.subsets = subsets;
      else delete ep.subsets;
      bump(ks, ep);
    }
  }
  for (const ep of listObjs(ks, 'Endpoints')) {
    if (ep.metadata.name === 'kubernetes' && ep.metadata.namespace === 'default') continue;
    if (!getObj(ks, 'Service', ep.metadata.namespace, ep.metadata.name)) removeObj(ks, ep);
  }
}

// ------------------------------------------------------------------ garbage collection

function garbageCollect(ks: KubeState, now: number): void {
  const alive = new Set<string>();
  for (const kind of Object.keys(ks.objects)) for (const o of Object.values(ks.objects[kind])) if (!isTerminating(o) || kind === 'Pod') alive.add(o.metadata.uid);
  for (const kind of ['ReplicaSet', 'Job', 'Pod']) {
    for (const o of listObjs(ks, kind)) {
      const owner = o.metadata.ownerReferences?.find((r) => r.controller);
      if (!owner || owner.kind === 'Node') continue;
      if (!alive.has(owner.uid)) {
        if (kind === 'Pod') deletePod(ks, now, o);
        else removeObj(ks, o);
      }
    }
  }
  // Objects being deleted whose children are gone are removed for good.
  for (const kind of ['Deployment', 'ReplicaSet', 'DaemonSet', 'Job', 'StatefulSet', 'CronJob']) {
    for (const o of listObjs(ks, kind)) if (isTerminating(o)) removeObj(ks, o);
  }
}

// ------------------------------------------------------------------ the loop

function tick(host: SimState, ks: KubeState, now: number): void {
  garbageCollect(ks, now);
  serviceAccountController(ks, now);
  hpaController(ks, now);
  ingressStatusController(ks, now);
  cronJobController(ks, now);
  deploymentController(ks, now);
  replicaSetController(ks, now);
  daemonSetController(ks, now);
  jobController(ks, now);
  statefulSetController(ks, now);
  storageController(ks, now);
  taintEviction(ks, now);
  scheduler(ks, now);
  for (const pod of listObjs(ks, 'Pod')) {
    if (pod.spec.nodeName) kubeletStep(host, ks, pod, now);
    else if (isTerminating(pod)) removeObj(ks, pod);
  }
  replicaSetStatus(ks);
  deploymentStatus(ks, now);
  endpointsController(ks, now);
}

/** Catch the cluster up to the simulation clock. */
let reconciling = false;

export function reconcile(state: SimState): KubeState {
  const host = state.context?.host ?? state;
  const ks = clusterOf(host);
  // Commands run by pods (curl from a shell image) look at the cluster mid-tick: don't re-enter.
  if (reconciling) return ks;
  reconciling = true;
  try {
    catchUp(host, ks);
  } finally {
    reconciling = false;
  }
  return ks;
}

function catchUp(host: SimState, ks: KubeState): void {
  const now = host.clock;
  let t = ks.lastTick;
  // 1s steps for the first 20s of any gap (pulls, starts, probes), then at most 120 coarser steps.
  const fine = Math.min(now, t + 20 * SEC);
  while (t < fine) {
    t = Math.min(fine, t + SEC);
    tick(host, ks, t);
  }
  const rest = now - t;
  if (rest > 0) {
    const step = Math.max(SEC, Math.ceil(rest / 120 / SEC) * SEC);
    while (t < now) {
      t = Math.min(now, t + step);
      tick(host, ks, t);
    }
  }
  ks.lastTick = Math.max(ks.lastTick, now);
}

/** Let controllers react to a change at the current instant (endpoints, new ReplicaSets...). */
export function settle(state: SimState): void {
  const host = state.context?.host ?? state;
  if (!host.kube || reconciling) return;
  reconciling = true;
  try {
    tick(host, host.kube, host.clock);
  } finally {
    reconciling = false;
  }
}

/** Run the cluster forward by `ms` (rollout status, run --rm). */
export function advance(state: SimState, ms: number): KubeState {
  const host = state.context?.host ?? state;
  host.clock += ms;
  if (state !== host) state.clock = host.clock;
  return reconcile(host);
}

export { makeDir, infoOf };

setHelpers({ podFromTemplate, deletePod, isPodReady, isTerminating, templateHash, tolerates });
