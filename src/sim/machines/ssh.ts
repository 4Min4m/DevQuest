/** ssh: log in to (or run one command on) a managed machine. */
import type { CommandContext, CommandDef } from '../shell/types';
import type { SimState } from '../state';
import { resolveHost } from '../netsim/resolve';
import { findMachine, machineShell, reach } from './index';

function quote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/** Become `user` on machine `m` (fresh login session). */
export function loginAs(m: SimState, user: string): SimState {
  const entry = m.users.find((u) => u.name === user)!;
  m.user = user;
  m.cwd = entry.home;
  m.vars = { ...m.vars, USER: user, LOGNAME: user, HOME: entry.home, PWD: entry.home };
  delete m.vars.SUDO_USER;
  return m;
}

export interface SshTarget {
  m: SimState;
  user: string;
}

/** Connect and authenticate like ssh does; returns the target or prints ssh's error. */
export function sshConnect(state: SimState, dest: string, opts: { identity?: string; err: (s: string) => void; note: (s: string) => void; vfsRead: (p: string) => { mode: number } | null }): SshTarget | null {
  const at = dest.lastIndexOf('@');
  const host = at >= 0 ? dest.slice(at + 1) : dest;
  const user = at >= 0 ? dest.slice(0, at) : state.user;
  const ip = resolveHost(state, host);
  if (!ip) {
    opts.err(`ssh: Could not resolve hostname ${host}: Temporary failure in name resolution\n`);
    return null;
  }
  const m = findMachine(state, host);
  if (!m) {
    const remote = state.net?.remotes.find((r) => r.ip === ip);
    if (remote?.up && remote.services[22]) opts.err(`${user}@${host}: Permission denied (publickey).\n`);
    else if (remote?.up) opts.err(`ssh: connect to host ${host} port 22: Connection refused\n`);
    else opts.err(`ssh: connect to host ${host} port 22: Connection timed out\n`);
    return null;
  }
  const r = reach(state, m, ip, 22);
  if (r !== 'ok') {
    opts.err(`ssh: connect to host ${host} port 22: ${r === 'timeout' ? 'Connection timed out' : 'Connection refused'}\n`);
    return null;
  }
  const knownPath = `${state.vars.HOME}/.ssh/known_hosts`;
  const denied = () => {
    opts.err(`${user}@${host}: Permission denied (publickey).\n`);
    return null;
  };
  // Host key: first connection adds it (StrictHostKeyChecking=accept-new style, as a note).
  const known = opts.vfsRead(knownPath) as unknown as { content?: string } | null;
  if (!known?.content?.includes(host)) opts.note(`Warning: Permanently added '${host}' (ED25519) to the list of known hosts.\n`);
  const key = m.machine!.keyFile;
  if (key) {
    if (!opts.identity) return denied();
    const st = opts.vfsRead(opts.identity);
    if (!st) {
      opts.note(`Warning: Identity file ${opts.identity} not accessible: No such file or directory.\n`);
      return denied();
    }
    if (st.mode & 0o077) {
      opts.err(
        `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nPermissions 0${(st.mode & 0o777).toString(8)} for '${opts.identity}' are too open.\nIt is required that your private key files are NOT accessible by others.\nThis private key will be ignored.\nLoad key "${opts.identity}": bad permissions\n`,
      );
      return denied();
    }
    if (opts.identity.split('/').pop() !== key) return denied();
  }
  if (!m.machine!.sshUsers.includes(user) || !m.users.some((u) => u.name === user)) return denied();
  return { m, user };
}

export const ssh: CommandDef = {
  name: 'ssh',
  summary: 'log in to a remote machine (ssh [-i key] user@host [command])',
  run(ctx: CommandContext) {
    const args = [...ctx.args];
    let identity: string | undefined;
    const rest: string[] = [];
    while (args.length) {
      const a = args.shift()!;
      if (rest.length) {
        rest.push(a);
        continue;
      }
      if (a === '-i') identity = args.shift();
      else if (a === '-o') args.shift();
      else if (a === '-t' || a === '-T' || a === '-q') continue;
      else if (a === '-p') {
        const p = args.shift();
        if (p !== '22') {
          ctx.err(`devquest: ssh only simulates port 22\n`);
          return 255;
        }
      } else if (a.startsWith('-')) {
        ctx.err(`devquest: ssh supports -i, -o, -p, -t (got ${a})\n`);
        return 255;
      } else rest.push(a);
    }
    if (!rest.length) {
      ctx.err('usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n           [-i identity_file] [-p port] destination [command [argument ...]]\n');
      return 255;
    }
    const [dest, ...cmd] = rest;
    const vfsRead = (p: string) => {
      try {
        const path = ctx.resolve(p.replace(/^~(?=\/|$)/, ctx.state.vars.HOME ?? '~'));
        const node = ctx.vfs.lookup(path);
        return { mode: node.mode, content: node.type === 'file' ? ctx.vfs.readFile(path) : '' };
      } catch {
        return null;
      }
    };
    const t = sshConnect(ctx.state, dest, { identity, err: ctx.err, note: ctx.note, vfsRead });
    if (!t) return 255;
    // Remember the host key.
    const host = dest.slice(dest.lastIndexOf('@') + 1);
    try {
      const home = ctx.state.vars.HOME;
      ctx.vfs.mkdir(`${home}/.ssh`, { parents: true });
      const kh = `${home}/.ssh/known_hosts`;
      const cur = ctx.vfs.exists(kh) ? ctx.vfs.readFile(kh) : '';
      if (!cur.includes(host)) ctx.vfs.writeFile(kh, `${host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${host.length}devquest\n`, { append: true });
    } catch {
      /* read-only home: ssh just warns */
    }
    const m = loginAs(t.m, t.user);
    if (cmd.length) {
      const line = cmd.length === 1 ? cmd[0] : cmd.map(quote).join(' ');
      const r = machineShell(m).run(line, ctx.stdin);
      for (const c of r.output) (c.stream === 'stdout' ? ctx.out : ctx.err)(c.text);
      return r.exitCode;
    }
    ctx.out(`Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-1015-aws x86_64)\n\n * Documentation:  https://help.ubuntu.com\n\nLast login: Thu Nov  5 09:12:44 2026 from 10.0.1.15\n`);
    ctx.shell.attach(m, () => undefined);
    return 0;
  },
};
