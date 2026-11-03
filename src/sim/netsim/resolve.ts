/** Name resolution and reachability for the simulated network. */
import { registerHttpProvider, LOCAL_HOSTS } from '../net';
import type { SimState } from '../state';
import { Vfs } from '../vfs/vfs';
import type { DnsRecord, RecordType, RemoteHost } from './types';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isIp(s: string): boolean {
  return IPV4.test(s);
}

const strip = (n: string) => n.replace(/\.$/, '').toLowerCase();

/** Entries from /etc/hosts (as the file currently reads). */
export function hostsEntries(state: SimState): { ip: string; names: string[] }[] {
  let text = '';
  try {
    text = new Vfs(state.fs, { name: 'root', groups: ['root'] }).readFile('/etc/hosts');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [ip, ...names] = l.split(/\s+/);
      return { ip, names: names.map(strip) };
    });
}

/** DNS lookup as a resolver sees it (no /etc/hosts), following CNAMEs. */
export function dnsLookup(state: SimState, name: string, type: RecordType): { chain: DnsRecord[]; answers: DnsRecord[] } | null {
  const records = state.net?.records ?? [];
  let current = strip(name);
  const chain: DnsRecord[] = [];
  for (let i = 0; i < 8; i++) {
    const direct = records.filter((r) => r.name === current && r.type === type);
    if (direct.length) return { chain, answers: direct };
    const cname = records.find((r) => r.name === current && r.type === 'CNAME');
    if (!cname || type === 'CNAME') {
      const exists = records.some((r) => r.name === current);
      return exists || chain.length ? { chain, answers: [] } : null;
    }
    chain.push(cname);
    current = strip(cname.value);
  }
  return { chain, answers: [] };
}

/** How applications resolve a name: /etc/hosts first, then DNS (the nsswitch "files dns" order). */
export function resolveHost(state: SimState, name: string): string | null {
  const n = strip(name);
  if (isIp(n)) return n;
  if (n === 'localhost') return '127.0.0.1';
  for (const e of hostsEntries(state)) if (e.names.includes(n) && isIp(e.ip)) return e.ip;
  const r = dnsLookup(state, n, 'A');
  return r?.answers[0]?.value ?? null;
}

export function isLocalIp(state: SimState, ip: string): boolean {
  return ip.startsWith('127.') || ip === '0.0.0.0' || !!state.net?.interfaces.some((i) => i.ip === ip);
}

export function remoteFor(state: SimState, ip: string): RemoteHost | undefined {
  return state.net?.remotes.find((r) => r.ip === ip);
}

/** Reachable remotes answer pings; local addresses always do. */
export function pingable(state: SimState, ip: string): { ok: boolean; latency: number } {
  if (isLocalIp(state, ip)) return { ok: true, latency: 0.04 };
  const r = remoteFor(state, ip);
  return r?.up ? { ok: true, latency: r.latency } : { ok: false, latency: 0 };
}

// curl to remote hosts: resolve, then connect.
registerHttpProvider((state, req) => {
  if (!state.net || state.context) return undefined;
  if (LOCAL_HOSTS.has(req.host)) return undefined;
  const ip = resolveHost(state, req.host);
  if (!ip || isLocalIp(state, ip)) return undefined;
  // Static responses registered by URL still win (missions use them for simple endpoints).
  if (state.network[req.key] || state.network[req.key + '/']) return undefined;
  const remote = remoteFor(state, ip);
  if (!remote || !remote.up) {
    return { kind: 'error', code: 28, message: `Failed to connect to ${req.host} port ${req.port} after 133012 ms: Couldn't connect to server` };
  }
  const svc = remote.services[req.port];
  if (!svc) {
    return { kind: 'error', code: 7, message: `Failed to connect to ${req.host} port ${req.port} after ${Math.round(remote.latency)} ms: Couldn't connect to server` };
  }
  if (svc.kind === 'tcp') return { kind: 'error', code: 52, message: 'Empty reply from server' };
  return { kind: 'response', res: { status: svc.status ?? 200, body: svc.body, headers: svc.headers } };
}, 10);
