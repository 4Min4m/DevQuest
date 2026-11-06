/** apt / apt-get: install and remove packages from the catalog, starting their services. */
import type { CommandContext, CommandDef } from '../shell/types';
import type { SimState } from '../state';
import { Systemd } from '../systemd/manager';
import { dirname } from '../vfs/path';
import { Vfs } from '../vfs/vfs';
import { BASE_PACKAGES, PACKAGES } from './packages';

const ROOT = { name: 'root', groups: ['root'] };
const MIRROR = 'http://archive.ubuntu.com/ubuntu';

export function installed(state: SimState): Record<string, string> {
  return (state.packages ??= { ...BASE_PACKAGES });
}

export function isInstalled(state: SimState, name: string): boolean {
  return name in installed(state);
}

/** Install a package's files, units and services (no output): what dpkg + postinst do. */
function unpack(state: SimState, name: string, log: string[]): void {
  const spec = PACKAGES[name];
  const vfs = new Vfs(state.fs, ROOT, () => state.clock);
  const write = (path: string, content: string, mode?: number) => {
    vfs.mkdir(dirname(path), { parents: true });
    if (!vfs.exists(path)) vfs.writeFile(path, content);
    if (mode !== undefined) vfs.chmod(path, mode);
  };
  for (const [path, content] of Object.entries(spec.files ?? {})) write(path, content);
  for (const [path, bin] of Object.entries(spec.binaries ?? {})) {
    write(path, `\x7fELF ${name} binary\n`, 0o755);
    if (state.systemd) state.systemd.binaries[path] = bin;
  }
  for (const [unit, text] of Object.entries(spec.units ?? {})) write(`/lib/systemd/system/${unit}`, text);
  installed(state)[name] = spec.version;
  if (!state.systemd) return;
  const sd = new Systemd(state);
  sd.daemonReload();
  for (const unit of spec.start ?? []) {
    const u = sd.load(unit);
    if (!u) continue;
    if (!u.runtime.enabled) {
      u.runtime.enabled = true;
      log.push(`Created symlink /etc/systemd/system/multi-user.target.wants/${unit} → /usr/lib/systemd/system/${unit}.`);
    }
    sd.start(unit);
  }
}

export interface AptResult {
  code: number;
  out: string[];
  err: string[];
  changed: string[];
}

const kb = (n: number) => n.toLocaleString('en-US');

/** Resolve the packages to install (with dependencies), or the first unknown name. */
function plan(state: SimState, names: string[]): { todo: string[]; extra: string[]; current: string[] } | { missing: string } {
  const todo: string[] = [];
  const extra: string[] = [];
  const current: string[] = [];
  const lists = state.aptLists !== false;
  for (const n of names) {
    const name = n.replace(/=.*$/, '');
    if (!lists || (!PACKAGES[name] && !BASE_PACKAGES[name])) return { missing: name };
    if (isInstalled(state, name)) {
      current.push(name);
      continue;
    }
    if (!todo.includes(name)) todo.push(name);
    for (const d of PACKAGES[name]?.deps ?? []) if (!isInstalled(state, d) && !todo.includes(d) && !names.includes(d)) extra.push(d);
  }
  return { todo: [...extra, ...todo].filter((v, i, a) => a.indexOf(v) === i), extra, current };
}

/** `apt-get install -y` semantics, shared with Ansible's apt module. */
export function aptInstall(state: SimState, names: string[], opts: { assumeYes?: boolean; answer?: string } = {}): AptResult {
  const r: AptResult = { code: 0, out: ['Reading package lists... Done', 'Building dependency tree... Done', 'Reading state information... Done'], err: [], changed: [] };
  const p = plan(state, names);
  if ('missing' in p) {
    r.err.push(`E: Unable to locate package ${p.missing}`);
    r.code = 100;
    return r;
  }
  for (const c of p.current) r.out.push(`${c} is already the newest version (${installed(state)[c]}).`);
  if (p.extra.length) r.out.push('The following additional packages will be installed:', '  ' + p.extra.join(' '));
  if (p.todo.length) r.out.push('The following NEW packages will be installed:', '  ' + [...p.todo].sort().join(' '));
  r.out.push(`0 upgraded, ${p.todo.length} newly installed, 0 to remove and 0 not upgraded.`);
  if (!p.todo.length) return r;
  const size = p.todo.reduce((s, n) => s + (PACKAGES[n]?.size ?? 100), 0);
  r.out.push(`Need to get ${kb(Math.round(size * 0.35))} kB of archives.`, `After this operation, ${kb(size * 3)} kB of additional disk space will be used.`);
  if (!opts.assumeYes) {
    const ans = (opts.answer ?? '').trim().split('\n')[0];
    r.out.push('Do you want to continue? [Y/n] ' + ans);
    if (!/^(y|yes|)$/i.test(ans) || opts.answer === undefined || opts.answer === '') {
      r.out.push('Abort.');
      r.code = 1;
      return r;
    }
  }
  p.todo.forEach((n, i) => r.out.push(`Get:${i + 1} ${MIRROR} noble-updates/main amd64 ${n} amd64 ${PACKAGES[n]?.version ?? '1.0'} [${(PACKAGES[n]?.size ?? 100) * 0.35} kB]`));
  r.out.push(`Fetched ${kb(Math.round(size * 0.35))} kB in 1s (${kb(Math.round(size * 0.3))} kB/s)`);
  const post: string[] = [];
  for (const n of p.todo) {
    const v = PACKAGES[n]?.version ?? BASE_PACKAGES[n];
    r.out.push(`Selecting previously unselected package ${n}.`, `Preparing to unpack .../${n}_${v.replace(/^\d+:/, '')}_amd64.deb ...`, `Unpacking ${n} (${v}) ...`);
  }
  for (const n of p.todo) {
    const log: string[] = [];
    if (PACKAGES[n]) unpack(state, n, log);
    else installed(state)[n] = BASE_PACKAGES[n];
    r.out.push(`Setting up ${n} (${installed(state)[n]}) ...`, ...log);
    r.changed.push(n);
  }
  r.out.push('Processing triggers for man-db (2.12.0-4build2) ...', ...post);
  return r;
}

