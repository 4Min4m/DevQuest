import { createShell } from '../sim';
import { installArgo } from '../sim/kube/argocd';
import { forgeRepo, registryPush } from '../sim/forge';
import { blobSha, treeFromFlat, writeBlob, writeCommit } from '../sim/git/objects';
import type { Repo } from '../sim/git/types';
import { newRepo } from '../sim/git';
import { parseAllDocuments } from 'yaml';
import { clusterOf, putObj } from '../sim/kube/cluster';
import { reconcile } from '../sim/kube/controllers';
import { admit } from '../sim/kube/manifest';
import { identityOf } from '../sim/shell/identity';
import { createInitialState, Process, refreshProc, SimState } from '../sim/state';
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
      if (file.size !== undefined) {
        const node = vfs.lookup(path);
        if (node.type === 'file') node.size = file.size;
      }
    }
    vfs.chown(path, file.owner ?? owner, file.group ?? file.owner ?? group);
    vfs.chmod(path, file.mode ? parseInt(file.mode, 8) : file.type === 'dir' ? 0o755 : 0o644);
  }

  for (const b of spec.bulkFiles ?? []) {
    const dir = normalize(b.dir);
    if (!vfs.exists(dir)) vfs.mkdir(dir, { parents: true });
    const owner = b.owner ?? defaultOwner(state, dir).owner;
    for (let n = 1; n <= b.count; n++) {
      const path = `${dir}/${b.prefix}${n}`;
      vfs.writeFile(path, b.content ?? '');
      vfs.chown(path, owner, owner);
    }
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

  for (const h of spec.gitHosted ?? []) {
    const remote = newRepo(h.url, h.branch ?? 'main', true);
    (state.git ??= { repos: {}, remotes: {} }).remotes[h.url] = remote;
    if (h.files) seedRemote(remote, h.branch ?? 'main', h.files, h.message ?? 'Initial commit', state.clock);
  }
  if (spec.projects) state.projects = { ...(state.projects ?? {}), ...spec.projects };
  for (const [url, f] of Object.entries(spec.forge ?? {})) {
    const repo = forgeRepo(state, url);
    for (const [k, v] of Object.entries(f.secrets ?? {})) repo.secrets[k] = { value: v, updatedAt: state.clock - 86400_000 };
    for (const [k, v] of Object.entries(f.variables ?? {})) repo.variables[k] = typeof v === 'string' ? { value: v, updatedAt: state.clock - 86400_000 } : { ...v, updatedAt: state.clock - 86400_000 };
    for (const [env, e] of Object.entries(f.environments ?? {})) {
      repo.environments[env] = { secrets: Object.fromEntries(Object.entries(e.secrets ?? {}).map(([k, v]) => [k, { value: v, updatedAt: state.clock - 86400_000 }])) };
    }
    if (f.runnerTags) repo.runnerTags = [...f.runnerTags];
  }
  for (const ref of spec.registryImages ?? []) registryPush(state, ref, blobSha(ref) + blobSha(ref + '!').slice(0, 24));

  if (spec.kubeImages || spec.kubeManifests || spec.kubeLoad || spec.argocd) {
    const ks = clusterOf(state);
    Object.assign(ks.images, spec.kubeImages ?? {});
    if (spec.argocd) installArgo(ks, state.clock);
    if (spec.kubeLoad) ks.load = { ...(ks.load ?? {}), ...spec.kubeLoad };
    reconcile(state);
    for (const doc of parseAllDocuments(spec.kubeManifests ?? '').map((d) => d.toJS()).filter(Boolean)) {
      const r = admit(ks, doc, state.clock, { source: 'mission', mode: 'apply', lastApplied: true });
      if (r.action === 'created') putObj(ks, r.obj);
    }
    if (spec.argoApps) {
      // Let Argo CD come up first, then create the Applications.
      state.clock += 60_000;
      reconcile(state);
      for (const doc of parseAllDocuments(spec.argoApps).map((d) => d.toJS()).filter(Boolean)) {
        const r = admit(ks, doc, state.clock, { source: 'mission', mode: 'apply', lastApplied: true });
        if (r.action === 'created') putObj(ks, r.obj);
      }
    }
    // Without setup commands the cluster still runs for `setupAge` before the learner arrives.
    if ((spec.kubeManifests || spec.argocd) && !spec.setup?.length) {
      state.clock += (spec.setupAge ?? 300) * 1000;
      reconcile(state);
    }
  }

  if (spec.binaries && state.systemd) Object.assign(state.systemd.binaries, spec.binaries);
  if (spec.dns && state.net) state.net.records.push(...spec.dns);
  if (spec.remotes && state.net) state.net.remotes.push(...spec.remotes);
  if (spec.perf && state.perf) {
    state.perf = { ...state.perf, ...spec.perf };
    refreshProc(state);
  }
  for (const d of spec.disks ?? []) {
    const existing = state.disks.find((x) => x.mount === d.mount);
    if (existing) Object.assign(existing, d);
    else state.disks.push({ filesystem: d.filesystem ?? `/dev/sdb1`, size: d.size ?? 10485760, used: d.used ?? 0, ...d });
  }

  if (spec.setup?.length) {
    const shell = createShell(state);
    for (const line of spec.setup) {
      const r = shell.run(line);
      if (r.exitCode !== 0) {
        const out = r.output.map((c) => c.text).join('');
        throw new Error(`initialState: setup command failed (exit ${r.exitCode}): ${line}\n${out}`);
      }
    }
    // The learner starts with a clean slate: setup isn't part of their history.
    state.history = [];
    state.commandLog = [];
    state.lastExit = 0;
    state.clock += (spec.setupAge ?? 300) * 1000;
    state.cwd = spec.cwd ? normalize(spec.cwd) : state.vars.HOME;
    state.vars.PWD = state.cwd;
    delete state.oldCwd;
  }

  // Branch protection applies after setup, so setup itself can seed the protected branches.
  for (const h of spec.gitHosted ?? []) {
    const remote = state.git?.remotes[h.url];
    if (remote && h.protected) remote.protectedBranches = [...h.protected];
  }

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

/** Give a hosted remote an initial commit with these files. */
function seedRemote(remote: Repo, branch: string, files: Record<string, string>, message: string, clock: number): void {
  const flat: Record<string, { sha: string; mode: '100644' | '100755' }> = {};
  for (const [path, content] of Object.entries(files)) flat[path] = { sha: writeBlob(remote.objects, content), mode: path.endsWith('.sh') ? '100755' : '100644' };
  const who = { name: 'Acme Dev', email: 'dev@acme.test', time: Math.floor(clock / 1000) - 86400 };
  const sha = writeCommit(remote.objects, { tree: treeFromFlat(remote.objects, flat), parents: [], author: who, committer: who, message });
  remote.heads[branch] = sha;
}
