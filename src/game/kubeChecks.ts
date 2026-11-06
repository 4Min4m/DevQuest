/** Validator checks for Kubernetes missions: they reconcile the simulated cluster and inspect it. */
import { history } from '../sim/helm/release';
import { getObj, listObjs, resourceFor } from '../sim/kube/cluster';
import { isPodReady, reconcile } from '../sim/kube/controllers';
import { ingressRequest, viaService } from '../sim/kube/net';
import { allowed, groupOf, impersonate } from '../sim/kube/rbac';
import { clean, podStatusText } from '../sim/kube/printers';
import type { J } from '../sim/kube/types';
import type { SimState } from '../sim/state';
import { Vfs } from '../sim/vfs/vfs';
import type { Check } from './types';

export type KubeCheck = Extract<Check, { type: 'kubeResource' | 'kubePods' | 'kubeRollout' | 'kubeEndpoints' | 'kubeHttp' | 'kubeIngress' | 'kubeCanI' | 'helmRelease' | 'kubeVolumeFile' | 'argoApp' }>;

export const KUBE_CHECK_TYPES = ['kubeResource', 'kubePods', 'kubeRollout', 'kubeEndpoints', 'kubeHttp', 'kubeIngress', 'kubeCanI', 'helmRelease', 'kubeVolumeFile', 'argoApp'] as const;

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
      if (check.node !== undefined && pods.some((p) => p.spec.nodeName !== check.node)) return false;
      if (check.notNode !== undefined && pods.some((p) => p.spec.nodeName === check.notNode)) return false;
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
      let src: { pod: J } | undefined;
      if (check.fromSelector) {
        const pod = listObjs(ks, 'Pod', check.fromNamespace ?? ns(check)).find((p) => selectorMatch(p.metadata.labels, check.fromSelector!) && isPodReady(p) && !p.metadata.deletionTimestamp);
        if (!pod) return false;
        src = { pod };
      }
      const r = viaService(ks, svc, check.port ?? svc.spec.ports?.[0]?.port ?? 80, check.path ?? '/', state.clock, true, src);
      const ok = r.kind === 'response' && r.res.status < 400 && (check.contains === undefined || r.res.body.includes(check.contains));
      return check.blocked ? r.kind === 'error' : ok;
    }
    case 'kubeIngress': {
      const r = ingressRequest(ks, check.host, check.path ?? '/', state.clock, check.headers ?? {});
      if (r.kind !== 'response') return false;
      if (check.status !== undefined ? r.res.status !== check.status : r.res.status >= 400) return false;
      return check.contains === undefined || r.res.body.includes(check.contains);
    }
    case 'argoApp': {
      const app = getObj(ks, 'Application', check.namespace ?? 'argocd', check.name);
      if (check.exists === false) return !app;
      if (!app) return false;
      const st = app.status ?? {};
      if (check.sync !== undefined && st.sync?.status !== check.sync) return false;
      if (check.health !== undefined && st.health?.status !== check.health) return false;
      const auto = app.spec.syncPolicy?.automated;
      if (check.automated !== undefined && !!auto !== check.automated) return false;
      if (check.prune !== undefined && !!auto?.prune !== check.prune) return false;
      if (check.selfHeal !== undefined && !!auto?.selfHeal !== check.selfHeal) return false;
      if (check.atHead !== undefined) {
        const remotes = state.git?.remotes ?? {};
        const url = Object.keys(remotes).find((u) => u.replace(/\.git$/, '') === String(app.spec.source?.repoURL ?? '').replace(/\.git$/, ''));
        const head = url ? remotes[url].heads[check.atHead] : undefined;
        if (!head || st.sync?.revision !== head || st.sync?.status !== 'Synced') return false;
      }
      return true;
    }
    case 'kubeVolumeFile': {
      const pvc = getObj(ks, 'PersistentVolumeClaim', ns(check), check.claim);
      const data = pvc?.spec.volumeName ? ks.volumes?.[pvc.spec.volumeName] : undefined;
      if (!data) return false;
      try {
        const text = new Vfs(data, { name: 'root', groups: ['root'] }).readFile('/' + check.path.replace(/^\/+/, ''));
        return check.contains === undefined || text.includes(check.contains);
      } catch {
        return false;
      }
    }
    case 'kubeCanI': {
      const [type, sub] = check.resource.split('/');
      const info = resourceFor(type);
      if (!info) return false;
      const req = { verb: check.verb, resource: sub ? `${info.plural}/${sub}` : info.plural, group: groupOf(info), namespace: info.namespaced ? ns(check) : undefined };
      return allowed(ks, impersonate(check.as, []), req) === check.allowed;
    }
    case 'helmRelease': {
      const hist = history(ks, ns(check), check.name);
      const cur = hist[hist.length - 1];
      if (check.exists === false) return !cur || cur.status === 'uninstalled';
      if (!cur) return false;
      if (cur.status !== (check.status ?? 'deployed')) return false;
      if (check.minRevision !== undefined && cur.version < check.minRevision) return false;
      if (check.chartVersion !== undefined && cur.chart.version !== check.chartVersion) return false;
      if (check.path !== undefined) {
        const v = check.path.split('.').reduce((a: J, k) => (a === undefined || a === null ? undefined : a[k]), cur.values);
        const text = v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (check.equals !== undefined && text !== check.equals) return false;
      }
      return true;
    }
  }
}

