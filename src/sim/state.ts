import type { DockerState } from './docker/types';
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
}

export interface Disk {
  filesystem: string;
  mount: string;
  /** Sizes in 1K blocks. */
  size: number;
  used: number;
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
      },
      home: {
        student: {
          'notes.txt': 'Welcome to DevOps Quest!\nType `help` to list available commands.\n',
          projects: {},
        },
      },
      root: {},
      tmp: {},
      usr: { bin: {}, local: { bin: {} } },
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
      proc(412, 1, 'root', '/usr/sbin/cron -f', '?', 'Ss', 0.0, 0.0, 6700, 2600, '08:58', '0:00'),
      proc(655, 1, 'root', 'sshd: /usr/sbin/sshd -D', '?', 'Ss', 0.0, 0.1, 15400, 9100, '08:58', '0:00'),
      proc(1001, 1, 'student', '-bash', 'pts/0', 'Ss', 0.0, 0.1, 8300, 5200, '09:00', '0:00'),
    ],
    nextPid: 1200,
    disks: [
      { filesystem: '/dev/sda1', mount: '/', size: 20511312, used: 6123448 },
      { filesystem: 'tmpfs', mount: '/tmp', size: 1012848, used: 0 },
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
  };
  return { ...base, ...overrides };
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
