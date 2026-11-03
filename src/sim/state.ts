import type { DockerState } from './docker/types';
import type { NetState } from './netsim/types';
import type { SystemdState } from './systemd/types';
import { makeDir, makeFile } from './vfs/vfs';
import type { DirNode, FsNode } from './vfs/types';

/**
 * The entire simulated machine as plain serializable data.
 * Missions build one of these (possibly broken on purpose) as their starting point,
 * and validators inspect it afterwards.
 */
export interface SimState {
  hostname: string;
  user: string;
  cwd: string;
  /** Previous directory, for `cd -`. */
  oldCwd?: string;
  fs: DirNode;
  /** Shell variables. Only names in `exported` are visible to `env`. */
  vars: Record<string, string>;
  exported: string[];
  users: UserEntry[];
  groups: GroupEntry[];
  processes: Process[];
  nextPid: number;
  disks: Disk[];
  /** Mocked HTTP endpoints for `curl`, keyed by URL without trailing slash. */
  network: Record<string, HttpResponse>;
  lastExit: number;
  /** Raw input lines as typed. */
  history: string[];
  /** Every simple command actually executed (after expansion), for validators. */
  commandLog: CommandLogEntry[];
  /** Fixed clock for deterministic output (ms since epoch). Advances 1s per command line. */
  clock: number;
  /** The simulated Docker engine (absent inside containers). */
  docker?: DockerState;
  /** systemd units, journal and program behaviour (absent inside containers). */
  systemd?: SystemdState;
  /** Network around the machine: DNS data and remote hosts. */
  net?: NetState;
  /** Load, memory and CPU figures for top/free/uptime/vmstat. */
  perf?: PerfState;
  /** Resource limits (ulimit). */
  limits?: { nofileSoft: number; nofileHard: number };
  /** Set when this state is a container's view of the world (docker exec). */
  context?: ContainerContext;
}

export interface ContainerContext {
  containerId: string;
  containerName: string;
  /** `bash` → `root@abc123:/# `, `sh` → `/ # ` */
  promptStyle: 'bash' | 'sh';
  /** The host machine, for resolving container networking. */
  host: SimState;
  /** Commands this container's image doesn't ship. */
  lacks: string[];
}

