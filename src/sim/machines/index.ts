/** Other Linux servers on the network: created by missions or EC2, reached with ssh, Ansible and curl. */
import { registerHttpProvider } from '../net';
import type { HttpResult } from '../net';
import { resolveHost } from '../netsim/resolve';
import type { RunResult } from '../shell/types';
import { createInitialState, createSystemdState, SimState } from '../state';
import { answerOnMachine } from '../systemd';
import { Vfs } from '../vfs/vfs';
import { aptInstall } from './apt';
import { BASE_PACKAGES } from './packages';

export { apt, aptGet, aptInstall, aptRemove, isInstalled } from './apt';
export { PACKAGES } from './packages';

interface ShellLike {
  run(line: string, stdin?: string): RunResult;
  state: SimState;
}

let factory: ((s: SimState) => ShellLike) | null = null;

/** Wired by sim/index.ts (avoids an import cycle with the command registry). */
export function setMachineShellFactory(f: (s: SimState) => ShellLike): void {
  factory = f;
}

export function machineShell(m: SimState): ShellLike {
  if (!factory) throw new Error('machine shell factory not set');
  return factory(m);
}

export interface MachineSpec {
  hostname: string;
  ip: string;
  publicIp?: string;
  /** Login user (has sudo without a password, like cloud images). */
  user?: string;
  /** Users whose key from this workstation is authorized (default: [user]). */
  sshUsers?: string[];
  /** Private key file name (e.g. "deploy.pem") required with `ssh -i`; unset = the default key works. */
  keyFile?: string;
  /** Packages to preinstall (services started). */
  packages?: string[];
  /** Files to create (owned by root). */
  files?: Record<string, string>;
  up?: boolean;
  ec2?: string;
}

/** A fresh Ubuntu 24.04 server. */
export function createMachine(spec: MachineSpec, clock?: number): SimState {
  const user = spec.user ?? 'ubuntu';
  const home = user === 'root' ? '/root' : `/home/${user}`;
  const base = createInitialState({ clock });
  const m: SimState = {
    ...base,
    hostname: spec.hostname,
    user,
    cwd: home,
    vars: { ...base.vars, HOME: home, USER: user, LOGNAME: user, PWD: home, HOSTNAME: spec.hostname },
    users: [
      { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash' },
      { name: 'www-data', uid: 33, gid: 33, home: '/var/www', shell: '/usr/sbin/nologin' },
      ...(user === 'root' ? [] : [{ name: user, uid: 1000, gid: 1000, home, shell: '/bin/bash' }]),
    ],
    groups: [
      { name: 'root', gid: 0, members: [] },
      { name: 'sudo', gid: 27, members: user === 'root' ? [] : [user] },
      { name: 'www-data', gid: 33, members: [] },
      ...(user === 'root' ? [] : [{ name: user, gid: 1000, members: [] }]),
    ],
    processes: base.processes.filter((p) => p.pid !== 1001),
    history: [],
    commandLog: [],
    network: {},
    systemd: createSystemdState(clock ?? base.clock),
    packages: { ...BASE_PACKAGES },
    aptLists: false,
    machine: { ip: spec.ip, publicIp: spec.publicIp, up: spec.up ?? true, sshUsers: spec.sshUsers ?? [user], ec2: spec.ec2, keyFile: spec.keyFile },
  };
  m.net = { ...base.net!, interfaces: [{ name: 'lo', ip: '127.0.0.1', prefix: 8 }, { name: 'eth0', ip: spec.ip, prefix: 24 }], remotes: [] };
  const vfs = new Vfs(m.fs, { name: 'root', groups: ['root'] }, () => m.clock);
  try {
    vfs.remove('/home/student', { recursive: true });
  } catch {
    /* none */
  }
  if (user !== 'root') {
    vfs.mkdir(home, { parents: true });
    vfs.chown(home, user, user);
  }
  vfs.writeFile('/etc/hostname', spec.hostname + '\n');
  for (const [p, c] of Object.entries(spec.files ?? {})) {
    vfs.mkdir(p.replace(/\/[^/]*$/, '') || '/', { parents: true });
    vfs.writeFile(p, c);
  }
  if (spec.packages?.length) {
    m.aptLists = true;
    aptInstall(m, spec.packages, { assumeYes: true });
    m.aptLists = false;
  }
  return m;
}

/** The managed machine `name` (hostname as resolved by the workstation, or an IP) refers to. */
export function findMachine(state: SimState, name: string): SimState | undefined {
  const machines = Object.values(state.machines ?? {});
  if (!machines.length) return undefined;
  const ip = resolveHost(state, name);
  const m = machines.find((x) => x.machine && ip && (x.machine.ip === ip || x.machine.publicIp === ip));
  if (m) m.clock = Math.max(m.clock, state.clock);
  return m;
}

/** Network policy hook (EC2 security groups, routes): a reason the port is unreachable, or null. */
type Gate = (state: SimState, m: SimState, port: number, via: 'public' | 'private') => 'timeout' | 'refused' | null;
const gates: Gate[] = [];
export function registerMachineGate(g: Gate): void {
  if (!gates.includes(g)) gates.push(g);
}

/** Can the workstation open a TCP connection to `port` on machine `m` (reached at `ip`)? */
export function reach(state: SimState, m: SimState, ip: string, port: number): 'ok' | 'timeout' | 'refused' {
  if (!m.machine?.up) return 'timeout';
  const via = ip === m.machine.publicIp ? 'public' : 'private';
  for (const g of gates) {
    const r = g(state, m, port, via);
    if (r) return r;
  }
  return m.processes.some((p) => p.ports?.includes(port)) ? 'ok' : 'refused';
}

// curl to a managed machine: its own services answer (nginx installed with apt or Ansible...).
registerHttpProvider((state, req): HttpResult | undefined => {
  if (state.context || !state.machines) return undefined;
  const m = findMachine(state, req.host);
  if (!m) return undefined;
  const ip = resolveHost(state, req.host)!;
  const r = reach(state, m, ip, req.port);
  if (r === 'timeout') return { kind: 'error', code: 28, message: `Failed to connect to ${req.host} port ${req.port} after 130000 ms: Couldn't connect to server` };
  if (r === 'refused') return { kind: 'error', code: 7, message: `Failed to connect to ${req.host} port ${req.port} after 1 ms: Couldn't connect to server` };
  return answerOnMachine(m, req.port, req.path) ?? { kind: 'error', code: 52, message: 'Empty reply from server' };
}, 5);
