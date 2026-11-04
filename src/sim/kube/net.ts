/**
 * Cluster networking for curl: port-forwards, NodePorts and the ingress-nginx controller (host port 80)
 * from the host; cluster DNS, Services and pod IPs from inside pods. NetworkPolicies are enforced on
 * pod-to-pod traffic.
 */
import { LOCAL_HOSTS, registerHttpProvider } from '../net';
import type { HttpResult, Request } from '../net';
import { resolveHost } from '../netsim/resolve';
import { getObj, listObjs, NODES } from './cluster';
import { containerPort, isPodReady, podHttp, reconcile } from './controllers';
import { isNginxClass } from './extra';
import { connectionAllowed, dnsAllowed, Source } from './netpol';
import type { J, KObj, KubeState } from './types';

let rr = 0;

function answer(r: ReturnType<typeof podHttp>): HttpResult {
  if (r.error) return { kind: 'error', code: r.errorCode ?? 7, message: r.errorCode === 52 ? 'Empty reply from server' : r.error };
  return { kind: 'response', res: { status: r.status ?? 200, body: r.body ?? '', headers: { 'Content-Type': 'text/html' } } };
}

const timedOut = (host: string, port: number): HttpResult => ({ kind: 'error', code: 28, message: `Failed to connect to ${host} port ${port} after 130000 ms: Connection timed out` });

/** Route through a Service to one of its ready endpoints (round robin, like kube-proxy). */
export function viaService(ks: KubeState, svc: KObj, port: number, path: string, now: number, silent: boolean, src: Source = { ip: '10.244.0.1' }): HttpResult {
  const sp = (svc.spec.ports ?? []).find((p: { port: number; nodePort?: number }) => p.port === port || p.nodePort === port);
  const host = svc.metadata.name;
  if (!sp) return timedOut(host, port);
  const pod = pickEndpoint(ks, svc, silent);
  if (!pod) return { kind: 'error', code: 7, message: `Failed to connect to ${host} port ${port} after 1 ms: Couldn't connect to server` };
  const target = containerPort(pod, sp.targetPort ?? sp.port) ?? port;
  if (!connectionAllowed(ks, src, pod, target)) return timedOut(host, port);
  return answer(podHttp(ks, pod, target, path, now, { log: silent ? undefined : 'pod' in src ? src.pod.status?.podIP : src.ip }));
}

function pickEndpoint(ks: KubeState, svc: KObj, silent: boolean): KObj | undefined {
  const ep = getObj(ks, 'Endpoints', svc.metadata.namespace, svc.metadata.name);
  const addrs = (ep?.subsets ?? []).flatMap((s: { addresses?: { ip: string; targetRef: { name: string } }[] }) => s.addresses ?? []);
  if (!addrs.length) return undefined;
  const pick = addrs[(silent ? 0 : rr++) % addrs.length];
  return getObj(ks, 'Pod', svc.metadata.namespace, pick.targetRef.name);
}

/** Resolve a hostname the way a pod's resolver would (search path: ns.svc.cluster.local). */
function lookupService(ks: KubeState, host: string, fromNs: string): KObj | undefined {
  const parts = host.replace(/\.$/, '').split('.');
  if (parts.length === 1) return getObj(ks, 'Service', fromNs, parts[0]);
  if (parts.length === 2 || (parts[2] === 'svc' && (parts.length === 3 || parts.slice(3).join('.') === 'cluster.local'))) return getObj(ks, 'Service', parts[1], parts[0]);
  return undefined;
}

// ------------------------------------------------------------------ ingress-nginx

const page = (status: string) => `<html>\r\n<head><title>${status}</title></head>\r\n<body>\r\n<center><h1>${status}</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n`;
const nginxPage = (status: number, text: string): HttpResult => ({ kind: 'response', res: { status, body: page(`${status} ${text}`), headers: { 'Content-Type': 'text/html' } } });


function hostMatches(ruleHost: string | undefined, host: string): boolean {
  if (!ruleHost) return true;
  if (ruleHost.startsWith('*.')) {
    const rest = host.split('.').slice(1).join('.');
    return host.includes('.') && rest === ruleHost.slice(2);
  }
  return ruleHost === host;
}

