/** Node maintenance (cordon/drain/taint), autoscale, auth, and the RBAC/cronjob/ingress `create` generators. */
import { getObj, infoOf, listObjs, qualified, resourceFor } from '../cluster';
import { advance, deletePod, isTerminating } from '../controllers';
import { table } from '../printers';
import { groupOf, impersonate, rulesFor } from '../rbac';
import type { J, KObj } from '../types';
import { authorize, findOne, Flags, KCtx, KubectlError, namespaceOf, parseFlags, resolveResource } from './common';

// ------------------------------------------------------------------ nodes

function nodesFrom(k: KCtx, f: Flags, verb: string): KObj[] {
  const res = infoOf('Node');
  const names = f.args[0] === 'node' || f.args[0] === 'nodes' || f.args[0] === 'no' ? f.args.slice(1) : f.args.map((a) => a.replace(/^nodes?\//, ''));
  if (!names.length) throw new KubectlError(`error: USAGE: ${verb} NODE [flags]\nSee 'kubectl ${verb} -h' for help and examples`);
  return names.map((n) => {
    authorize(k, 'get', res, undefined, n);
    const node = findOne(k, res, '', n);
    authorize(k, 'patch', res, undefined, n);
    return node;
  });
}

function setUnschedulable(k: KCtx, node: KObj, on: boolean): string {
  const name = node.metadata.name;
  if (!!node.spec.unschedulable === on) return `node/${name} already ${on ? 'cordoned' : 'uncordoned'}`;
  if (on) {
    node.spec.unschedulable = true;
    node.spec.taints = [...(node.spec.taints ?? []).filter((t: J) => t.key !== 'node.kubernetes.io/unschedulable'), { effect: 'NoSchedule', key: 'node.kubernetes.io/unschedulable', timeAdded: new Date(k.now).toISOString().replace(/\.\d+Z$/, 'Z') }];
  } else {
    delete node.spec.unschedulable;
    node.spec.taints = (node.spec.taints ?? []).filter((t: J) => t.key !== 'node.kubernetes.io/unschedulable');
    if (!node.spec.taints.length) delete node.spec.taints;
  }
  return `node/${name} ${on ? 'cordoned' : 'uncordoned'}`;
}

export function kubectlCordon(k: KCtx, argv: string[], on: boolean): number {
  const f = parseFlags(on ? 'cordon' : 'uncordon', argv, { value: ['l', 'selector', 'dry-run'], alias: { l: 'selector' } });
  for (const n of nodesFrom(k, f, on ? 'cordon' : 'uncordon')) k.out(setUnschedulable(k, n, on) + '\n');
  return 0;
}

const isMirror = (p: KObj) => !p.metadata.ownerReferences?.length && p.metadata.labels?.tier === 'control-plane';

export function kubectlDrain(k: KCtx, argv: string[]): number {
  const f = parseFlags('drain', argv, {
    bool: ['ignore-daemonsets', 'force', 'delete-emptydir-data', 'disable-eviction'],
    value: ['grace-period', 'timeout', 'l', 'selector', 'pod-selector', 'dry-run', 'skip-wait-for-delete-timeout'],
    alias: { l: 'selector' },
  });
  let code = 0;
  for (const node of nodesFrom(k, f, 'drain')) {
    const name = node.metadata.name;
    k.out(setUnschedulable(k, node, true) + '\n');
    const pods = listObjs(k.ks, 'Pod').filter((p) => p.spec.nodeName === name && !isTerminating(p) && !isMirror(p) && !['Succeeded', 'Failed'].includes(p.status?.phase));
    const ref = (p: KObj) => `${p.metadata.namespace}/${p.metadata.name}`;
    const ds = pods.filter((p) => p.metadata.ownerReferences?.some((r) => r.kind === 'DaemonSet'));
    const bare = pods.filter((p) => !p.metadata.ownerReferences?.length);
    const local = pods.filter((p) => (p.spec.volumes ?? []).some((v: J) => v.emptyDir));
    const problems: string[] = [];
    if (ds.length && !f.flags['ignore-daemonsets']) problems.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${ds.map(ref).join(', ')}`);
    if (bare.length && !f.flags.force) problems.push(`cannot delete Pods declare no controller (use --force to override): ${bare.map(ref).join(', ')}`);
    if (local.length && !f.flags['delete-emptydir-data']) problems.push(`cannot delete Pods with local storage (use --delete-emptydir-data to override): ${local.map(ref).join(', ')}`);
    if (problems.length) {
      k.err(`error: unable to drain node "${name}" due to error: [${problems.join(', ')}], continuing command...\nThere are pending nodes to be drained:\n ${name}\n${problems.join('\n')}\n`);
      code = 1;
      continue;
    }
    const warnings: string[] = [];
    if (ds.length) warnings.push(`ignoring DaemonSet-managed Pods: ${ds.map(ref).join(', ')}`);
    if (bare.length) warnings.push(`deleting Pods that declare no controller: ${bare.map(ref).join(', ')}`);
    if (warnings.length) k.err(`Warning: ${warnings.join('; ')}\n`);
    const victims = pods.filter((p) => !ds.includes(p));
    for (const p of victims) {
      authorize(k, 'create', infoOf('Pod'), p.metadata.namespace, p.metadata.name, 'eviction');
      k.out(`evicting pod ${ref(p)}\n`);
      deletePod(k.ks, k.now, p);
    }
    // Wait for the evicted pods to be gone.
    for (let i = 0; i < 60 && victims.some((p) => getObj(k.ks, 'Pod', p.metadata.namespace, p.metadata.name)?.metadata.uid === p.metadata.uid); i++) advance(k.ctx.state, 1000);
    for (const p of victims) k.out(`pod/${p.metadata.name} evicted\n`);
    k.out(`node/${name} drained\n`);
  }
  return code;
}

const EFFECTS = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'];

export function kubectlTaint(k: KCtx, argv: string[]): number {
  const f = parseFlags('taint', argv, { bool: ['overwrite', 'all'], value: ['l', 'selector', 'dry-run', 'o', 'output'], alias: { l: 'selector', o: 'output' } });
  const [type, ...rest] = f.args;
  if (!type) throw new KubectlError("error: at least one taint update is required\nSee 'kubectl taint -h' for help and examples");
  let nodeNames: string[];
  let specs: string[];
  if (type.includes('/')) {
    nodeNames = [type.split('/')[1]];
    specs = rest;
  } else {
    if (!['node', 'nodes', 'no'].includes(type)) throw new KubectlError(`error: invalid resource type ${type}, only node types are supported`);
    nodeNames = f.flags.all ? listObjs(k.ks, 'Node').map((n) => n.metadata.name) : rest.slice(0, 1);
    specs = f.flags.all ? rest : rest.slice(1);
  }
  if (!specs.length) throw new KubectlError("error: at least one taint update is required\nSee 'kubectl taint -h' for help and examples");
  for (const name of nodeNames) {
    authorize(k, 'patch', infoOf('Node'), undefined, name);
    const node = findOne(k, infoOf('Node'), '', name);
    const taints: J[] = [...(node.spec.taints ?? [])];
    let added = false;
    let removed = false;
    for (const spec of specs) {
      if (spec.endsWith('-')) {
        const m = /^([^=:]+)(?:=[^:]*)?(?::(\w+))?-$/.exec(spec);
        if (!m) throw new KubectlError(`error: invalid taint spec: ${spec}`);
        const before = taints.length;
        for (let i = taints.length - 1; i >= 0; i--) if (taints[i].key === m[1] && (!m[2] || taints[i].effect === m[2])) taints.splice(i, 1);
        if (taints.length === before) throw new KubectlError(`error: taint "${m[1]}${m[2] ? ':' + m[2] : ''}" not found`);
        removed = true;
        continue;
      }
      const m = /^([^=:]+)(?:=([^:]*))?:(\w+)$/.exec(spec);
      if (!m) throw new KubectlError(`error: invalid taint spec: ${spec}, unknown taint effect`);
      if (!EFFECTS.includes(m[3])) throw new KubectlError(`error: invalid taint effect: ${m[3]}, unsupported taint effect`);
      const existing = taints.findIndex((t) => t.key === m[1] && t.effect === m[3]);
      if (existing >= 0 && !f.flags.overwrite) throw new KubectlError(`error: node ${name} already has ${m[1]} taint(s) with same effect(s) and --overwrite is false`);
      const taint: J = { effect: m[3], key: m[1], ...(m[2] ? { value: m[2] } : {}) };
      if (m[3] === 'NoExecute') taint.timeAdded = new Date(k.now).toISOString().replace(/\.\d+Z$/, 'Z');
      if (existing >= 0) taints[existing] = taint;
      else taints.push(taint);
      added = true;
    }
    if (taints.length) node.spec.taints = taints;
    else delete node.spec.taints;
    k.out(`node/${name} ${added && !removed ? 'tainted' : removed && !added ? 'untainted' : 'modified'}\n`);
  }
  return 0;
}

// ------------------------------------------------------------------ autoscale

export function kubectlAutoscale(k: KCtx, argv: string[]): number {
  const f = parseFlags('autoscale', argv, { value: ['min', 'max', 'cpu-percent', 'name', 'o', 'output', 'dry-run'], alias: { o: 'output' } });
  const ns = namespaceOf(k, f);
  const args = f.args[0]?.includes('/') ? f.args[0].split('/') : f.args;
  if (args.length < 2) throw new KubectlError("error: You must provide one or more resources by argument or filename.\nSee 'kubectl autoscale -h' for help and examples");
  const res = resolveResource(args[0]);
  if (!['Deployment', 'ReplicaSet', 'StatefulSet'].includes(res.kind)) throw new KubectlError(`error: cannot autoscale a ${res.kind}: ${res.kind.toLowerCase()} does not support scale`);
  const target = findOne(k, res, ns, args[1]);
  const max = Number(f.flags.max ?? -1);
  if (!(max >= 1)) throw new KubectlError(`error: --max=MAXPODS is required and must be at least 1, max: ${f.flags.max ?? -1}`);
  const min = f.flags.min !== undefined ? Number(f.flags.min) : undefined;
  if (min !== undefined && min > max) throw new KubectlError(`error: --max=MAXPODS must be larger or equal to --min=MINPODS, max: ${max}, min: ${min}`);
  const name = (f.flags.name as string) ?? target.metadata.name;
  const hpaRes = infoOf('HorizontalPodAutoscaler');
  authorize(k, 'create', hpaRes, ns);
  if (getObj(k.ks, 'HorizontalPodAutoscaler', ns, name)) throw new KubectlError(`Error from server (AlreadyExists): horizontalpodautoscalers.autoscaling "${name}" already exists`);
  const manifest: J = {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name, namespace: ns },
    spec: {
      scaleTargetRef: { apiVersion: res.apiVersion, kind: res.kind, name: target.metadata.name },
      ...(min !== undefined ? { minReplicas: min } : {}),
      maxReplicas: max,
      ...(f.flags['cpu-percent'] ? { metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: Number(f.flags['cpu-percent']) } } }] } : {}),
    },
  };
  return createViaAdmission(k, f, manifest, 'autoscaled');
}

/** Admission + store, like the generators of `kubectl create`. Set by workloads.ts to avoid an import cycle. */
let createViaAdmission: (k: KCtx, f: Flags, manifest: J, verb?: string) => number = () => 1;
export function setCreator(fn: typeof createViaAdmission): void {
  createViaAdmission = fn;
}

// ------------------------------------------------------------------ auth

export function kubectlAuth(k: KCtx, argv: string[]): number {
  const [sub, ...rest] = argv;
  if (sub === 'whoami') {
    parseFlags('auth whoami', rest, { value: ['o', 'output'], alias: { o: 'output' } });
    k.out(table([['ATTRIBUTE', 'VALUE'], ['Username', k.id.user], ['Groups', `[${k.id.groups.join(' ')}]`]]));
    return 0;
  }
  if (sub !== 'can-i') throw new KubectlError(`error: unknown command "${sub ?? ''}" for "kubectl auth"\nAvailable Commands: can-i, reconcile, whoami`);
  const f = parseFlags('auth can-i', rest, { bool: ['list', 'q', 'quiet', 'no-headers'], value: ['subresource'], alias: { q: 'quiet' } });
  const ns = f.flags['all-namespaces'] ? undefined : namespaceOf(k, f);
  if (f.flags.list) {
    const rules = rulesFor(k.ks, k.id, ns);
    const rows = rules
      .filter((r) => r.resources)
      .flatMap((r) => (r.resources as string[]).map((res) => [r.apiGroups?.[0] && r.apiGroups[0] !== '' && res !== '*' ? `${res}.${r.apiGroups[0]}` : r.apiGroups?.[0] === '*' ? `${res}.*` : res, '[]', `[${(r.resourceNames ?? []).join(' ')}]`, `[${(r.verbs ?? []).join(' ')}]`]));
    const nonRes = rules.filter((r) => r.nonResourceURLs).map((r) => ['', `[${r.nonResourceURLs.join(' ')}]`, '[]', `[${r.verbs.join(' ')}]`]);
    const base = [['selfsubjectreviews.authentication.k8s.io', '[]', '[]', '[create]'], ['selfsubjectaccessreviews.authorization.k8s.io', '[]', '[]', '[create]'], ['selfsubjectrulesreviews.authorization.k8s.io', '[]', '[]', '[create]']];
    k.out(table([['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], ...rows, ...base, ...nonRes]));
    return 0;
  }
  const [verb, what] = f.args;
  if (!verb || !what) throw new KubectlError("error: you must specify two arguments: verb resource or verb resource/resourceName.\nSee 'kubectl auth can-i -h' for help and examples");
  const [typeWithSub, name] = what.split('/').length === 3 ? [what.split('/').slice(0, 2).join('/'), what.split('/')[2]] : what.includes('/') && !/^[a-z]+\/(log|exec|scale|status|portforward|attach|eviction|proxy)$/.test(what) ? what.split('/') : [what, undefined];
  const [type, subFromType] = typeWithSub.split('/');
  const subres = (f.flags.subresource as string | undefined) ?? subFromType;
  let resource: string;
  let group: string;
  let namespaced = true;
  if (type === '*') {
    resource = '*';
    group = '*';
  } else {
    const info = resourceFor(type);
    if (!info) {
      k.err(`Warning: the server doesn't have a resource type '${type}'\n\n`);
      resource = type.split('.')[0];
      group = type.includes('.') ? type.slice(type.indexOf('.') + 1) : '';
    } else {
      resource = info.plural;
      group = groupOf(info);
      namespaced = info.namespaced;
    }
  }
  const req = { verb, resource: subres ? `${resource}/${subres}` : resource, group, namespace: namespaced ? ns : undefined, name };
  const ok = rulesFor(k.ks, k.id, req.namespace).some((r) => {
    const has = (list: string[] | undefined, v: string) => (list ?? []).includes('*') || (list ?? []).includes(v);
    if (!has(r.verbs, verb) || !has(r.apiGroups, group)) return false;
    if (!(r.resources ?? []).includes('*') && !(r.resources ?? []).includes(req.resource)) return false;
    if (r.resourceNames?.length) return name !== undefined && r.resourceNames.includes(name);
    return true;
  });
  if (!f.flags.quiet) k.out(ok ? 'yes\n' : 'no\n');
  return ok ? 0 : 1;
}

/** Strip the global impersonation flags; returns the identity they ask for (or null). */
export function takeImpersonation(args: string[]): { args: string[]; as: string | null; groups: string[] } {
  const out: string[] = [];
  let as: string | null = null;
  const groups: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i));
      break;
    }
    const m = /^--(as|as-group)(?:=(.*))?$/.exec(a);
    if (!m) {
      out.push(a);
      continue;
    }
    const v = m[2] ?? args[++i];
    if (v === undefined) throw new KubectlError(`error: flag needs an argument: --${m[1]}`);
    if (m[1] === 'as') as = v;
    else groups.push(v);
  }
  if (groups.length && as === null) throw new KubectlError('error: requesting uid, groups or user-extra for test without impersonating a user');
  return { args: out, as, groups };
}

