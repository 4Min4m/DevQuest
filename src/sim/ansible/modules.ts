/** Ansible modules, run against a target machine's simulated state. */
import { groupsOf } from '../shell/identity';
import type { SimState } from '../state';
import { Systemd } from '../systemd/manager';
import { basename, dirname } from '../vfs/path';
import { Vfs } from '../vfs/vfs';
import { aptInstall, aptRemove, isInstalled } from '../machines/apt';
import { machineShell } from '../machines';
import { renderTemplate, toBool, Vars } from './jinja';

export interface ModResult {
  changed: boolean;
  failed?: boolean;
  skipped?: boolean;
  msg?: string;
  /** For --diff output. */
  diff?: { path: string; before: string; after: string }[];
  [k: string]: unknown;
}

export interface ModCtx {
  /** The target machine. */
  m: SimState;
  /** Remote user (ansible_user). */
  user: string;
  become: boolean;
  check: boolean;
  vars: Vars;
  /** Read a file on the control node, searching the role/playbook dirs ("files" or "templates"). */
  findLocal(kind: 'files' | 'templates', src: string): { path: string; content: string } | null;
}

export class ModuleError extends Error {}

const fail = (msg: string, extra: Record<string, unknown> = {}): ModResult => ({ changed: false, failed: true, msg, ...extra });

function vfsFor(c: ModCtx): Vfs {
  const who = c.become ? 'root' : c.user;
  return new Vfs(c.m.fs, { name: who, groups: groupsOf(c.m, who) }, () => c.m.clock);
}

const rootVfs = (c: ModCtx) => new Vfs(c.m.fs, { name: 'root', groups: ['root'] }, () => c.m.clock);

/** YAML 1.1 octal modes: 0644 / '0644' / 'u=rw,g=r,o=r' (numeric only here). */
export function parseMode(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  if (/^0?[0-7]{3,4}$/.test(s)) return parseInt(s, 8);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  throw new ModuleError(`mode must be in octal or symbolic form`);
}

function readOr(v: Vfs, p: string): string | null {
  try {
    return v.isDir(p) ? null : v.readFile(p);
  } catch {
    return null;
  }
}

/** Write `content` to `dest` with attributes; reports whether anything changed. */
function putFile(c: ModCtx, dest: string, content: string, a: Record<string, unknown>): ModResult {
  const v = vfsFor(c);
  const rv = rootVfs(c);
  if (rv.isDir(dest)) return fail(`Destination ${dest} is a directory`);
  if (!rv.isDir(dirname(dest))) return fail(`Destination directory ${dirname(dest)} does not exist`);
  const before = readOr(rv, dest);
  const mode = parseMode(a.mode);
  let changed = before !== content;
  const node = before !== null ? rv.lookup(dest) : null;
  if (mode !== undefined && (!node || (node.mode & 0o7777) !== mode)) changed = true;
  if (a.owner && node?.owner !== a.owner) changed = true;
  if (a.group && node?.group !== a.group) changed = true;
  const diff = before !== content ? [{ path: dest, before: before ?? '', after: content }] : undefined;
  if (c.check || !changed) return { changed, diff, dest };
  try {
    if (before !== content) v.writeFile(dest, content);
    if (mode !== undefined) v.chmod(dest, mode);
    if (a.owner || a.group) {
      if (!c.become) return fail(`chown failed: [Errno 1] Operation not permitted: b'${dest}'`);
      rv.chown(dest, a.owner as string | undefined, a.group as string | undefined);
    }
  } catch {
    return fail(before === null ? `Destination ${dirname(dest)} not writable` : `Destination ${dest} not writable`);
  }
  return { changed, diff, dest };
}

