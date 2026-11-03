/** Cluster networking for curl: port-forwards and NodePorts from the host, cluster DNS from inside pods. */
import { LOCAL_HOSTS, registerHttpProvider } from '../net';
import type { HttpResult } from '../net';
import { getObj, listObjs, NODES } from './cluster';
import { containerPort, podHttp, reconcile } from './controllers';
import type { KObj, KubeState } from './types';

let rr = 0;

function answer(r: ReturnType<typeof podHttp>): HttpResult {
  if (r.error) return { kind: 'error', code: r.errorCode ?? 7, message: r.errorCode === 52 ? 'Empty reply from server' : r.error };
  return { kind: 'response', res: { status: r.status ?? 200, body: r.body ?? '', headers: { 'Content-Type': 'text/html' } } };
}

/** Route through a Service to one of its ready endpoints (round robin, like kube-proxy). */
export function viaService(ks: KubeState, svc: KObj, port: number, path: string, now: number, silent: boolean): HttpResult {
  const sp = (svc.spec.ports ?? []).find((p: { port: number; nodePort?: number }) => p.port === port || p.nodePort === port);
  const host = svc.metadata.name;
  if (!sp) return { kind: 'error', code: 28, message: `Failed to connect to ${host} port ${port} after 130000 ms: Connection timed out` };
  const ep = getObj(ks, 'Endpoints', svc.metadata.namespace, svc.metadata.name);
  const addrs = (ep?.subsets ?? []).flatMap((s: { addresses?: { ip: string; targetRef: { name: string } }[] }) => s.addresses ?? []);
  if (!addrs.length) return { kind: 'error', code: 7, message: `Failed to connect to ${host} port ${port} after 1 ms: Couldn't connect to server` };
  const pick = addrs[(silent ? 0 : rr++) % addrs.length];
  const pod = getObj(ks, 'Pod', svc.metadata.namespace, pick.targetRef.name);
  if (!pod) return { kind: 'error', code: 7, message: `Failed to connect to ${host} port ${port}: Couldn't connect to server` };
  const target = containerPort(pod, sp.targetPort ?? sp.port) ?? port;
  return answer(podHttp(ks, pod, target, path, now, { log: silent ? undefined : '10.244.0.1' }));
}

/** Resolve a hostname the way a pod's resolver would (search path: ns.svc.cluster.local). */
function lookupService(ks: KubeState, host: string, fromNs: string): KObj | undefined {
  const parts = host.replace(/\.$/, '').split('.');
  if (parts.length === 1) return getObj(ks, 'Service', fromNs, parts[0]);
  if (parts.length === 2 || (parts[2] === 'svc' && (parts.length === 3 || parts.slice(3).join('.') === 'cluster.local'))) return getObj(ks, 'Service', parts[1], parts[0]);
  return undefined;
}

registerHttpProvider((state, req, opts) => {
  const host = state.context?.host ?? state;
  if (!host.kube) return undefined;
  const ks = host.kube;
  const pod = state.context?.kubePod;
  // From the host machine: kubectl port-forward and NodePorts.
  if (!state.context) {
    if (LOCAL_HOSTS.has(req.host)) {
      const fwd = ks.forwards.find((f) => f.localPort === req.port);
      if (!fwd) return undefined;
      reconcile(host);
      const target = getObj(ks, 'Pod', fwd.namespace, fwd.target);
      if (!target || target.metadata.deletionTimestamp) {
        ks.forwards = ks.forwards.filter((f) => f !== fwd);
        return { kind: 'error', code: 52, message: 'Empty reply from server' };
      }
      return answer(podHttp(ks, target, fwd.remotePort, req.path, host.clock, { log: opts.silent ? undefined : '127.0.0.1' }));
    }
    if (NODES.some((n) => n.ip === req.host)) {
      reconcile(host);
      const svc = listObjs(ks, 'Service').find((s) => (s.spec.ports ?? []).some((p: { nodePort?: number }) => p.nodePort === req.port));
      if (!svc) return { kind: 'error', code: 7, message: `Failed to connect to ${req.host} port ${req.port} after 0 ms: Couldn't connect to server` };
      return viaService(ks, svc, req.port, req.path, host.clock, !!opts.silent);
    }
    return undefined;
  }
  if (!pod) return undefined;
  // From inside a pod: cluster DNS, ClusterIPs and pod IPs.
  reconcile(host);
  const svc = lookupService(ks, req.host, pod.namespace) ?? listObjs(ks, 'Service').find((s) => s.spec.clusterIP === req.host);
  if (svc) return viaService(ks, svc, req.port, req.path, host.clock, !!opts.silent);
  const target = listObjs(ks, 'Pod').find((p) => p.status?.podIP === req.host);
  if (target) return answer(podHttp(ks, target, req.port, req.path, host.clock, { log: opts.silent ? undefined : '10.244.0.1' }));
  if (LOCAL_HOSTS.has(req.host)) {
    const self = getObj(ks, 'Pod', pod.namespace, pod.name);
    if (self) return answer(podHttp(ks, self, req.port, req.path, host.clock, {}));
  }
  return { kind: 'error', code: 6, message: `Could not resolve host: ${req.host}` };
}, -5);