function pathMatches(p: J, path: string): number {
  const want: string = p.path ?? '/';
  const type = p.pathType ?? 'Prefix';
  if (type === 'Exact') return path === want ? want.length + 1000 : -1;
  if (/[()[\]*+?^$|\\]/.test(want)) {
    try {
      return new RegExp('^' + want).test(path) ? want.length : -1;
    } catch {
      return -1;
    }
  }
  const a = want.split('/').filter(Boolean);
  const b = path.split('?')[0].split('/').filter(Boolean);
  return a.every((seg, i) => b[i] === seg) ? want.length : -1;
}

/** Which backend an nginx-class Ingress sends `host` + `path` to (longest match wins; host rules beat catch-all rules). */
export function ingressRoute(ks: KubeState, host: string, path: string): { ing: KObj; backend: J; upstreamPath: string } | null {
  const ings = listObjs(ks, 'Ingress').filter(isNginxClass);
  const specific = ings.flatMap((ing) => (ing.spec.rules ?? []).filter((r: J) => r.host && hostMatches(r.host, host)).map((r: J) => ({ ing, r })));
  const pool = specific.length ? specific : ings.flatMap((ing) => (ing.spec.rules ?? []).filter((r: J) => !r.host).map((r: J) => ({ ing, r })));
  let best: { ing: KObj; p: J; score: number } | null = null;
  for (const { ing, r } of pool) {
    for (const p of r.http?.paths ?? []) {
      const score = pathMatches(p, path);
      if (score >= 0 && (!best || score > best.score)) best = { ing, p, score };
    }
  }
  if (!best) {
    const def = ings.find((i) => i.spec.defaultBackend);
    return def ? { ing: def, backend: def.spec.defaultBackend, upstreamPath: path } : null;
  }
  const target = best.ing.metadata.annotations?.['nginx.ingress.kubernetes.io/rewrite-target'];
  let upstreamPath = path;
  if (target) {
    const want: string = best.p.path ?? '/';
    if (/[()]/.test(want)) {
      try {
        const m = new RegExp('^' + want).exec(path);
        upstreamPath = m ? target.replace(/\$(\d)/g, (_: string, i: string) => m[Number(i)] ?? '') : target;
      } catch {
        upstreamPath = target;
      }
    } else upstreamPath = target;
    if (!upstreamPath.startsWith('/')) upstreamPath = '/' + upstreamPath;
  }
  return { ing: best.ing, backend: best.p.backend, upstreamPath };
}

function controllerPod(ks: KubeState): KObj | undefined {
  return listObjs(ks, 'Pod', 'ingress-nginx').find((p) => p.metadata.labels?.['app.kubernetes.io/component'] === 'controller' && p.status?.phase === 'Running' && isPodReady(p) && !p.metadata.deletionTimestamp);
}

function viaIngress(ks: KubeState, req: Request, now: number, silent: boolean): HttpResult {
  const ctrl = controllerPod(ks);
  if (!ctrl) return { kind: 'error', code: 7, message: `Failed to connect to ${req.host} port ${req.port} after 0 ms: Couldn't connect to server` };
  const hostHeader = (req.headers?.host ?? req.host).replace(/:\d+$/, '').toLowerCase();
  const route = ingressRoute(ks, hostHeader, req.path || '/');
  if (!route?.backend?.service) return nginxPage(404, 'Not Found');
  const svc = getObj(ks, 'Service', route.ing.metadata.namespace, route.backend.service.name);
  if (!svc) return nginxPage(503, 'Service Temporarily Unavailable');
  const want = route.backend.service.port ?? {};
  const sp = (svc.spec.ports ?? []).find((p: J) => (want.number !== undefined ? p.port === want.number : p.name === want.name));
  if (!sp) return nginxPage(503, 'Service Temporarily Unavailable');
  const pod = pickEndpoint(ks, svc, silent);
  if (!pod) return nginxPage(503, 'Service Temporarily Unavailable');
  const target = containerPort(pod, sp.targetPort ?? sp.port) ?? sp.port;
  if (!connectionAllowed(ks, { pod: ctrl }, pod, target)) return nginxPage(504, 'Gateway Time-out');
  const r = podHttp(ks, pod, target, route.upstreamPath, now, { log: silent ? undefined : ctrl.status?.podIP });
  if (r.error) return nginxPage(502, 'Bad Gateway');
  return answer(r);
}