export { impersonate };

// ------------------------------------------------------------------ create generators

/** `--resource=pods,deployments.apps,pods/log` → rules grouped by API group. */
function rulesFromFlags(f: Flags): J[] {
  const verbs = (f.multi.verb ?? []).flatMap((v) => v.split(',')).filter(Boolean);
  const resources = (f.multi.resource ?? []).flatMap((v) => v.split(',')).filter(Boolean);
  const names = (f.multi['resource-name'] ?? []).flatMap((v) => v.split(',')).filter(Boolean);
  if (!verbs.length) throw new KubectlError('error: at least one verb must be specified');
  if (!resources.length && !f.multi['non-resource-url']) throw new KubectlError('error: at least one resource must be specified');
  const VALID = ['*', 'get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', 'use', 'bind', 'escalate', 'impersonate'];
  for (const v of verbs) if (!VALID.includes(v)) throw new KubectlError(`error: invalid verb: '${v}'`);
  const byGroup = new Map<string, string[]>();
  for (const r of resources) {
    const [base, sub] = r.split('/');
    const info = base === '*' ? null : resourceFor(base);
    if (base !== '*' && !info) throw new KubectlError(`error: the server doesn't have a resource type "${base}"`);
    const group = info ? groupOf(info) : '';
    const plural = info ? info.plural : '*';
    byGroup.set(group, [...(byGroup.get(group) ?? []), sub ? `${plural}/${sub}` : plural]);
  }
  return [...byGroup.entries()].map(([g, res]) => ({ apiGroups: [g], resources: res, ...(names.length ? { resourceNames: names } : {}), verbs }));
}

