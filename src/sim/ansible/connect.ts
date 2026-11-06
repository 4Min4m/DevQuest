/** How Ansible reaches a host: ssh to a managed machine, or the control node itself (connection: local). */
import { groupsOf } from '../shell/identity';
import type { SimState } from '../state';
import { loginAs, sshConnect } from '../machines/ssh';
import { Vfs } from '../vfs/vfs';

export interface Target {
  m: SimState;
  user: string;
  /** Passwordless sudo (cloud images) for become. */
  canSudo: boolean;
}

export function connect(state: SimState, o: { host: string; user: string; key?: string; local?: boolean }): Target | { error: string } {
  if (o.local || ['localhost', '127.0.0.1'].includes(o.host)) {
    return { m: state, user: state.user, canSudo: groupsOf(state, state.user).includes('sudo') || state.user === 'root' };
  }
  let msg = '';
  const home = state.vars.HOME ?? '/home/student';
  const keyPath = o.key?.replace(/^~(?=\/|$)/, home);
  const t = sshConnect(state, `${o.user}@${o.host}`, {
    identity: keyPath,
    err: (s) => (msg += s),
    note: () => undefined,
    vfsRead: (p) => {
      try {
        const path = p.startsWith('/') ? p : `${state.cwd}/${p}`;
        const v = new Vfs(state.fs, { name: state.user, groups: groupsOf(state, state.user) });
        const node = v.lookup(path);
        return { mode: node.mode, content: node.type === 'file' ? v.readFile(path) : '' } as { mode: number };
      } catch {
        return null;
      }
    },
  });
  if (!t) {
    const last = msg.trim().split('\n').filter((l) => !l.startsWith('@')).join('\r\n');
    return { error: `Failed to connect to the host via ssh: ${last}` };
  }
  const m = loginAs(t.m, t.user);
  return { m, user: t.user, canSudo: t.user === 'root' || groupsOf(m, t.user).includes('sudo') };
}
