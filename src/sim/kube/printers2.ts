/** get columns and describe output for storage, scheduling, networking and RBAC kinds. */
import { getObj, listObjs, ownedBy, parseIso } from './cluster';
import { eventsSection, kv, multiline, podTemplate, rfc1123 } from './printers';
import { humanDuration } from './quantity';
import type { J, KObj, KubeState } from './types';

type Row = { obj: KObj; cells: string[] };

const age = (o: KObj, now: number) => humanDuration(now - parseIso(o.metadata.creationTimestamp));
const MODES: Record<string, string> = { ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' };
const modes = (m: string[] | undefined) => (m ?? []).map((x) => MODES[x] ?? x).join(',');
const sel = (s: J) => {
  const parts = Object.entries(s?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const e of s?.matchExpressions ?? []) parts.push(`${e.key} ${e.operator.toLowerCase()} (${(e.values ?? []).join(',')})`);
  return parts.length ? parts.join(',') : '<none>';
};

export function hpaTargets(hpa: KObj): string {
  return (hpa.spec.metrics ?? [])
    .map((m: J) => {
      const name = m.resource?.name ?? 'cpu';
      const target = m.resource?.target ?? {};
      const cur = (hpa.status?.currentMetrics ?? []).find((c: J) => c.resource?.name === name)?.resource?.current;
      if (target.type === 'Utilization') return `${name}: ${cur?.averageUtilization !== undefined ? cur.averageUtilization + '%' : '<unknown>'}/${target.averageUtilization}%`;
      return `${name}: ${cur?.averageValue ?? '<unknown>'}/${target.averageValue}`;
    })
    .join(', ');
}

export function columns2(kind: string, objs: KObj[], now: number, wide: boolean): { head: string[]; rows: Row[] } {
  const r = (o: KObj, cells: string[]): Row => ({ obj: o, cells: [o.metadata.name, ...cells] });
  switch (kind) {
    case 'StatefulSet':
      return {
        head: ['NAME', 'READY', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES'] : [])],
        rows: objs.map((o) => r(o, [`${o.status?.readyReplicas ?? 0}/${o.spec.replicas ?? 1}`, age(o, now), ...(wide ? [o.spec.template.spec.containers.map((c: J) => c.name).join(','), o.spec.template.spec.containers.map((c: J) => c.image).join(',')] : [])])),
      };
    case 'CronJob':
      return {
        head: ['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'LAST SCHEDULE', 'AGE'],
        rows: objs.map((o) => r(o, [o.spec.schedule, o.spec.timeZone ?? '<none>', o.spec.suspend ? 'True' : 'False', String((o.status?.active ?? []).length), o.status?.lastScheduleTime ? humanDuration(now - parseIso(o.status.lastScheduleTime)) : '<none>', age(o, now)])),
      };
    case 'PersistentVolumeClaim':
      return {
        head: ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'AGE', ...(wide ? ['VOLUMEMODE'] : [])],
        rows: objs.map((o) =>
          r(o, [o.metadata.deletionTimestamp ? 'Terminating' : o.status?.phase ?? 'Pending', o.spec.volumeName ?? '', o.status?.capacity?.storage ?? '', modes(o.status?.accessModes), o.spec.storageClassName ?? '', '<unset>', age(o, now), ...(wide ? [o.spec.volumeMode ?? 'Filesystem'] : [])]),
        ),
      };
    case 'PersistentVolume':
      return {
        head: ['NAME', 'CAPACITY', 'ACCESS MODES', 'RECLAIM POLICY', 'STATUS', 'CLAIM', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'REASON', 'AGE'],
        rows: objs.map((o) =>
          r(o, [o.spec.capacity?.storage ?? '', modes(o.spec.accessModes), o.spec.persistentVolumeReclaimPolicy ?? 'Retain', o.status?.phase ?? 'Available', o.spec.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : '', o.spec.storageClassName ?? '', '<unset>', '', age(o, now)]),
        ),
      };
    case 'StorageClass':
      return {
        head: ['NAME', 'PROVISIONER', 'RECLAIMPOLICY', 'VOLUMEBINDINGMODE', 'ALLOWVOLUMEEXPANSION', 'AGE'],
        rows: objs.map((o) => ({
          obj: o,
          cells: [o.metadata.name + (o.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? ' (default)' : ''), o.provisioner, o.reclaimPolicy ?? 'Delete', o.volumeBindingMode ?? 'Immediate', String(!!o.allowVolumeExpansion), age(o, now)],
        })),
      };
    case 'Ingress':
      return {
        head: ['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE'],
        rows: objs.map((o) =>
          r(o, [
            o.spec.ingressClassName ?? '<none>',
            (o.spec.rules ?? []).map((x: J) => x.host ?? '*').join(',') || '*',
            (o.status?.loadBalancer?.ingress ?? []).map((x: J) => x.hostname ?? x.ip).join(','),
            o.spec.tls?.length ? '80, 443' : '80',
            age(o, now),
          ]),
        ),
      };
    case 'IngressClass':
      return { head: ['NAME', 'CONTROLLER', 'PARAMETERS', 'AGE'], rows: objs.map((o) => r(o, [o.spec?.controller ?? '', '<none>', age(o, now)])) };
    case 'NetworkPolicy':
      return { head: ['NAME', 'POD-SELECTOR', 'AGE'], rows: objs.map((o) => r(o, [Object.keys(o.spec.podSelector?.matchLabels ?? {}).length || o.spec.podSelector?.matchExpressions ? sel(o.spec.podSelector) : '<none>', age(o, now)])) };
    case 'HorizontalPodAutoscaler':
      return {
        head: ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'],
        rows: objs.map((o) => r(o, [`${o.spec.scaleTargetRef.kind}/${o.spec.scaleTargetRef.name}`, hpaTargets(o), String(o.spec.minReplicas ?? 1), String(o.spec.maxReplicas), String(o.status?.currentReplicas ?? 0), age(o, now)])),
      };
    case 'ServiceAccount':
      return { head: ['NAME', 'SECRETS', 'AGE'], rows: objs.map((o) => r(o, [String((o.secrets ?? []).length), age(o, now)])) };
    case 'Role':
    case 'ClusterRole':
      return { head: ['NAME', 'CREATED AT'], rows: objs.map((o) => r(o, [o.metadata.creationTimestamp])) };
    case 'RoleBinding':
    case 'ClusterRoleBinding': {
      const subj = (o: KObj, k: string) => (o.subjects ?? []).filter((x: J) => x.kind === k).map((x: J) => (k === 'ServiceAccount' ? `${x.namespace ?? o.metadata.namespace}/${x.name}` : x.name)).join(', ');
      return {
        head: ['NAME', 'ROLE', 'AGE', ...(wide ? ['USERS', 'GROUPS', 'SERVICEACCOUNTS'] : [])],
        rows: objs.map((o) => r(o, [`${o.roleRef.kind}/${o.roleRef.name}`, age(o, now), ...(wide ? [subj(o, 'User'), subj(o, 'Group'), subj(o, 'ServiceAccount')] : [])])),
      };
    }
  }
  return { head: ['NAME', 'AGE'], rows: objs.map((o) => r(o, [age(o, now)])) };
}

function rulesTable(rules: J[]): string {
  const rows = rules.map((x) => [
    `  ${(x.resources ?? x.nonResourceURLs ?? []).map((res: string) => (x.apiGroups?.[0] && x.apiGroups[0] !== '' && res !== '*' ? `${res}.${x.apiGroups[0]}` : x.apiGroups?.[0] === '*' ? `${res}.*` : res)).join(' ')}`,
    x.nonResourceURLs ? `[${x.nonResourceURLs.join(' ')}]` : '[]',
    `[${(x.resourceNames ?? []).join(' ')}]`,
    `[${(x.verbs ?? []).join(' ')}]`,
  ]);
  const all = [['  Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], ['  ---------', '-----------------', '--------------', '-----'], ...rows];
  const widths: number[] = [];
  for (const row of all) row.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return all.map((row) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i] + 2))).join('') + '\n').join('');
}

