/** Validator checks for servers, Ansible, AWS and Terraform missions. */
import { createShell } from '../sim';
import { publicRead, WORKSTATION_PUBLIC_IP } from '../sim/aws/api';
import { internetPath } from '../sim/aws/shapes';
import { isInstalled } from '../sim/machines/apt';
import { reach } from '../sim/machines';
import type { SimState } from '../sim/state';
import { answerOnMachine } from '../sim/systemd';
import { Vfs } from '../sim/vfs/vfs';
import type { Check } from './types';

export type InfraCheck = Extract<Check, { type: 'packageInstalled' | 'ansibleRun' | 'awsResource' | 'awsHttp' | 'tfState' | 'tfNoChanges' }>;

export const INFRA_CHECK_TYPES = ['packageInstalled', 'ansibleRun', 'awsResource', 'awsHttp', 'tfState', 'tfNoChanges'] as const;

/** A managed machine by name: its state.machines key, its hostname, or an EC2 instance's Name tag. */
export function hostState(state: SimState, host: string): SimState | undefined {
  const ms = state.machines ?? {};
  if (ms[host]) return ms[host];
  const byName = Object.values(ms).find((m) => m.hostname === host);
  if (byName) return byName;
  const inst = state.aws?.instances.find((i) => i.tags.Name === host && i.state !== 'terminated');
  return inst ? ms[inst.machine] : undefined;
}

function get(o: unknown, path: string): unknown {
  if (path.startsWith('tags.')) return (o as { tags?: Record<string, string> }).tags?.[path.slice(5)];
  return path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
}

function awsObjects(state: SimState, kind: string): Record<string, unknown>[] {
  const aws = state.aws;
  if (!aws) return [];
  switch (kind) {
    case 'bucket':
      return Object.values(aws.buckets).map((b) => ({ ...b, objectCount: Object.keys(b.objects).length, public: publicRead(b), website: !!b.website }));
    case 'object':
      return Object.values(aws.buckets).flatMap((b) => Object.entries(b.objects).map(([key, o]) => ({ bucket: b.name, key, ...o })));
    case 'instance':
      // What the next API call would report (pending → running, stopping → stopped...).
      return aws.instances.map((i) => ({ ...i, state: i.state === 'pending' && state.clock > i.launched ? 'running' : i.state === 'stopping' ? 'stopped' : i.state === 'shutting-down' ? 'terminated' : i.state, publicIp: i.publicIp ?? null }));
    case 'volume':
      return aws.volumes as unknown as Record<string, unknown>[];
    case 'address':
      return aws.addresses.map((a) => ({ ...a, associated: !!a.instanceId }));
    case 'securityGroup':
      return aws.securityGroups.map((g) => ({ ...g, openPorts: g.ingress.filter((r) => r.cidrs.includes('0.0.0.0/0')).map((r) => r.from) }));
    case 'vpc':
      return aws.vpcs as unknown as Record<string, unknown>[];
    case 'subnet':
      return aws.subnets as unknown as Record<string, unknown>[];
    case 'keyPair':
      return aws.keyPairs as unknown as Record<string, unknown>[];
    case 'igw':
      return aws.igws as unknown as Record<string, unknown>[];
    case 'routeTable':
      return aws.routeTables.map((r) => ({ ...r, internet: r.routes.some((x) => x.dest === '0.0.0.0/0' && x.target.startsWith('igw-')) }));
  }
  return [];
}

function readState(state: SimState, dir: string): { resources: { module?: string; mode: string; type: string; name: string; instances: { index_key?: unknown; attributes: Record<string, unknown> }[] }[]; outputs: Record<string, { value: unknown }>; serial: number } | null {
  const v = new Vfs(state.fs, { name: 'root', groups: ['root'] });
  let backendType = 'local';
  try {
    backendType = JSON.parse(v.readFile(`${dir}/.terraform/terraform.tfstate`)).backend?.type ?? 'local';
  } catch {
    /* local */
  }
  try {
    if (backendType === 's3') {
      for (const f of v.readdir(dir).filter((x) => x.endsWith('.tf'))) {
        const t = v.readFile(`${dir}/${f}`);
        const bucket = /bucket\s*=\s*"([^"]+)"/.exec(t)?.[1];
        const key = /key\s*=\s*"([^"]+)"/.exec(t)?.[1];
        if (bucket && key && /backend\s+"s3"/.test(t)) {
          const o = state.aws?.buckets[bucket]?.objects[key];
          return o ? JSON.parse(o.body) : null;
        }
      }
      return null;
    }
    return JSON.parse(v.readFile(`${dir}/terraform.tfstate`));
  } catch {
    return null;
  }
}

