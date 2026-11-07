/** Validator checks for observability and security missions. */
import { activeAlerts, amAlerts, promQuery } from '../sim/obs';
import { reach } from '../sim/machines';
import { sshdEffective } from '../sim/security/hardening';
import { secretFindings } from '../sim/security/gitleaks';
import { Cert, unpem } from '../sim/security/tls';
import { configFindings, scanImage } from '../sim/security/trivy';
import { commitTree, findRepo, revList } from '../sim/git/repo';
import type { SimState } from '../sim/state';
import { Vfs } from '../sim/vfs/vfs';
import type { Check } from './types';
import { hostState } from './infraChecks';

export type OpsCheck = Extract<Check, { type: 'promqlMatches' | 'alertState' | 'ruleLoaded' | 'trivyClean' | 'configClean' | 'secretsClean' | 'awsKey' | 'reachable' | 'sshdSetting' | 'certFile' }>;

export const OPS_CHECK_TYPES = ['promqlMatches', 'alertState', 'ruleLoaded', 'trivyClean', 'configClean', 'secretsClean', 'awsKey', 'reachable', 'sshdSetting', 'certFile'] as const;

const rootVfs = (s: SimState) => new Vfs(s.fs, { name: 'root', groups: ['root'] });
const read = (s: SimState, p: string) => {
  try {
    return rootVfs(s).readFile(p);
  } catch {
    return null;
  }
};

function vectorOf(state: SimState, q: string): Map<string, number> | null {
  try {
    const v = promQuery(state, q);
    if (v.type === 'scalar') return new Map([['{}', v.v]]);
    if (v.type !== 'vector') return null;
    return new Map(v.v.map((s) => [JSON.stringify(Object.entries(s.labels).filter(([k]) => k !== '__name__').sort()), s.value]));
  } catch {
    return null;
  }
}

export function evaluateOps(check: OpsCheck, state: SimState): boolean {
  switch (check.type) {
    case 'promqlMatches': {
      const text = read(state, check.file);
      if (text === null) return false;
      const q = text.split('\n').filter((l) => !l.trim().startsWith('#')).join(' ').trim();
      if (!q) return false;
      const got = vectorOf(state, q);
      const want = vectorOf(state, check.reference);
      if (!got || !want || got.size !== want.size || !want.size) return false;
      const tol = check.tolerance ?? 0.02;
      for (const [k, v] of want) {
        const g = got.get(k);
        if (g === undefined || Math.abs(g - v) > Math.max(1e-9, Math.abs(v) * tol)) return false;
      }
      return true;
    }
    case 'alertState': {
      const alerts = activeAlerts(state).filter((a) => a.name === check.name && Object.entries(check.labels ?? {}).every(([k, v]) => a.labels[k] === v));
      const want = check.state ?? 'firing';
      if (want === 'silenced') return amAlerts(state).some((a) => a.name === check.name && a.silenced && Object.entries(check.labels ?? {}).every(([k, v]) => a.labels[k] === v) && (!check.comment || !!state.obs?.silences.find((s) => s.id === a.silenced)?.comment.includes(check.comment)));
      if (want === 'inactive') return alerts.length === 0;
      if (want === 'active') return alerts.length > 0;
      return alerts.some((a) => a.state === want);
    }
    case 'ruleLoaded': {
      activeAlerts(state);
      const rules = (state.obs?.loaded?.groups ?? []).flatMap((g) => g.rules);
      const r = rules.find((x) => x.alert === check.name || x.record === check.name);
      if (!r) return false;
      if (check.for && r.for !== check.for) return false;
      return Object.entries(check.labels ?? {}).every(([k, v]) => r.labels?.[k] === v);
    }
    case 'trivyClean': {
      const r = scanImage(state, check.image);
      if (!r) return false;
      const sev = check.severity ?? ['HIGH', 'CRITICAL'];
      return r.targets.every((t) => !t.vulns.some((v) => sev.includes(v.severity)));
    }
    case 'configClean': {
      const sev = check.severity ?? ['HIGH', 'CRITICAL'];
      const res = configFindings(rootVfs(state), check.path);
      if (!res.length) return false;
      return res.every((r) => !r.found.some((m) => sev.includes(m.severity) && (!check.ids || check.ids.includes(m.id))));
    }
    case 'secretsClean': {
      const v = rootVfs(state);
      if (check.history) {
        const repo = findRepo(state, v, check.path);
        if (!repo) return false;
        for (const sha of revList(repo, Object.values(repo.heads))) {
          for (const e of Object.values(commitTree(repo, sha))) if (secretFindings(repo.objects.blobs[e.sha] ?? '').length) return false;
        }
        return true;
      }
      let clean = true;
      v.walk(check.path, (p, n) => {
        if (n.type === 'file' && !p.includes('/.git/') && secretFindings(n.content).length) clean = false;
      });
      return clean;
    }
    case 'awsKey': {
      const k = state.aws?.keys[check.id];
      if (check.exists === false) return !k;
      if (!k) return check.status === 'Inactive' ? false : false;
      return (k.status ?? 'Active') === (check.status ?? 'Active');
    }
    case 'reachable': {
      const m = hostState(state, check.host);
      if (!m?.machine) return false;
      return (reach(state, m, m.machine.ip, check.port) === 'ok') === check.open;
    }
    case 'sshdSetting':
      return (sshdEffective(state)[check.key.toLowerCase()] ?? '').toLowerCase() === String(check.value).toLowerCase();
    case 'certFile': {
      const text = read(state, check.path);
      const c = text ? unpem<Cert>('cert', text)[0] : undefined;
      if (!c) return false;
      if (c.notAfter < state.clock + (check.minDays ?? 1) * 86400000) return false;
      if (check.san && !c.sans.includes(check.san)) return false;
      return true;
    }
  }
}

export function describeOps(check: OpsCheck): string {
  switch (check.type) {
    case 'promqlMatches':
      return `the query in \`${check.file}\` should return the right series and values`;
    case 'alertState':
      return `alert \`${check.name}\`${check.labels ? ` (${Object.entries(check.labels).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''} should be ${check.state === 'active' ? 'pending or firing' : check.state ?? 'firing'}`;
    case 'ruleLoaded':
      return `Prometheus should have loaded the rule \`${check.name}\``;
    case 'trivyClean':
      return `\`trivy image ${check.image}\` should find no ${(check.severity ?? ['HIGH', 'CRITICAL']).join('/')} vulnerabilities`;
    case 'configClean':
      return `\`trivy config ${check.path}\` should report no ${(check.severity ?? ['HIGH', 'CRITICAL']).join('/')} misconfigurations`;
    case 'secretsClean':
      return `no secrets should be left in \`${check.path}\`${check.history ? ' (including git history)' : ''}`;
    case 'awsKey':
      return check.exists === false ? `access key \`${check.id}\` should be deleted` : `access key \`${check.id}\` should be ${check.status ?? 'Active'}`;
    case 'reachable':
      return `port ${check.port} on \`${check.host}\` should be ${check.open ? 'reachable' : 'blocked'} from your workstation`;
    case 'sshdSetting':
      return `the running sshd should use \`${check.key} ${check.value}\``;
    case 'certFile':
      return `\`${check.path}\` should hold a certificate valid for at least ${check.minDays ?? 1} more days${check.san ? ` covering ${check.san}` : ''}`;
  }
}