export function describe2(ks: KubeState, o: KObj, now: number): string {
  const m = o.metadata;
  const head = (pairs: [string, string][], w: number) => kv(pairs, '', w - 1);
  switch (o.kind) {
    case 'PersistentVolumeClaim': {
      const users = listObjs(ks, 'Pod', m.namespace).filter((p) => (p.spec.volumes ?? []).some((v: J) => v.persistentVolumeClaim?.claimName === m.name)).map((p) => p.metadata.name);
      let out = head([['Name', m.name], ['Namespace', m.namespace!], ['StorageClass', o.spec.storageClassName ?? ''], ['Status', m.deletionTimestamp ? 'Terminating' : o.status?.phase ?? 'Pending'], ['Volume', o.spec.volumeName ?? '']], 15);
      out += multiline('Labels', m.labels, 15);
      out += multiline('Annotations', m.annotations, 15);
      out += head([['Finalizers', `[${(m.finalizers ?? []).join(' ')}]`], ['Capacity', o.status?.capacity?.storage ?? ''], ['Access Modes', modes(o.status?.accessModes)], ['VolumeMode', o.spec.volumeMode ?? 'Filesystem'], ['Used By', users.length ? users.join('\n               ') : '<none>']], 15);
      return out + eventsSection(ks, o, now);
    }
    case 'PersistentVolume': {
      let out = head([['Name', m.name]], 17);
      out += multiline('Labels', m.labels, 17);
      out += multiline('Annotations', m.annotations, 17);
      const node = o.spec.nodeAffinity?.required?.nodeSelectorTerms?.[0]?.matchExpressions?.[0];
      out += head([
        ['Finalizers', '[kubernetes.io/pv-protection]'],
        ['StorageClass', o.spec.storageClassName ?? ''],
        ['Status', o.status?.phase ?? 'Available'],
        ['Claim', o.spec.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : ''],
        ['Reclaim Policy', o.spec.persistentVolumeReclaimPolicy ?? 'Retain'],
        ['Access Modes', modes(o.spec.accessModes)],
        ['VolumeMode', o.spec.volumeMode ?? 'Filesystem'],
        ['Capacity', o.spec.capacity?.storage ?? ''],
        ['Node Affinity', node ? `\n  Required Terms:\n    Term 0:        ${node.key} in [${node.values.join(', ')}]` : '<none>'],
      ], 17);
      if (o.spec.hostPath) out += `Source:\n    Type:          HostPath (bare host directory volume)\n    Path:          ${o.spec.hostPath.path}\n    HostPathType:  ${o.spec.hostPath.type ?? ''}\n`;
      return out + eventsSection(ks, o, now);
    }
    case 'StatefulSet': {
      let out = head([['Name', m.name], ['Namespace', m.namespace!], ['CreationTimestamp', rfc1123(parseIso(m.creationTimestamp))], ['Selector', sel(o.spec.selector)]], 20);
      out += multiline('Labels', m.labels, 20);
      out += multiline('Annotations', m.annotations, 20);
      const pods = ownedBy(ks, 'Pod', o);
      const count = (ph: string) => pods.filter((p) => p.status?.phase === ph).length;
      out += head([['Replicas', `${o.spec.replicas ?? 1} desired | ${o.status?.replicas ?? 0} total`], ['Update Strategy', o.spec.updateStrategy?.type ?? 'RollingUpdate'], ['  Partition', String(o.spec.updateStrategy?.rollingUpdate?.partition ?? 0)], ['Pods Status', `${count('Running')} Running / ${count('Pending')} Waiting / ${count('Succeeded')} Succeeded / ${count('Failed')} Failed`]], 20);
      out += podTemplate(o.spec.template);
      const vct = o.spec.volumeClaimTemplates ?? [];
      out += vct.length ? 'Volume Claims:\n' + vct.map((t: J) => `  Name:          ${t.metadata.name}\n  StorageClass:  ${t.spec.storageClassName ?? ''}\n  Labels:        <none>\n  Annotations:   <none>\n  Capacity:      ${t.spec.resources?.requests?.storage}\n  Access Modes:  [${(t.spec.accessModes ?? []).join(' ')}]\n`).join('') : 'Volume Claims:  <none>\n';
      return out + eventsSection(ks, o, now);
    }
    case 'CronJob': {
      let out = head([['Name', m.name], ['Namespace', m.namespace!]], 31);
      out += multiline('Labels', m.labels, 31);
      out += multiline('Annotations', m.annotations, 31);
      out += head([
        ['Schedule', o.spec.schedule],
        ['Concurrency Policy', o.spec.concurrencyPolicy ?? 'Allow'],
        ['Suspend', o.spec.suspend ? 'True' : 'False'],
        ['Successful Job History Limit', String(o.spec.successfulJobsHistoryLimit ?? 3)],
        ['Failed Job History Limit', String(o.spec.failedJobsHistoryLimit ?? 1)],
        ['Starting Deadline Seconds', String(o.spec.startingDeadlineSeconds ?? '<unset>')],
        ['Selector', '<unset>'],
        ['Parallelism', '<unset>'],
        ['Completions', '<unset>'],
      ], 31);
      out += podTemplate(o.spec.jobTemplate.spec.template);
      out += head([['Last Schedule Time', o.status?.lastScheduleTime ? rfc1123(parseIso(o.status.lastScheduleTime)) : '<unset>'], ['Active Jobs', (o.status?.active ?? []).map((a: J) => a.name).join(', ') || '<none>']], 31);
      return out + eventsSection(ks, o, now);
    }
    case 'HorizontalPodAutoscaler': {
      let out = head([['Name', m.name], ['Namespace', m.namespace!]], 54);
      out += multiline('Labels', m.labels, 54);
      out += multiline('Annotations', m.annotations, 54);
      out += head([['CreationTimestamp', rfc1123(parseIso(m.creationTimestamp))], ['Reference', `${o.spec.scaleTargetRef.kind}/${o.spec.scaleTargetRef.name}`]], 54);
      out += 'Metrics:                                               ( current / target )\n';
      for (const t of hpaTargets(o).split(', ')) {
        const [name, val] = t.split(': ');
        out += `  resource ${name} on pods  (as a percentage of request):  ${val.replace('/', ' / ')}\n`;
      }
      out += head([['Min replicas', String(o.spec.minReplicas ?? 1)], ['Max replicas', String(o.spec.maxReplicas)], [`${o.spec.scaleTargetRef.kind} pods`, `${o.status?.currentReplicas ?? 0} current / ${o.status?.desiredReplicas ?? 0} desired`]], 54);
      const conds: J[] = o.status?.conditions ?? [];
      if (conds.length) {
        const rows = [['Type', 'Status', 'Reason', 'Message'], ['----', '------', '------', '-------'], ...conds.map((c) => [c.type, c.status, c.reason, c.message])];
        const w = [0, 1, 2].map((i) => Math.max(...rows.map((x) => x[i].length)) + 2);
        out += 'Conditions:\n' + rows.map((x) => `  ${x[0].padEnd(w[0])}${x[1].padEnd(w[1])}${x[2].padEnd(w[2])}${x[3]}\n`).join('');
      }
      return out + eventsSection(ks, o, now);
    }
    case 'Ingress': {
      let out = head([['Name', m.name]], 18);
      out += multiline('Labels', m.labels, 18);
      out += head([['Namespace', m.namespace!], ['Address', (o.status?.loadBalancer?.ingress ?? []).map((x: J) => x.hostname ?? x.ip).join(',')], ['Ingress Class', o.spec.ingressClassName ?? '<none>'], ['Default backend', '<default>']], 18);
      out += 'Rules:\n  Host        Path  Backends\n  ----        ----  --------\n';
      for (const rule of o.spec.rules ?? []) {
        out += `  ${rule.host ?? '*'}\n`;
        for (const p of rule.http?.paths ?? []) {
          const svc = p.backend?.service;
          const ep = svc ? getObj(ks, 'Endpoints', m.namespace, svc.name) : undefined;
          const addrs = (ep?.subsets ?? []).flatMap((s: J) => (s.addresses ?? []).flatMap((a: J) => (s.ports ?? []).map((pt: J) => `${a.ip}:${pt.port}`)));
          out += `              ${p.path ?? '/'}   ${svc?.name}:${svc?.port?.number ?? svc?.port?.name} (${addrs.length ? addrs.join(',') : '<error: endpoints "' + svc?.name + '" not found>'})\n`;
        }
      }
      out += multiline('Annotations', m.annotations, 18);
      return out + eventsSection(ks, o, now);
    }
    case 'NetworkPolicy': {
      let out = head([['Name', m.name], ['Namespace', m.namespace!], ['Created on', rfc1123(parseIso(m.creationTimestamp))]], 14);
      out += multiline('Labels', m.labels, 14);
      out += multiline('Annotations', m.annotations, 14);
      out += 'Spec:\n';
      out += `  PodSelector:     ${Object.keys(o.spec.podSelector?.matchLabels ?? {}).length ? sel(o.spec.podSelector) : '<none> (Allowing the specific traffic to all pods in this namespace)'}\n`;
      const peers = (list: J[] | undefined) =>
        (list ?? []).length
          ? list!.map((f) => (f.podSelector && f.namespaceSelector ? `      NamespaceSelector: ${sel(f.namespaceSelector)}\n      PodSelector: ${sel(f.podSelector)}\n` : f.podSelector ? `      PodSelector: ${sel(f.podSelector)}\n` : f.namespaceSelector ? `      NamespaceSelector: ${sel(f.namespaceSelector)}\n` : f.ipBlock ? `      IPBlock:\n        CIDR: ${f.ipBlock.cidr}\n` : '')).join('    ----------\n')
          : '';
      const types: string[] = o.spec.policyTypes ?? ['Ingress'];
      if (types.includes('Ingress')) {
        out += '  Allowing ingress traffic:\n';
        const rules: J[] = o.spec.ingress ?? [];
        if (!rules.length) out += '    <none> (Selected pods are isolated for ingress connectivity)\n';
        for (const rule of rules) {
          out += `    To Port: ${(rule.ports ?? []).map((p: J) => `${p.port}/${p.protocol ?? 'TCP'}`).join(', ') || '<any> (traffic allowed to all ports)'}\n`;
          out += rule.from?.length ? '    From:\n' + peers(rule.from) : '    From: <any> (traffic not restricted by source)\n';
        }
      } else out += '  Not affecting ingress traffic\n';
      if (types.includes('Egress')) {
        out += '  Allowing egress traffic:\n';
        const rules: J[] = o.spec.egress ?? [];
        if (!rules.length) out += '    <none> (Selected pods are isolated for egress connectivity)\n';
        for (const rule of rules) {
          out += `    To Port: ${(rule.ports ?? []).map((p: J) => `${p.port}/${p.protocol ?? 'TCP'}`).join(', ') || '<any> (traffic allowed to all ports)'}\n`;
          out += rule.to?.length ? '    To:\n' + peers(rule.to) : '    To: <any> (traffic not restricted by destination)\n';
        }
      } else out += '  Not affecting egress traffic\n';
      out += `  Policy Types: ${types.join(', ')}\n`;
      return out;
    }
    case 'Role':
    case 'ClusterRole': {
      let out = head([['Name', m.name]], 13);
      out += multiline('Labels', m.labels, 13);
      out += multiline('Annotations', m.annotations, 13);
      out += 'PolicyRule:\n' + rulesTable(o.rules ?? []);
      return out;
    }
    case 'RoleBinding':
    case 'ClusterRoleBinding': {
      let out = head([['Name', m.name]], 13);
      out += multiline('Labels', m.labels, 13);
      out += multiline('Annotations', m.annotations, 13);
      out += `Role:\n  Kind:  ${o.roleRef.kind}\n  Name:  ${o.roleRef.name}\nSubjects:\n  Kind            Name     Namespace\n  ----            ----     ---------\n`;
      for (const sb of o.subjects ?? []) out += `  ${sb.kind.padEnd(16)}${sb.name.padEnd(9)}${sb.namespace ?? ''}\n`;
      return out;
    }
    case 'ServiceAccount': {
      let out = head([['Name', m.name], ['Namespace', m.namespace!]], 20);
      out += multiline('Labels', m.labels, 20);
      out += multiline('Annotations', m.annotations, 20);
      out += head([['Image pull secrets', '<none>'], ['Mountable secrets', '<none>'], ['Tokens', '<none>']], 20);
      return out + 'Events:              <none>\n';
    }
    case 'StorageClass': {
      let out = head([['Name', m.name], ['IsDefaultClass', m.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? 'Yes' : 'No']], 22);
      out += multiline('Annotations', m.annotations, 22);
      out += head([['Provisioner', o.provisioner], ['Parameters', '<none>'], ['AllowVolumeExpansion', '<unset>'], ['MountOptions', '<none>'], ['ReclaimPolicy', o.reclaimPolicy ?? 'Delete'], ['VolumeBindingMode', o.volumeBindingMode ?? 'Immediate']], 22);
      return out + 'Events:                <none>\n';
    }
  }
  return kv([['Name', m.name]]);
}
