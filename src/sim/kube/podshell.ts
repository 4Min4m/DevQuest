/** A pod container's view of the world: the SimState that `kubectl exec` shells (and shell-image commands) run in. */
import type { ShellLike } from '../shell/types';
import type { SimState } from '../state';
import { imageShell, ResolvedImage } from './images';
import type { KObj } from './types';
import type { DirNode } from '../vfs/types';

let factory: ((state: SimState) => ShellLike) | null = null;

/** Set by the simulator entry point so pod commands can run through the real shell. */
export function setPodShellFactory(f: (state: SimState) => ShellLike): void {
  factory = f;
}

export function podShell(state: SimState): ShellLike | null {
  return factory ? factory(state) : null;
}

export function podState(host: SimState, pod: KObj, container: string, fs: DirNode, env: Record<string, string>, image: ResolvedImage): SimState {
  const { shells, lacks } = imageShell(image);
  const name = pod.metadata.name;
  const vars: Record<string, string> = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...env,
    HOSTNAME: name,
    HOME: '/root',
    PWD: '/',
    TERM: 'xterm',
    KUBERNETES_SERVICE_HOST: '10.96.0.1',
    KUBERNETES_SERVICE_PORT: '443',
  };
  return {
    hostname: name,
    user: 'root',
    cwd: '/',
    fs,
    vars,
    exported: Object.keys(vars),
    users: [{ name: 'root', uid: 0, gid: 0, home: '/root', shell: shells.includes('bash') ? '/bin/bash' : '/bin/sh' }],
    groups: [{ name: 'root', gid: 0, members: [] }],
    processes: [{ pid: 1, ppid: 0, user: 'root', command: 'sleep infinity', tty: '?', stat: 'Ss', cpu: 0, mem: 0, vsz: 1600, rss: 900, start: '09:00', time: '0:00' }],
    nextPid: 40,
    disks: [{ filesystem: 'overlay', mount: '/', size: 61_202_244, used: 18_400_312 }],
    network: {},
    lastExit: 0,
    history: [],
    commandLog: host.commandLog,
    clock: host.clock,
    context: {
      containerId: pod.metadata.uid,
      containerName: container,
      promptStyle: shells.includes('bash') ? 'bash' : 'sh',
      host,
      lacks: [...lacks, 'kubectl', 'docker', 'systemctl', 'sudo'],
      kubePod: { namespace: pod.metadata.namespace ?? 'default', name },
    },
  };
}