export function evaluateInfra(check: InfraCheck, state: SimState): boolean {
  switch (check.type) {
    case 'packageInstalled':
      return isInstalled(state, check.package) === (check.installed ?? true);
    case 'ansibleRun': {
      let runs = state.ansible?.runs ?? [];
      if (check.playbook) runs = runs.filter((r) => r.playbook.split('/').pop() === check.playbook || r.playbook.endsWith('/' + check.playbook));
      runs = runs.filter((r) => r.check === (check.check ?? false));
      if (check.minRuns !== undefined && runs.length < check.minRuns) return false;
      const last = runs[runs.length - 1];
      if (!last) return false;
      const hosts = Object.entries(last.recap).filter(([h]) => !check.hosts || check.hosts.includes(h));
      if (check.hosts && hosts.length < check.hosts.length) return false;
      return hosts.every(([, c]) => c.failed === 0 && c.unreachable === 0 && (check.changed === undefined || c.changed === check.changed) && (check.minChanged === undefined || c.changed >= check.minChanged));
    }
    case 'awsResource': {
      const list = awsObjects(state, check.kind).filter((o) => Object.entries(check.where ?? {}).every(([k, want]) => {
        const v = get(o, k);
        return Array.isArray(v) ? v.map(String).includes(String(want)) : String(v) === String(want);
      }));
      if (check.count !== undefined) return list.length === check.count;
      if (check.min !== undefined) return list.length >= check.min;
      return check.exists === false ? list.length === 0 : list.length > 0;
    }
    case 'awsHttp': {
      const inst = state.aws?.instances.find((i) => i.tags.Name === check.name && i.state !== 'terminated');
      if (!inst?.publicIp || !state.aws) return false;
      if (internetPath(state.aws, inst, check.port ?? 80, WORKSTATION_PUBLIC_IP)) return false;
      const m = state.machines?.[inst.machine];
      if (!m || reach(state, m, inst.publicIp, check.port ?? 80) !== 'ok') return false;
      const r = answerOnMachine(m, check.port ?? 80, check.path ?? '/');
      return !!r && r.kind === 'response' && r.res.status < 400 && (!check.contains || r.res.body.includes(check.contains));
    }
    case 'tfState': {
      const st = readState(state, check.dir);
      if (!st) return check.exists === false && !check.address && !check.output;
      if (check.output) {
        const o = st.outputs[check.output];
        if (!o) return check.exists === false;
        return check.equals === undefined || JSON.stringify(o.value) === JSON.stringify(check.equals) || String(o.value) === String(check.equals);
      }
      const addrs = st.resources.flatMap((r) =>
        r.instances.map((i) => ({ addr: `${r.module ? r.module + '.' : ''}${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}${i.index_key === undefined ? '' : typeof i.index_key === 'number' ? `[${i.index_key}]` : `["${i.index_key}"]`}`, attrs: i.attributes, base: `${r.module ? r.module + '.' : ''}${r.type}.${r.name}` })),
      );
      if (check.count !== undefined) return addrs.filter((a) => a.addr.startsWith('data.') === false).length === check.count;
      if (!check.address) return true;
      const hit = addrs.filter((a) => a.addr === check.address || a.base === check.address);
      if (check.exists === false) return hit.length === 0;
      if (!hit.length) return false;
      if (check.attr) return hit.some((h) => String(get(h.attrs, check.attr!)) === String(check.equals));
      return true;
    }
    case 'tfNoChanges': {
      // Plan on a copy of the world: nothing the learner sees changes.
      const copy = structuredClone(state);
      copy.cwd = check.dir;
      const r = createShell(copy).run(`terraform plan -detailed-exitcode -lock=false -input=false`);
      return r.exitCode === 0;
    }
  }
}

export function describeInfra(check: InfraCheck): string {
  switch (check.type) {
    case 'packageInstalled':
      return `package \`${check.package}\` should ${check.installed === false ? 'not ' : ''}be installed`;
    case 'ansibleRun':
      return `\`ansible-playbook ${check.playbook ?? ''}\` should ${check.check ? 'dry-run (--check) ' : ''}complete with no failed or unreachable hosts${check.changed === 0 ? ' and nothing changed (idempotent)' : ''}`;
    case 'awsResource': {
      const w = Object.entries(check.where ?? {}).map(([k, v]) => `${k} = ${v}`).join(', ');
      const n = check.count !== undefined ? `exactly ${check.count}` : check.exists === false ? 'no' : 'a';
      return `there should be ${n} ${check.kind}${check.count !== undefined && check.count !== 1 ? 's' : ''}${w ? ` with ${w}` : ''}`;
    }
    case 'awsHttp':
      return `the instance \`${check.name}\` should answer on port ${check.port ?? 80} from the internet${check.contains ? ` with \`${check.contains}\`` : ''}`;
    case 'tfState':
      if (check.output) return `Terraform output \`${check.output}\`${check.equals !== undefined ? ` should be \`${check.equals}\`` : ' should exist'}`;
      if (check.count !== undefined) return `Terraform state in \`${check.dir}\` should hold ${check.count} resources`;
      return `\`${check.address}\` should ${check.exists === false ? 'not ' : ''}be in the Terraform state${check.attr ? ` with ${check.attr} = ${check.equals}` : ''}`;
    case 'tfNoChanges':
      return `\`terraform plan\` in \`${check.dir}\` should report no changes`;
  }
}
