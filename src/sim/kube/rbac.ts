/** RBAC authorization: who may do what, from Roles, ClusterRoles and their bindings. */
import { getObj, listObjs, ResourceInfo } from './cluster';
import type { J, KubeState } from './types';

export interface Identity {
  user: string;
  groups: string[];
}

export const ADMIN: Identity = { user: 'kubernetes-admin', groups: ['kubeadm:cluster-admins', 'system:authenticated'] };

/** The identity `--as` / `--as-group` impersonate. */
export function impersonate(as: string, groups: string[]): Identity {
  const sa = /^system:serviceaccount:([^:]+):([^:]+)$/.exec(as);
  const base = sa ? ['system:serviceaccounts', `system:serviceaccounts:${sa[1]}`] : [];
  return { user: as, groups: [...new Set([...base, ...groups, 'system:authenticated'])] };
}

export interface Request {
  verb: string;
  /** Plural resource, optionally with a subresource: "pods", "pods/log". */
  resource: string;
  group: string;
  /** Undefined for cluster-scoped requests. */
  namespace?: string;
  name?: string;
}

function subjectMatches(id: Identity, s: J, bindingNs?: string): boolean {
  if (s.kind === 'User') return s.name === id.user;
  if (s.kind === 'Group') return id.groups.includes(s.name);
  if (s.kind === 'ServiceAccount') return id.user === `system:serviceaccount:${s.namespace ?? bindingNs}:${s.name}`;
  return false;
}

function ruleAllows(rule: J, req: Request): boolean {
  const has = (list: string[] | undefined, v: string) => (list ?? []).includes('*') || (list ?? []).includes(v);
  if (!has(rule.verbs, req.verb)) return false;
  if (!has(rule.apiGroups, req.group)) return false;
  const [res, sub] = req.resource.split('/');
  const resources: string[] = rule.resources ?? [];
  const resOk = resources.includes('*') || resources.includes(req.resource) || (sub !== undefined && resources.includes(`${res}/*`)) || (sub !== undefined && resources.includes(`*/${sub}`));
  if (!resOk) return false;
  if (rule.resourceNames?.length) return req.name !== undefined && rule.resourceNames.includes(req.name);
  return true;
}

function rulesOf(ks: KubeState, roleRef: J, ns?: string): J[] {
  const role = roleRef.kind === 'ClusterRole' ? getObj(ks, 'ClusterRole', undefined, roleRef.name) : getObj(ks, 'Role', ns, roleRef.name);
  return role?.rules ?? [];
}

/** The rules that apply to `id` in namespace `ns` (cluster-wide rules included). */
export function rulesFor(ks: KubeState, id: Identity, ns?: string): J[] {
  if (id.groups.includes('system:masters')) return [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }];
  const out: J[] = [];
  for (const b of listObjs(ks, 'ClusterRoleBinding')) if ((b.subjects ?? []).some((s: J) => subjectMatches(id, s))) out.push(...rulesOf(ks, b.roleRef));
  if (ns) for (const b of listObjs(ks, 'RoleBinding', ns)) if ((b.subjects ?? []).some((s: J) => subjectMatches(id, s, ns))) out.push(...rulesOf(ks, b.roleRef, ns));
  return out;
}

export function allowed(ks: KubeState, id: Identity, req: Request): boolean {
  return rulesFor(ks, id, req.namespace).some((r) => ruleAllows(r, req));
}

export const groupOf = (r: ResourceInfo) => (r.apiVersion.includes('/') ? r.apiVersion.split('/')[0] : '');

/** "pods is forbidden: User "x" cannot list resource "pods" in API group "" in the namespace "default"" */
export function forbiddenMessage(id: Identity, req: Request): string {
  const res = req.resource.split('/')[0];
  const gr = req.group ? `${res}.${req.group}` : res;
  const what = req.name !== undefined ? `${gr} "${req.name}"` : gr;
  const scope = req.namespace !== undefined ? `in the namespace "${req.namespace}"` : 'at the cluster scope';
  return `${what} is forbidden: User "${id.user}" cannot ${req.verb} resource "${req.resource}" in API group "${req.group}" ${scope}`;
}