export function aptRemove(state: SimState, names: string[], purge = false): AptResult {
  const r: AptResult = { code: 0, out: ['Reading package lists... Done', 'Building dependency tree... Done', 'Reading state information... Done'], err: [], changed: [] };
  const todo: string[] = [];
  for (const n of names) {
    if (!PACKAGES[n] && !BASE_PACKAGES[n]) {
      r.err.push(`E: Unable to locate package ${n}`);
      r.code = 100;
      return r;
    }
    if (!isInstalled(state, n)) r.out.push(`Package '${n}' is not installed, so not removed`);
    else todo.push(n);
  }
  if (todo.length) r.out.push(`The following packages will be ${purge ? 'REMOVED' : 'REMOVED'}:`, '  ' + todo.map((t) => (purge ? t + '*' : t)).join(' '));
  r.out.push(`0 upgraded, 0 newly installed, ${todo.length} to remove and 0 not upgraded.`);
  const vfs = new Vfs(state.fs, ROOT, () => state.clock);
  for (const n of todo) {
    const spec = PACKAGES[n];
    r.out.push(`Removing ${n} (${installed(state)[n]}) ...`);
    if (spec && state.systemd) {
      const sd = new Systemd(state);
      for (const unit of Object.keys(spec.units ?? {})) {
        sd.stop(unit);
        const rt = state.systemd.units[unit];
        if (rt) rt.enabled = false;
      }
    }
    for (const p of [...Object.keys(spec?.binaries ?? {}), ...Object.keys(spec?.units ?? {}).map((u) => `/lib/systemd/system/${u}`)]) {
      try {
        vfs.remove(p);
      } catch {
        /* already gone */
      }
    }
    if (purge) {
      for (const p of Object.keys(spec?.files ?? {})) {
        try {
          vfs.remove(p);
        } catch {
          /* gone */
        }
      }
    }
    delete installed(state)[n];
    r.changed.push(n);
  }
  return r;
}

function isRoot(state: SimState): boolean {
  return state.user === 'root';
}

function run(ctx: CommandContext): number {
  const { state } = ctx;
  const isApt = ctx.name === 'apt';
  const args = ctx.args.filter((a) => !a.startsWith('-'));
  const flags = ctx.args.filter((a) => a.startsWith('-'));
  const yes = flags.some((f) => ['-y', '--yes', '--assume-yes', '-qy', '-yq'].includes(f));
  const [sub, ...pkgs] = args;
  const emit = (r: AptResult) => {
    if (r.out.length) ctx.out(r.out.join('\n') + '\n');
    if (r.err.length) ctx.err(r.err.join('\n') + '\n');
    return r.code;
  };
  if (isApt && !ctx.stdoutIsTTY) ctx.note('\nWARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n\n');
  if (!sub) {
    ctx.out(isApt ? 'apt 2.7.14 (amd64)\nUsage: apt [options] command\n\nMost used commands:\n  list - list packages based on package names\n  update - update list of available packages\n  install - install packages\n  remove - remove packages\n  purge - remove packages and configuration files\n' : 'apt 2.7.14 (amd64)\nUsage: apt-get [options] command\n');
    return 1;
  }
  const needRoot = ['update', 'install', 'remove', 'purge', 'upgrade', 'autoremove'];
  if (needRoot.includes(sub) && !isRoot(state)) {
    if (sub === 'update') {
      ctx.err('E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/\n');
    } else {
      ctx.err('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n');
    }
    return 100;
  }
  switch (sub) {
    case 'update': {
      state.aptLists = true;
      ctx.out(
        `Hit:1 ${MIRROR} noble InRelease\nGet:2 ${MIRROR} noble-updates InRelease [126 kB]\nGet:3 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]\nFetched 252 kB in 1s (241 kB/s)\nReading package lists... Done\n` +
          (isApt ? 'Building dependency tree... Done\nReading state information... Done\nAll packages are up to date.\n' : ''),
      );
      return 0;
    }
    case 'install':
      if (!pkgs.length) {
        ctx.out('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n');
        return 0;
      }
      return emit(aptInstall(state, pkgs, { assumeYes: yes, answer: ctx.stdin }));
    case 'remove':
    case 'purge':
      return emit(aptRemove(state, pkgs, sub === 'purge' || flags.includes('--purge')));
    case 'upgrade':
    case 'autoremove':
      ctx.out('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nCalculating upgrade... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n');
      return 0;
    case 'list': {
      if (!flags.includes('--installed')) {
        ctx.err('devquest: apt list supports --installed only\n');
        return 1;
      }
      ctx.out('Listing... Done\n');
      for (const [n, v] of Object.entries(installed(state)).sort()) ctx.out(`${n}/noble-updates,now ${v} amd64 [installed]\n`);
      return 0;
    }
    default:
      ctx.err(isApt ? `E: Invalid operation ${sub}\n` : `E: Invalid operation ${sub}\n`);
      return 100;
  }
}

export const apt: CommandDef = { name: 'apt', summary: 'install, remove and list packages (Ubuntu)', run };
export const aptGet: CommandDef = { name: 'apt-get', summary: 'install and remove packages (scriptable apt)', run };