const MODULES: Record<string, (c: ModCtx, a: Record<string, unknown>) => ModResult> = {
  ping: () => ({ changed: false, ping: 'pong' }),

  debug: (_c, a) => {
    if ('var' in a) return { changed: false, __var: String(a.var) };
    return { changed: false, msg: a.msg === undefined ? 'Hello world!' : a.msg as string };
  },

  set_fact: (_c, a) => ({ changed: false, ansible_facts: a }),

  fail: (_c, a) => fail(String(a.msg ?? 'Failed as requested from task')),

  assert: (c, a) => {
    const conds = Array.isArray(a.that) ? a.that : [a.that];
    for (const cond of conds) {
      if (!a.__eval || !(a.__eval as (s: string) => boolean)(String(cond))) {
        return fail(String(a.fail_msg ?? a.msg ?? 'Assertion failed'), { assertion: cond, evaluated_to: false });
      }
    }
    void c;
    return { changed: false, msg: String(a.success_msg ?? 'All assertions passed') };
  },

  apt: (c, a) => {
    const names = a.name === undefined ? [] : Array.isArray(a.name) ? a.name.map(String) : String(a.name).split(',').map((s) => s.trim());
    const state = String(a.state ?? 'present');
    const lockErr = 'Failed to lock apt for exclusive operation: Failed to lock directory /var/lib/apt/lists/: E:Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)';
    let changed = false;
    if (a.update_cache !== undefined && toBool(a.update_cache)) {
      if (!c.become) return fail(lockErr);
      if (!c.check) c.m.aptLists = true;
      if (!names.length) return { changed: false, cache_updated: true };
    }
    if (!c.become && names.length) return fail(lockErr);
    if (state === 'absent') {
      const todo = names.filter((n) => isInstalled(c.m, n));
      if (todo.length && !c.check) aptRemove(c.m, todo, !!a.purge);
      return { changed: todo.length > 0 };
    }
    if (!['present', 'latest', 'installed'].includes(state)) return fail(`value of state must be one of: absent, build-dep, fixed, latest, present, got: ${state}`);
    const todo = names.filter((n) => !isInstalled(c.m, n));
    if (!todo.length) return { changed };
    const lists = c.m.aptLists !== false || (c.check && a.update_cache !== undefined && toBool(a.update_cache));
    if (c.check) {
      const r = aptInstall({ ...c.m, aptLists: lists, packages: { ...(c.m.packages ?? {}) }, fs: structuredClone(c.m.fs), systemd: c.m.systemd && structuredClone(c.m.systemd), processes: [...c.m.processes] }, todo, { assumeYes: true });
      if (r.code) return fail(`No package matching '${r.err[0]?.replace('E: Unable to locate package ', '')}' is available`);
      return { changed: true };
    }
    const r = aptInstall(c.m, todo, { assumeYes: true });
    if (r.code) return fail(`No package matching '${r.err[0]?.replace('E: Unable to locate package ', '')}' is available`);
    return { changed: true, stdout: r.out.join('\n') + '\n', stdout_lines: r.out };
  },

  copy: (c, a) => {
    const dest0 = String(a.dest ?? '');
    if (!dest0) return fail('missing required arguments: dest');
    let content: string;
    let dest = dest0;
    if (a.content !== undefined) content = typeof a.content === 'string' ? a.content : JSON.stringify(a.content);
    else if (a.src !== undefined) {
      const f = c.findLocal('files', String(a.src));
      if (!f) return fail(`Could not find or access '${a.src}'\nSearched in:\n\tfiles/${a.src}\n\t${a.src}\n on the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option`);
      content = f.content;
      if (dest.endsWith('/') || rootVfs(c).isDir(dest)) dest = dest.replace(/\/$/, '') + '/' + basename(f.path);
    } else return fail('src (or content) is required');
    return putFile(c, dest, content, a);
  },

  template: (c, a) => {
    if (!a.src || !a.dest) return fail(`missing required arguments: ${!a.src ? 'src' : 'dest'}`);
    const f = c.findLocal('templates', String(a.src));
    if (!f) return fail(`Could not find or access '${a.src}'\nSearched in:\n\ttemplates/${a.src}\n\t${a.src}\n on the Ansible Controller.`);
    let out: string;
    try {
      out = renderTemplate(f.content, c.vars);
    } catch (e) {
      return fail(`AnsibleUndefinedVariable: ${(e as Error).message}. ${(e as Error).message}`);
    }
    let dest = String(a.dest);
    if (dest.endsWith('/') || rootVfs(c).isDir(dest)) dest = dest.replace(/\/$/, '') + '/' + basename(f.path).replace(/\.j2$/, '');
    return putFile(c, dest, out, a);
  },

  file: (c, a) => {
    const path = String(a.path ?? a.dest ?? a.name ?? '');
    if (!path) return fail('missing required arguments: path');
    const rv = rootVfs(c);
    const v = vfsFor(c);
    const exists = rv.exists(path);
    const state = String(a.state ?? (exists ? (rv.isDir(path) ? 'directory' : 'file') : 'file'));
    const mode = parseMode(a.mode);
    let changed = false;
    try {
      if (state === 'absent') {
        if (exists) {
          changed = true;
          if (!c.check) v.remove(path, { recursive: true });
        }
        return { changed, path, state: 'absent' };
      }
      if (state === 'directory') {
        if (exists && !rv.isDir(path)) return fail(`there was an issue creating ${path} as requested: [Errno 17] File exists: b'${path}'`, { path });
        if (!exists) {
          changed = true;
          if (!c.check) v.mkdir(path, { parents: true });
        }
      } else if (state === 'touch') {
        changed = true;
        if (!c.check) v.touch(path);
      } else if (state === 'file') {
        if (!exists) return fail(`file (${path}) is absent, cannot continue`, { path });
      } else return fail(`value of state must be one of: absent, directory, file, hard, link, touch, got: ${state}`);
      if (c.check && changed) return { changed, path };
      const node = rv.lookup(path);
      if (mode !== undefined && (node.mode & 0o7777) !== mode) {
        changed = true;
        if (!c.check) v.chmod(path, mode);
      }
      if ((a.owner && node.owner !== a.owner) || (a.group && node.group !== a.group)) {
        changed = true;
        if (!c.become) return fail(`chown failed: [Errno 1] Operation not permitted: b'${path}'`, { path });
        if (!c.check) rv.chown(path, a.owner as string | undefined, a.group as string | undefined);
      }
    } catch (e) {
      return fail(`There was an issue creating ${path} as requested: [Errno 13] Permission denied: b'${path}'`, { path, error: (e as Error).message });
    }
    return { changed, path, state };
  },

  lineinfile: (c, a) => {
    const path = String(a.path ?? a.dest ?? '');
    const rv = rootVfs(c);
    const state = String(a.state ?? 'present');
    let text = readOr(rv, path);
    if (text === null) {
      if (!toBool(a.create ?? false) || state === 'absent') return fail(`Destination ${path} does not exist !`, { rc: 257 });
      text = '';
    }
    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
    const re = a.regexp ? new RegExp(String(a.regexp)) : null;
    const line = a.line === undefined ? undefined : String(a.line);
    let next = [...lines];
    let msg = '';
    if (state === 'absent') {
      next = lines.filter((l) => !(re ? re.test(l) : l === line));
      msg = next.length !== lines.length ? `${lines.length - next.length} line(s) removed` : '';
    } else {
      if (line === undefined) return fail('line is required with state=present');
      const idx = re ? lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? -1 : -1;
      if (idx >= 0) {
        if (lines[idx] !== line) {
          next[idx] = line;
          msg = 'line replaced';
        }
      } else if (!lines.includes(line)) {
        next.push(line);
        msg = 'line added';
      }
    }
    const after = next.length ? next.join('\n') + '\n' : '';
    if (!msg) return { changed: false, msg: '' };
    const r = putFile(c, path, after, a);
    return r.failed ? r : { ...r, msg };
  },

  service: (c, a) => {
    const name = String(a.name ?? '');
    const unit = name.includes('.') ? name : `${name}.service`;
    if (!c.m.systemd) return fail('no systemd on this host');
    const sd = new Systemd(c.m);
    if (a.daemon_reload !== undefined && toBool(a.daemon_reload) && !c.check) sd.daemonReload();
    if (!name) return { changed: false };
    if (!sd.unitPath(unit)) return fail(`Could not find the requested service ${name}: host`);
    const rt = sd.load(unit)!.runtime;
    let changed = false;
    if (a.enabled !== undefined) {
      const want = toBool(a.enabled);
      if (rt.enabled !== want) {
        if (!c.become) return fail(`Unable to ${want ? 'enable' : 'disable'} service ${name}: Failed to ${want ? 'enable' : 'disable'} unit: Access denied\n`);
        changed = true;
        if (!c.check) rt.enabled = want;
      }
    }
    const st = a.state === undefined ? undefined : String(a.state);
    if (st) {
      const active = rt.active === 'active';
      const act = st === 'started' ? (active ? null : 'start') : st === 'stopped' ? (active ? 'stop' : null) : st === 'restarted' || st === 'reloaded' ? 'restart' : 'bad';
      if (act === 'bad') return fail(`value of state must be one of: reloaded, restarted, started, stopped, got: ${st}`);
      if (act) {
        if (!c.become) return fail(`Unable to ${act} service ${name}: Failed to ${act} ${unit}: Access denied\nSee system logs and 'systemctl status ${unit}' for details.\n`);
        changed = true;
        if (!c.check) {
          const u = act === 'stop' ? sd.stop(unit) : act === 'restart' ? sd.restart(unit) : sd.start(unit);
          if (act !== 'stop' && u?.runtime.active !== 'active') {
            return fail(`Unable to ${act} service ${name}: Job for ${unit} failed because the control process exited with error code.\nSee "systemctl status ${unit}" and "journalctl -xeu ${unit}" for details.\n`);
          }
        }
      }
    }
    return { changed, name, state: st, enabled: rt.enabled };
  },

  user: (c, a) => {
    const name = String(a.name ?? '');
    const m = c.m;
    const state = String(a.state ?? 'present');
    const existing = m.users.find((u) => u.name === name);
    if (!c.become && (state === 'absent' ? !!existing : true)) {
      const groupsWanted = a.groups !== undefined;
      if (!existing || groupsWanted || a.shell !== undefined) return fail(`useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.\n`, { name, rc: 1 });
    }
    let changed = false;
    if (state === 'absent') {
      if (existing && !c.check) {
        m.users = m.users.filter((u) => u.name !== name);
        for (const g of m.groups) g.members = g.members.filter((x) => x !== name);
      }
      return { changed: !!existing, name, state };
    }
    const wanted = a.groups === undefined ? null : (Array.isArray(a.groups) ? a.groups.map(String) : String(a.groups).split(',').map((s) => s.trim()).filter(Boolean));
    if (wanted) for (const g of wanted) if (!m.groups.some((x) => x.name === g)) return fail(`Group ${g} does not exist`, { name });
    let entry = existing;
    if (!entry) {
      changed = true;
      if (c.check) return { changed, name };
      const uid = Math.max(999, ...m.users.map((u) => u.uid).filter((u) => u < 60000)) + 1;
      const home = String(a.home ?? `/home/${name}`);
      entry = { name, uid, gid: uid, home, shell: String(a.shell ?? '/bin/sh') };
      m.users.push(entry);
      m.groups.push({ name, gid: uid, members: [] });
      if (a.create_home === undefined || toBool(a.create_home)) {
        const rv = rootVfs(c);
        rv.mkdir(home, { parents: true });
        rv.chown(home, name, name);
      }
    }
    if (a.shell !== undefined && entry.shell !== a.shell) {
      changed = true;
      if (!c.check) entry.shell = String(a.shell);
    }
    if (wanted) {
      const append = toBool(a.append ?? false);
      for (const g of m.groups) {
        const isPrimary = g.gid === entry.gid;
        if (isPrimary) continue;
        const has = g.members.includes(name);
        const want = wanted.includes(g.name) || (append && has);
        if (has !== want) {
          changed = true;
          if (!c.check) g.members = want ? [...g.members, name] : g.members.filter((x) => x !== name);
        }
      }
    }
    return { changed, name, state };
  },

  group: (c, a) => {
    const name = String(a.name ?? '');
    const exists = c.m.groups.some((g) => g.name === name);
    const state = String(a.state ?? 'present');
    if ((state === 'present') === exists) return { changed: false, name };
    if (!c.become) return fail(`groupadd: Permission denied.\ngroupadd: cannot lock /etc/group; try again later.\n`, { name });
    if (!c.check) {
      if (state === 'present') c.m.groups.push({ name, gid: Math.max(999, ...c.m.groups.map((g) => g.gid).filter((g) => g < 60000)) + 1, members: [] });
      else c.m.groups = c.m.groups.filter((g) => g.name !== name);
    }
    return { changed: true, name };
  },

  stat: (c, a) => {
    const path = String(a.path ?? '');
    const rv = rootVfs(c);
    if (!rv.exists(path)) return { changed: false, stat: { exists: false } };
    const n = rv.lookup(path);
    return { changed: false, stat: { exists: true, path, isdir: n.type === 'dir', isreg: n.type === 'file', mode: '0' + (n.mode & 0o7777).toString(8), pw_name: n.owner, gr_name: n.group, size: n.type === 'file' ? n.content.length : 4096 } };
  },

  command: (c, a) => runCommand(c, a, false),
  shell: (c, a) => runCommand(c, a, true),
};

