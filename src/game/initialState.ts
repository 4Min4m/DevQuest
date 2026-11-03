import { identityOf } from '../sim/shell/identity';
import { createInitialState, Process, SimState } from '../sim/state';
import { dirname, isWithin, normalize, splitPath } from '../sim/vfs/path';
import { makeDir, Vfs } from '../sim/vfs/vfs';
import type { FileSpec, InitialStateSpec } from './types';

function defaultOwner(state: SimState, path: string): { owner: string; group: string } {
  for (const u of state.users) {
    if (u.name !== 'root' && isWithin(path, u.home)) {
      const group = state.groups.find((g) => g.gid === u.gid)?.name ?? u.name;
      return { owner: u.name, group };
    }
  }
  return { owner: 'root', group: 'root' };
}

/** Build the starting machine for a mission from its compact spec. */
export function buildInitialState(spec: InitialStateSpec = {}): SimState {
  const state = createInitialState();
  // Build the filesystem with root privileges, then hand the machine to the learner.
  const vfs = new Vfs(state.fs, { name: 'root', groups: ['root'] }, () => state.clock);

  for (const p of spec.remove ?? []) {
    const abs = normalize(p);
    if (vfs.exists(abs)) vfs.remove(abs, { recursive: true });
  }

  for (const [rawPath, raw] of Object.entries(spec.files ?? {})) {
    const path = normalize(rawPath);
    const file: FileSpec = typeof raw === 'string' ? { content: raw } : raw;
    const { owner, group } = defaultOwner(state, path);

    // Create missing parents owned like their location suggests (e.g. student under ~).
    let cur = '/';
    for (const seg of splitPath(dirname(path))) {
      cur = cur === '/' ? '/' + seg : cur + '/' + seg;
      if (!vfs.exists(cur)) {
        const o = defaultOwner(state, cur);
        vfs.insert(cur, makeDir(o.owner, o.group, state.clock));
      }
    }

    if (file.type === 'dir') {
      if (!vfs.exists(path)) vfs.mkdir(path);
    } else {
      vfs.writeFile(path, file.content ?? '');
    }
    vfs.chown(path, file.owner ?? owner, file.group ?? file.owner ?? group);
    vfs.chmod(path, file.mode ? parseInt(file.mode, 8) : file.type === 'dir' ? 0o755 : 0o644);
  }

  if (spec.user) {
    const u = state.users.find((x) => x.name === spec.user);
    if (!u) throw new Error(`initialState: unknown user '${spec.user}'`);
    state.user = u.name;
    state.vars.HOME = u.home;
    state.vars.USER = state.vars.LOGNAME = u.name;
  }
  state.cwd = spec.cwd ? normalize(spec.cwd) : state.vars.HOME;
  state.vars.PWD = state.cwd;

  for (const [k, v] of Object.entries(spec.env ?? {})) {
    state.vars[k] = v;
    if (!state.exported.includes(k)) state.exported.push(k);
  }

  for (const p of spec.processes ?? []) {
    const proc: Process = {
      ppid: 1,
      user: state.user,
      tty: '?',
      stat: 'S',
      cpu: 0,
      mem: 0.1,
      vsz: 20000,
      rss: 8000,
      start: '09:00',
      time: '0:00',
      ...p,
    };
    state.processes.push(proc);
    state.nextPid = Math.max(state.nextPid, proc.pid + 1);
  }

  Object.assign(state.network, spec.network ?? {});

  // Sanity check: the learner must be able to stand in the starting directory.
  const learner = new Vfs(state.fs, identityOf(state));
  let cwdOk = false;
  try {
    const node = learner.lookup(state.cwd);
    cwdOk = node.type === 'dir' && learner.can(node, 1);
  } catch {
    cwdOk = false;
  }
  if (!cwdOk) throw new Error(`initialState: cwd '${state.cwd}' is not an accessible directory`);
  return state;
}
