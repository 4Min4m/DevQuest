/** NetworkPolicy evaluation (what a policy-enforcing CNI like Calico or kindnet ≥0.21 decides). */
import { getObj, listObjs, matches } from './cluster';
import type { J, KObj, KubeState } from './types';

/** A connection's source: a pod, or an address outside the pod network (node, host). */
export type Source = { pod: KObj } | { ip: string };

function ipToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const n = Number(bits ?? 32);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
}

function selects(pol: KObj, pod: KObj): boolean {
  if (pol.metadata.namespace !== pod.metadata.namespace) return false;
  const sel = pol.spec.podSelector ?? {};
  return (!sel.matchLabels && !sel.matchExpressions) || matches(pod.metadata.labels, sel);
}

function types(pol: KObj): string[] {
  return pol.spec.policyTypes ?? (pol.spec.egress ? ['Ingress', 'Egress'] : ['Ingress']);
}

/** Does a `from`/`to` peer match this endpoint? `policyNs` is the policy's namespace. */
function peerMatches(ks: KubeState, peer: J, policyNs: string, end: Source): boolean {
  if (peer.ipBlock) {
    const ip = 'pod' in end ? end.pod.status?.podIP : end.ip;
    if (!ip || !inCidr(ip, peer.ipBlock.cidr)) return false;
    return !(peer.ipBlock.except ?? []).some((c: string) => inCidr(ip, c));
  }
  if (!('pod' in end)) return false;
  const pod = end.pod;
  if (peer.namespaceSelector) {
    const ns = getObj(ks, 'Namespace', undefined, pod.metadata.namespace!);
    const empty = !peer.namespaceSelector.matchLabels && !peer.namespaceSelector.matchExpressions;
    if (!empty && !matches(ns?.metadata.labels, peer.namespaceSelector)) return false;
  } else if (pod.metadata.namespace !== policyNs) return false;
  if (peer.podSelector) {
    const empty = !peer.podSelector.matchLabels && !peer.podSelector.matchExpressions;
    if (!empty && !matches(pod.metadata.labels, peer.podSelector)) return false;
  }
  return true;
}

/** Does a rule's `ports` list allow this destination port (number, or the named container port)? */
function portMatches(rulePorts: J[] | undefined, port: number, protocol: string, dst: KObj | null): boolean {
  if (!rulePorts?.length) return true;
  return rulePorts.some((p) => {
    if ((p.protocol ?? 'TCP') !== protocol) return false;
    if (p.port === undefined) return true;
    if (typeof p.port === 'number') return p.endPort ? port >= p.port && port <= p.endPort : port === p.port;
    const named = (dst?.spec.containers ?? []).flatMap((c: J) => c.ports ?? []).find((cp: J) => cp.name === p.port);
    return named?.containerPort === port;
  });
}

/** Is `dst` (a pod) allowed to receive this connection by the policies in its namespace? */
export function ingressAllowed(ks: KubeState, src: Source, dst: KObj, port: number, protocol = 'TCP'): boolean {
  const pols = listObjs(ks, 'NetworkPolicy', dst.metadata.namespace).filter((p) => types(p).includes('Ingress') && selects(p, dst));
  if (!pols.length) return true;
  return pols.some((p) => (p.spec.ingress ?? []).some((r: J) => portMatches(r.ports, port, protocol, dst) && (!r.from?.length || r.from.some((peer: J) => peerMatches(ks, peer, p.metadata.namespace!, src)))));
}

/** May `src` (a pod) open this connection, by the egress policies in its namespace? */
export function egressAllowed(ks: KubeState, src: KObj, dst: Source, port: number, protocol = 'TCP'): boolean {
  const pols = listObjs(ks, 'NetworkPolicy', src.metadata.namespace).filter((p) => types(p).includes('Egress') && selects(p, src));
  if (!pols.length) return true;
  const dstPod = 'pod' in dst ? dst.pod : null;
  return pols.some((p) => (p.spec.egress ?? []).some((r: J) => portMatches(r.ports, port, protocol, dstPod) && (!r.to?.length || r.to.some((peer: J) => peerMatches(ks, peer, p.metadata.namespace!, dst)))));
}

/** Both directions: what a CNI enforces for one pod-to-pod connection. */
export function connectionAllowed(ks: KubeState, src: Source, dst: KObj, port: number): boolean {
  if ('pod' in src && !egressAllowed(ks, src.pod, { pod: dst }, port)) return false;
  return ingressAllowed(ks, src, dst, port);
}

/** Can this pod reach cluster DNS (CoreDNS on UDP 53)? */
export function dnsAllowed(ks: KubeState, src: KObj): boolean {
  const dns = listObjs(ks, 'Pod', 'kube-system').filter((p) => p.metadata.labels?.['k8s-app'] === 'kube-dns');
  if (!dns.length) return true;
  return dns.some((d) => egressAllowed(ks, src, { pod: d }, 53, 'UDP') && ingressAllowed(ks, { pod: src }, d, 53, 'UDP'));
}