function runCommand(c: ModCtx, a: Record<string, unknown>, shell: boolean): ModResult {
  const cmd = String(a.cmd ?? a._raw_params ?? '');
  if (!cmd) return fail('no command given', { rc: 256 });
  const rv = rootVfs(c);
  if (a.creates && rv.exists(String(a.creates))) return { changed: false, rc: 0, stdout: `skipped, since ${a.creates} exists`, stdout_lines: [`skipped, since ${a.creates} exists`], msg: 'Did not run command since \'' + a.creates + '\' exists' };
  if (a.removes && !rv.exists(String(a.removes))) return { changed: false, rc: 0, stdout: `skipped, since ${a.removes} does not exist`, stdout_lines: [] };
  if (c.check) return { changed: false, skipped: true, msg: 'Command would have run if not in check mode' };
  if (!shell && /[|><;&]|\$\(/.test(cmd.replace(/'[^']*'|"[^"]*"/g, ''))) {
    // The command module doesn't use a shell: | and > reach the program as plain arguments.
    const first = cmd.split(/\s+/)[0];
    return fail('non-zero return code', { rc: 1, cmd, stdout: '', stderr: `${first}: invalid argument (the command module runs without a shell: use the shell module for pipes and redirects)`, stdout_lines: [], stderr_lines: [] });
  }
  const prevUser = c.m.user;
  const prevCwd = c.m.cwd;
  const prevVars = c.m.vars;
  if (c.become) {
    c.m.user = 'root';
    c.m.vars = { ...c.m.vars, USER: 'root', HOME: '/root' };
  }
  if (a.chdir) c.m.cwd = String(a.chdir);
  let r;
  try {
    r = machineShell(c.m).run(cmd);
  } finally {
    c.m.user = prevUser;
    c.m.cwd = prevCwd;
    c.m.vars = prevVars;
  }
  const stdout = r.output.filter((o) => o.stream === 'stdout').map((o) => o.text).join('').replace(/\n$/, '');
  const stderr = r.output.filter((o) => o.stream === 'stderr').map((o) => o.text).join('').replace(/\n$/, '');
  const res: ModResult = { changed: true, rc: r.exitCode, cmd, stdout, stderr, stdout_lines: stdout ? stdout.split('\n') : [], stderr_lines: stderr ? stderr.split('\n') : [] };
  if (r.exitCode !== 0) return { ...res, failed: true, msg: 'non-zero return code' };
  return res;
}

const ALIASES: Record<string, string> = { package: 'apt', systemd: 'service', systemd_service: 'service', 'ansible.legacy.command': 'command' };

/** Canonical module name (FQCN prefixes stripped), or null if unknown. */
export function moduleName(name: string): string | null {
  const short = name.replace(/^(ansible\.builtin|ansible\.posix|ansible\.legacy|community\.general)\./, '');
  const n = ALIASES[short] ?? short;
  return MODULES[n] ? n : null;
}

export const MODULE_NAMES = new Set([...Object.keys(MODULES), ...Object.keys(ALIASES)]);

export function runModule(name: string, c: ModCtx, args: Record<string, unknown>): ModResult {
  const n = moduleName(name);
  if (!n) throw new ModuleError(`couldn't resolve module/action '${name}'. This often indicates a misspelling, missing collection, or incorrect module path.`);
  try {
    return MODULES[n](c, args);
  } catch (e) {
    if (e instanceof ModuleError) return fail(e.message);
    throw e;
  }
}

/** Parse `k=v k2="v 2"` module arguments; leading words without = become _raw_params. */
export function parseKv(s: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const toks = s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const raw: string[] = [];
  for (const t of toks) {
    const m = /^(\w+)=([\s\S]*)$/.exec(t);
    if (m && !raw.length) out[m[1]] = m[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
    else if (m && raw.length && ['chdir', 'creates', 'removes'].includes(m[1])) out[m[1]] = m[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
    else raw.push(t);
  }
  if (raw.length) out._raw_params = raw.join(' ');
  return out;
}