function subjectsFromFlags(f: Flags): J[] {
  const subs: J[] = [];
  for (const u of f.multi.user ?? []) subs.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: u });
  for (const g of f.multi.group ?? []) subs.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: g });
  for (const sa of f.multi.serviceaccount ?? []) {
    const [ns, name] = sa.split(':');
    if (!ns || !name) throw new KubectlError('error: serviceaccount must be <namespace>:<name>');
    subs.push({ kind: 'ServiceAccount', name, namespace: ns });
  }
  return subs;
}

export const CREATE_EXTRA_FLAGS = ['verb', 'resource', 'resource-name', 'non-resource-url', 'role', 'clusterrole', 'user', 'group', 'serviceaccount', 'class', 'rule', 'default-backend', 'annotation'];

/** `kubectl create role|rolebinding|clusterrole|clusterrolebinding|serviceaccount|cronjob|ingress`; null when `what` is not one of them. */
export function createExtra(f: Flags, what: string, name: string | undefined): J | null {
  const ns = f.flags.namespace ? { namespace: f.flags.namespace as string } : {};
  const need = () => {
    if (!name) throw new KubectlError('error: exactly one NAME is required, got 0');
    return name;
  };
  switch (what) {
    case 'role':
    case 'clusterrole':
      need();
      return { apiVersion: 'rbac.authorization.k8s.io/v1', kind: what === 'role' ? 'Role' : 'ClusterRole', metadata: { creationTimestamp: null, name, ...(what === 'role' ? ns : {}) }, rules: rulesFromFlags(f) };
    case 'rolebinding':
    case 'clusterrolebinding': {
      need();
      const role = f.flags.role as string | undefined;
      const cr = f.flags.clusterrole as string | undefined;
      if (what === 'clusterrolebinding' && role) throw new KubectlError('error: unknown flag: --role');
      if (!!role === !!cr) throw new KubectlError(what === 'rolebinding' ? 'error: exactly one of clusterrole or role must be specified' : 'error: required flag(s) "clusterrole" not set');
      return {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: what === 'rolebinding' ? 'RoleBinding' : 'ClusterRoleBinding',
        metadata: { creationTimestamp: null, name, ...(what === 'rolebinding' ? ns : {}) },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: role ? 'Role' : 'ClusterRole', name: role ?? cr },
        subjects: subjectsFromFlags(f),
      };
    }
    case 'serviceaccount':
    case 'sa':
      need();
      return { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { creationTimestamp: null, name, ...ns } };
    case 'cronjob':
    case 'cj': {
      need();
      if (!f.flags.image) throw new KubectlError('error: required flag(s) "image" not set');
      if (!f.flags.schedule) throw new KubectlError('error: required flag(s) "schedule" not set');
      const container: J = { image: f.flags.image, name, resources: {} };
      if (f.rest?.length) container.command = f.rest;
      return {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata: { creationTimestamp: null, name, ...ns },
        spec: { jobTemplate: { metadata: { creationTimestamp: null, name }, spec: { template: { metadata: { creationTimestamp: null }, spec: { containers: [container], restartPolicy: (f.flags.restart as string) ?? 'OnFailure' } } } }, schedule: f.flags.schedule },
        status: {},
      };
    }
    case 'ingress':
    case 'ing': {
      need();
      const rules: J[] = [];
      for (const spec of f.multi.rule ?? []) {
        const m = /^([^/=]*)(\/[^=]*)=([^:,]+):([^,]+)(,tls(=.*)?)?$/.exec(spec);
        if (!m) throw new KubectlError(`error: rule ${spec} is invalid and should be in format host/path=svcname:svcport[,tls[=secret]]`);
        const [, host, rawPath, svc, port] = m;
        const prefix = rawPath.endsWith('*');
        const path = prefix ? rawPath.slice(0, -1) || '/' : rawPath;
        const backend = { service: { name: svc, port: /^\d+$/.test(port) ? { number: Number(port) } : { name: port } } };
        let rule = rules.find((r) => (r.host ?? '') === host);
        if (!rule) {
          rule = { ...(host ? { host } : {}), http: { paths: [] } };
          rules.push(rule);
        }
        rule.http.paths.push({ backend, path, pathType: prefix ? 'Prefix' : 'Exact' });
      }
      if (!rules.length && !f.flags['default-backend']) throw new KubectlError('error: not enough information provided: every ingress has to either specify a default-backend (which catches all traffic) or a list of rules (which catch specific paths)');
      const annotations = Object.fromEntries((f.multi.annotation ?? []).map((a) => [a.split('=')[0], a.split('=').slice(1).join('=')]));
      return {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: { ...(Object.keys(annotations).length ? { annotations } : {}), creationTimestamp: null, name, ...ns },
        spec: { ...(f.flags.class ? { ingressClassName: f.flags.class } : {}), rules },
        status: { loadBalancer: {} },
      };
    }
  }
  return null;
}

export { qualified };