export function describeKube(check: KubeCheck): string {
  switch (check.type) {
    case 'kubeResource':
      return check.exists === false ? `${check.kind} \`${check.name}\` should not exist` : `${check.kind} \`${check.name}\`${check.path ? `: ${check.path} should be ${check.equals !== undefined ? `\`${check.equals}\`` : 'as expected'}` : ' should exist'}`;
    case 'kubePods':
      return `pods with \`${check.selector}\` should be ${check.ready !== undefined ? `Ready (at least ${check.ready})` : check.allReady ? 'all Ready' : check.status ?? 'healthy'}${check.node ? ` on \`${check.node}\`` : ''}${check.notNode ? `, none on \`${check.notNode}\`` : ''}`;
    case 'kubeRollout':
      return `deployment \`${check.name}\` should be fully rolled out${check.image ? ` with image \`${check.image}\`` : ''}`;
    case 'kubeEndpoints':
      return `service \`${check.service}\` should have ready endpoints`;
    case 'kubeHttp':
      if (check.blocked) return `traffic to service \`${check.service}\`${check.fromSelector ? ` from \`${check.fromSelector}\` pods` : ''} should be blocked`;
      return `service \`${check.service}\` should answer HTTP${check.fromSelector ? ` from \`${check.fromSelector}\` pods` : ''}${check.contains ? ` with \`${check.contains}\`` : ''}`;
    case 'kubeIngress':
      return `http://${check.host}${check.path ?? '/'} via the ingress controller should ${check.status ? `return ${check.status}` : 'answer'}${check.contains ? ` with \`${check.contains}\`` : ''}`;
    case 'argoApp':
      if (check.exists === false) return `Argo CD application \`${check.name}\` should be deleted`;
      return `Argo CD application \`${check.name}\` should be ${[check.sync, check.health].filter(Boolean).join(' and ') || 'configured'}${check.atHead ? ` at the head of ${check.atHead}` : ''}${check.automated ? ' with automated sync' : ''}${check.prune ? ' (prune)' : ''}${check.selfHeal ? ' (self-heal)' : ''}`;
    case 'kubeVolumeFile':
      return `the \`${check.claim}\` volume should hold \`${check.path}\`${check.contains ? ` containing \`${check.contains}\`` : ''}`;
    case 'kubeCanI':
      return `\`${check.as}\` should ${check.allowed ? '' : 'NOT '}be allowed to ${check.verb} ${check.resource}${check.namespace ? ` in \`${check.namespace}\`` : ''}`;
    case 'helmRelease':
      if (check.exists === false) return `Helm release \`${check.name}\` should be uninstalled`;
      return `Helm release \`${check.name}\` should be ${check.status ?? 'deployed'}${check.chartVersion ? ` with chart ${check.chartVersion}` : ''}${check.path ? ` (${check.path} = ${check.equals})` : ''}`;
  }
}