/** A request to the ingress controller with this Host header (for validators). */
export function ingressRequest(ks: KubeState, host: string, path: string, now: number): HttpResult {
  return viaIngress(ks, { key: `http://${host}${path}`, host: 'localhost', port: 80, path, method: 'GET', headers: { host } }, now, true);
}

// ------------------------------------------------------------------ provider

registerHttpProvider((state, req, opts) => {
  const host = state.context?.host ?? state;
  if (!host.kube) return undefined;
  const ks = host.kube;
  const pod = state.context?.kubePod;
  // From the host machine: kubectl port-forward, NodePorts, and the ingress controller on port 80.
  if (!state.context) {
    const ip = LOCAL_HOSTS.has(req.host) ? '127.0.0.1' : resolveHost(state, req.host);
    if (ip && (LOCAL_HOSTS.has(ip) || ip.startsWith('127.'))) {
      const fwd = ks.forwards.find((f) => f.localPort === req.port);
      if (fwd) {
        reconcile(host);
        const target = getObj(ks, 'Pod', fwd.namespace, fwd.target);
        if (!target || target.metadata.deletionTimestamp) {
          ks.forwards = ks.forwards.filter((f) => f !== fwd);
          return { kind: 'error', code: 52, message: 'Empty reply from server' };
        }
        return answer(podHttp(ks, target, fwd.remotePort, req.path, host.clock, { log: opts.silent ? undefined : '127.0.0.1' }));
      }
      if (req.port === 80 && getObj(ks, 'Deployment', 'ingress-nginx', 'ingress-nginx-controller')) {
        reconcile(host);
        return viaIngress(ks, req, host.clock, !!opts.silent);
      }
      return undefined;
    }
    if (NODES.some((n) => n.ip === req.host)) {
      reconcile(host);
      const svc = listObjs(ks, 'Service').find((s) => (s.spec.ports ?? []).some((p: { nodePort?: number }) => p.nodePort === req.port));
      if (!svc) return { kind: 'error', code: 7, message: `Failed to connect to ${req.host} port ${req.port} after 0 ms: Couldn't connect to server` };
      return viaService(ks, svc, req.port, req.path, host.clock, !!opts.silent, { ip: req.host });
    }
    return undefined;
  }
  if (!pod) return undefined;
  // From inside a pod: cluster DNS, ClusterIPs and pod IPs.
  reconcile(host);
  const self = getObj(ks, 'Pod', pod.namespace, pod.name);
  const src: Source = self ? { pod: self } : { ip: '10.244.0.1' };
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(req.host);
  if (!isIp && !LOCAL_HOSTS.has(req.host) && self && !dnsAllowed(ks, self)) return { kind: 'error', code: 6, message: `Could not resolve host: ${req.host}` };
  const svc = lookupService(ks, req.host, pod.namespace) ?? listObjs(ks, 'Service').find((s) => s.spec.clusterIP === req.host);
  if (svc) return viaService(ks, svc, req.port, req.path, host.clock, !!opts.silent, src);
  const target = listObjs(ks, 'Pod').find((p) => p.status?.podIP === req.host);
  if (target) {
    if (!connectionAllowed(ks, src, target, req.port)) return timedOut(req.host, req.port);
    return answer(podHttp(ks, target, req.port, req.path, host.clock, { log: opts.silent ? undefined : self?.status?.podIP ?? '10.244.0.1' }));
  }
  if (LOCAL_HOSTS.has(req.host)) {
    if (self) return answer(podHttp(ks, self, req.port, req.path, host.clock, {}));
  }
  return { kind: 'error', code: 6, message: `Could not resolve host: ${req.host}` };
}, -5);
