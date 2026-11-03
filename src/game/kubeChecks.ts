/** Validator checks for Kubernetes missions: they reconcile the simulated cluster and inspect it. */
import { getObj, listObjs } from '../sim/kube/cluster';
import { isPodReady, reconcile } from '../sim/kube/controllers';
import { viaService } from '../sim/kube/net';
import { clean, podStatusText } from '../sim/kube/printers';
import type { J } from '../sim/kube/types';
import type { SimState } from '../sim/state';
import type { Check } from './types';

export type KubeCheck = Extract<Check, { type: 'kubeResource' | 'kubePods' | 'kubeRollout' | 'kubeEndpoints' | 'kubeHttp' }>;

export const KUBE_CHECK_TYPES = ['kubeResource', 'kubePods', 'kubeRollout', 'kubeEndpoints', 'kubeHttp'] as const;

const ns = (c: { namespace?: string }) => c.namespace ?? 'default';

function selectorMatch(labels: Record<string, string> | undefined, sel: string): boolean {
  return sel.split(',').every((p) => {
    const [k, v] = p.split('=');
    return v === undefined ? !!labels && k in labels : labels?.[k] === v;
  });
}

export function evaluateKube(check: KubeCheck, state: SimState): boolean {
  if (!state.kube) return false;
  const ks = reconcile(state);
  switch (check.type) {
    case 'kubeResource': {
      const o = getObj(ks, check.kind, ns(check), check.name);
      if (check.exists === false) return !o;
      if (!o) return false;
      if (check.path === undefined) return true;
      const v = check.path.split(/(?<!\\)\./).map((k) => k.replace(/\\\./g, '.')).reduce((a: J, k) => (a === undefined ? a : a[/^\d+$/.test(k) ? Number(k) : k]), clean(o));
      const text = v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (check.equals !== undefined && text !== check.equals) return false;
      if (check.regex !== undefined && !new RegExp(check.regex).test(text)) return false;
      return true;
    }
    case 'kubePods': {
      const pods = listObjs(ks, 'Pod', ns(check)).filter((p) => selectorMatch(p.metadata.labels, check.selector) && !p.metadata.deletionTimestamp);
      const ready = pods.filter(isPodReady);
      if (check.ready !== undefined && ready.length < check.ready) return false;
      if (check.allReady && (!pods.length || ready.length !== pods.length)) return false;
      if (check.status !== undefined && !pods.some((p) => podStatusText(p) === check.status)) return false;
      if (check.maxRestarts !== undefined) {
        // Only restarts in the last few minutes count (old crashes before the fix are fine).
        if (pods.some((p) => (p.status?.containerStatuses ?? []).some((c: J) => c.state?.waiting?.reason === 'CrashLoopBackOff'))) return false;
      }
      return pods.length > 0 || check.ready === 0;
    }
    case 'kubeRollout': {
      const d = getObj(ks, 'Deployment', ns(check), check.name);
      if (!d) return false;
      const s = d.status ?? {};
      const want = d.spec.replicas ?? 1;
      const done = (s.updatedReplicas ?? 0) === want && (s.replicas ?? 0) === want && (s.availableReplicas ?? 0) === want;
      if (!done) return false;
      if (check.replicas !== undefined && want !== check.replicas) return false;
      if (check.image !== undefined && d.spec.template.spec.containers[0]?.image !== check.image) return false;
      return true;
    }
    case 'kubeEndpoints': {
      const ep = getObj(ks, 'Endpoints', ns(check), check.service);
      const n = (ep?.subsets ?? []).reduce((a: number, s: J) => a + (s.addresses ?? []).length, 0);
      return n >= (check.min ?? 1);
    }
    case 'kubeHttp': {
      const svc = getObj(ks, 'Service', ns(check), check.service);
      if (!svc) return false;
      const r = viaService(ks, svc, check.port ?? svc.spec.ports?.[0]?.port ?? 80, check.path ?? '/', state.clock, true);
      if (r.kind !== 'response' || r.res.status >= 400) return false;
      return check.contains === undefined || r.res.body.includes(check.contains);
    }
  }
}

export function describeKube(check: KubeCheck): string {
  switch (check.type) {
    case 'kubeResource':
      return check.exists === false ? `${check.kind} \`${check.name}\` should not exist` : `${check.kind} \`${check.name}\`${check.path ? `: ${check.path} should be ${check.equals !== undefined ? `\`${check.equals}\`` : 'as expected'}` : ' should exist'}`;
    case 'kubePods':
      return `pods with \`${check.selector}\` should be ${check.ready !== undefined ? `Ready (at least ${check.ready})` : check.allReady ? 'all Ready' : check.status ?? 'healthy'}`;
    case 'kubeRollout':
      return `deployment \`${check.name}\` should be fully rolled out${check.image ? ` with image \`${check.image}\`` : ''}`;
    case 'kubeEndpoints':
      return `service \`${check.service}\` should have ready endpoints`;
    case 'kubeHttp':
      return `service \`${check.service}\` should answer HTTP${check.contains ? ` with \`${check.contains}\`` : ''}`;
  }
}