export interface UserEntry {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export interface GroupEntry {
  name: string;
  gid: number;
  members: string[];
}

export interface Process {
  pid: number;
  ppid: number;
  user: string;
  command: string;
  tty: string;
  stat: string;
  cpu: number;
  mem: number;
  vsz: number;
  rss: number;
  start: string;
  time: string;
  /** If true, SIGTERM/SIGINT/SIGHUP are ignored — only SIGKILL works. */
  ignoresTerm?: boolean;
  /** TCP ports this process listens on (for ss/netstat/lsof/curl). */
  ports?: number[];
  /** Extra open files shown by lsof -p. */
  files?: string[];
  /** systemd unit that started it. */
  unit?: string;
}

export interface PerfState {
  cpus: number;
  /** Load averages over 1, 5 and 15 minutes. */
  load: [number, number, number];
  uptimeSec: number;
  memTotalKb: number;
  memUsedKb: number;
  memBuffCacheKb: number;
  swapTotalKb: number;
  swapUsedKb: number;
  /** % of CPU time: user, system, idle, iowait. */
  cpu: { us: number; sy: number; id: number; wa: number };
}

export interface Disk {
  filesystem: string;
  mount: string;
  /** Sizes in 1K blocks. */
  size: number;
  /** Used 1K blocks outside the simulated files (the files' own sizes are added on top). */
  used: number;
  /** Total inodes, and inodes used outside the simulated files. */
  inodes?: number;
  inodesUsed?: number;
}

export interface HttpResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export interface CommandLogEntry {
  argv: string[];
  exitCode: number;
  /** Name of the container the command ran in (docker exec), if any. */
  container?: string;
}

export const DEFAULT_CLOCK = Date.UTC(2026, 10, 3, 9, 0, 0);

type TreeSpec = { [name: string]: string | TreeSpec };

/** Build a directory tree from a compact spec: strings are files, objects are dirs. */
export function buildTree(spec: TreeSpec, owner: string, group: string, mtime: number): DirNode {
  const dir = makeDir(owner, group, mtime);
  for (const [name, value] of Object.entries(spec)) {
    dir.children[name] =
      typeof value === 'string'
        ? makeFile(value, owner, group, mtime)
        : buildTree(value, owner, group, mtime);
  }
  return dir;
}

function setOwner(node: FsNode, owner: string, group: string): void {
  node.owner = owner;
  node.group = group;
  if (node.type === 'dir') for (const c of Object.values(node.children)) setOwner(c, owner, group);
}

export function createDefaultFs(clock = DEFAULT_CLOCK): DirNode {
  const root = buildTree(
    {
      bin: {},
      etc: {
        hostname: 'devquest\n',
        passwd:
          'root:x:0:0:root:/root:/bin/bash\n' +
          'student:x:1000:1000:Student:/home/student:/bin/bash\n' +
          'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n',
        group: 'root:x:0:\nsudo:x:27:student\nwww-data:x:33:\ndocker:x:999:student\nstudent:x:1000:\n',
        'os-release': 'NAME="DevQuest Linux"\nID=devquest\nVERSION_ID="1.0"\n',
        hosts: '127.0.0.1\tlocalhost\n127.0.1.1\tdevquest\n::1\tlocalhost ip6-localhost ip6-loopback\n',
        'resolv.conf': '# This is /run/systemd/resolve/stub-resolv.conf managed by systemd-resolved\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n',
        systemd: { system: {} },
        security: { 'limits.conf': '# /etc/security/limits.conf\n#<domain>  <type>  <item>  <value>\n' },
      },
      lib: {
        systemd: {
          system: {
            'ssh.service':
              '[Unit]\nDescription=OpenBSD Secure Shell server\nAfter=network.target\n\n[Service]\nExecStart=/usr/sbin/sshd -D\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n',
            'cron.service':
              '[Unit]\nDescription=Regular background program processing daemon\n\n[Service]\nExecStart=/usr/sbin/cron -f\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n',
          },
        },
      },
      proc: {},
      home: {
        student: {
          'notes.txt': 'Welcome to DevOps Quest!\nType `help` to list available commands.\n',
          projects: {},
        },
      },
      root: {},
      tmp: {},
      usr: { bin: {}, sbin: { sshd: '\u007fELF', cron: '\u007fELF' }, local: { bin: {} } },
      var: {
        log: {
          syslog:
            'Nov  3 08:59:01 devquest systemd[1]: Started Daily apt download activities.\n' +
            'Nov  3 08:59:30 devquest CRON[412]: (root) CMD (run-parts /etc/cron.hourly)\n' +
            'Nov  3 09:00:00 devquest sshd[655]: Server listening on 0.0.0.0 port 22.\n',
        },
        www: {},
      },
    },
    'root',
    'root',
    clock,
  );
  const home = (root.children.home as DirNode).children.student;
  setOwner(home, 'student', 'student');
  (root.children.tmp as DirNode).mode = 0o1777;
  (root.children.root as DirNode).mode = 0o700;
  const syslog = ((root.children.var as DirNode).children.log as DirNode).children.syslog;
  syslog.mode = 0o640;
  const sbin = (root.children.usr as DirNode).children.sbin as DirNode;
  for (const f of Object.values(sbin.children)) f.mode = 0o755;
  return root;
}

export function createInitialState(overrides: Partial<SimState> = {}): SimState {
  const clock = overrides.clock ?? DEFAULT_CLOCK;
  const base: SimState = {
    hostname: 'devquest',
    user: 'student',
    cwd: '/home/student',
    fs: createDefaultFs(clock),
    vars: {
      HOME: '/home/student',
      USER: 'student',
      LOGNAME: 'student',
      SHELL: '/bin/bash',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      PWD: '/home/student',
      LANG: 'C.UTF-8',
      TERM: 'xterm-256color',
      HOSTNAME: 'devquest',
    },
    exported: ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'PWD', 'LANG', 'TERM'],
    users: [
      { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash' },
      { name: 'student', uid: 1000, gid: 1000, home: '/home/student', shell: '/bin/bash' },
      { name: 'www-data', uid: 33, gid: 33, home: '/var/www', shell: '/usr/sbin/nologin' },
    ],
    groups: [
      { name: 'root', gid: 0, members: [] },
      { name: 'sudo', gid: 27, members: ['student'] },
      { name: 'www-data', gid: 33, members: [] },
      { name: 'docker', gid: 999, members: ['student'] },
      { name: 'student', gid: 1000, members: [] },
    ],
    processes: [
      proc(1, 0, 'root', '/sbin/init', '?', 'Ss', 0.0, 0.1, 167000, 11800, '08:58', '0:01'),
      { ...proc(412, 1, 'root', '/usr/sbin/cron -f', '?', 'Ss', 0.0, 0.0, 6700, 2600, '08:58', '0:00'), unit: 'cron.service' },
      { ...proc(655, 1, 'root', 'sshd: /usr/sbin/sshd -D', '?', 'Ss', 0.0, 0.1, 15400, 9100, '08:58', '0:00'), ports: [22], unit: 'ssh.service' },
      proc(1001, 1, 'student', '-bash', 'pts/0', 'Ss', 0.0, 0.1, 8300, 5200, '09:00', '0:00'),
    ],
    nextPid: 1200,
    disks: [
      { filesystem: '/dev/sda1', mount: '/', size: 20511312, used: 6123448, inodes: 1310720, inodesUsed: 187034 },
      { filesystem: 'tmpfs', mount: '/tmp', size: 1012848, used: 0, inodes: 253212, inodesUsed: 1 },
    ],
    network: {
      'http://example.com': {
        status: 200,
        body: '<!doctype html>\n<html><body><h1>Example Domain</h1></body></html>\n',
        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      },
    },
    lastExit: 0,
    history: [],
    commandLog: [],
    clock,
    docker: createDockerState(clock),
    systemd: createSystemdState(clock),
    net: createNetState(),
    perf: {
      cpus: 2,
      load: [0.15, 0.1, 0.05],
      uptimeSec: 10 * 86400 + 2 * 3600 + 13 * 60,
      memTotalKb: 4028488,
      memUsedKb: 812344,
      memBuffCacheKb: 1923112,
      swapTotalKb: 2097148,
      swapUsedKb: 0,
      cpu: { us: 3.1, sy: 1.2, id: 95.6, wa: 0.1 },
    },
    limits: { nofileSoft: 1024, nofileHard: 1048576 },
  };
  const state = { ...base, ...overrides };
  refreshProc(state);
  return state;
}

/** systemd with the units the default machine runs (ssh, cron). */
export function createSystemdState(clock = DEFAULT_CLOCK): SystemdState {
  const boot = clock - 120_000;
  const unit = (name: string, pid: number) => ({
    name,
    active: 'active' as const,
    sub: 'running',
    enabled: true,
    mainPid: pid,
    since: boot,
    result: 'success',
    loadedSource: null,
    restarts: 0,
  });
  return {
    units: {
      'ssh.service': unit('ssh.service', 655),
      'cron.service': unit('cron.service', 412),
    },
    journal: [
      { time: boot, ident: 'systemd', pid: 1, unit: 'cron.service', message: 'Started cron.service - Regular background program processing daemon.', priority: 6 },
      { time: boot, ident: 'sshd', pid: 655, unit: 'ssh.service', message: 'Server listening on 0.0.0.0 port 22.', priority: 6 },
      { time: boot, ident: 'systemd', pid: 1, unit: 'ssh.service', message: 'Started ssh.service - OpenBSD Secure Shell server.', priority: 6 },
    ],
    binaries: {
      '/usr/sbin/sshd': { name: 'sshd', listen: 22 },
      '/usr/sbin/cron': { name: 'cron' },
    },
  };
}

/** A small office network: the machine, its gateway and example.com out on the internet. */
export function createNetState(): NetState {
  return {
    interfaces: [
      { name: 'lo', ip: '127.0.0.1', prefix: 8 },
      { name: 'eth0', ip: '10.0.1.15', prefix: 24, mac: '02:42:0a:00:01:0f' },
    ],
    gateway: '10.0.1.1',
    resolver: '127.0.0.53',
    nameservers: ['127.0.0.53', '8.8.8.8', '1.1.1.1'],
    records: [
      { name: 'example.com', type: 'A', value: '93.184.216.34', ttl: 3600 },
      { name: 'example.com', type: 'AAAA', value: '2606:2800:220:1:248:1893:25c8:1946', ttl: 3600 },
      { name: 'www.example.com', type: 'CNAME', value: 'example.com', ttl: 3600 },
      { name: 'example.com', type: 'MX', value: '0 .', ttl: 3600 },
      { name: 'example.com', type: 'TXT', value: '"v=spf1 -all"', ttl: 3600 },
      { name: 'example.com', type: 'NS', value: 'a.iana-servers.net', ttl: 86400 },
      { name: '34.216.184.93.in-addr.arpa', type: 'PTR', value: 'example.com', ttl: 3600 },
    ],
    remotes: [
      { ip: '10.0.1.1', name: '_gateway', up: true, latency: 0.4, services: {} },
      {
        ip: '93.184.216.34',
        name: 'example.com',
        up: true,
        latency: 12.4,
        hops: ['_gateway (10.0.1.1)', '100.64.0.1', 'ae-1.edge1.ams.example-transit.net (72.14.215.85)'],
        services: {
          80: { kind: 'http', body: '<!doctype html>\n<html><body><h1>Example Domain</h1></body></html>\n', headers: { 'Content-Type': 'text/html; charset=UTF-8' } },
          443: { kind: 'tcp' },
        },
      },
    ],
  };
}

/** Regenerate /proc files from the perf figures (call after changing state.perf). */
export function refreshProc(state: SimState): void {
  const p = state.perf;
  const proc = state.fs.children.proc;
  if (!p || !proc || proc.type !== 'dir') return;
  const f = (content: string) => makeFile(content, 'root', 'root', state.clock, 0o444);
  const avail = p.memTotalKb - p.memUsedKb;
  const free = avail - p.memBuffCacheKb;
  const kb = (label: string, v: number) => `${(label + ':').padEnd(16)}${String(v).padStart(8)} kB\n`;
  proc.children.meminfo = f(
    kb('MemTotal', p.memTotalKb) +
      kb('MemFree', Math.max(0, free)) +
      kb('MemAvailable', avail) +
      kb('Buffers', Math.round(p.memBuffCacheKb * 0.05)) +
      kb('Cached', Math.round(p.memBuffCacheKb * 0.95)) +
      kb('SwapTotal', p.swapTotalKb) +
      kb('SwapFree', p.swapTotalKb - p.swapUsedKb),
  );
  const running = state.processes.filter((x) => x.stat.startsWith('R')).length + 1;
  proc.children.loadavg = f(`${p.load.map((l) => l.toFixed(2)).join(' ')} ${running}/${state.processes.length + 60} ${state.nextPid}\n`);
  proc.children.uptime = f(`${p.uptimeSec.toFixed(2)} ${(p.uptimeSec * p.cpus * 0.95).toFixed(2)}\n`);
  proc.children.cpuinfo = f(
    Array.from({ length: p.cpus }, (_, i) => `processor\t: ${i}\nmodel name\t: DevQuest Virtual CPU @ 2.40GHz\ncpu cores\t: ${p.cpus}\n`).join('\n'),
  );
}

function proc(
  pid: number,
  ppid: number,
  user: string,
  command: string,
  tty: string,
  stat: string,
  cpu: number,
  mem: number,
  vsz: number,
  rss: number,
  start: string,
  time: string,
): Process {
  return { pid, ppid, user, command, tty, stat, cpu, mem, vsz, rss, start, time };
}

/** Deep copy, e.g. to snapshot a mission's initial state. */
export function cloneState(state: SimState): SimState {
  return structuredClone(state);
}

/** A Docker engine with no images or containers, just the built-in networks. */
export function createDockerState(clock = DEFAULT_CLOCK): DockerState {
  const net = (name: string, driver: 'bridge' | 'host' | 'null', subnet: string, id: string) => ({
    id,
    name,
    driver,
    subnet,
    created: clock - 30 * 86_400_000,
    builtin: true,
  });
  return {
    daemonRunning: true,
    images: [],
    containers: [],
    volumes: [],
    networks: [
      net('bridge', 'bridge', '172.17.0', '4f1c2e8a9b7d6c5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e'),
      net('host', 'host', '', '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b'),
      net('none', 'null', '', '1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b9a0f1e2d'),
    ],
    seq: 0,
  };
}
