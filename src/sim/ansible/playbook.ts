/** ansible-playbook: plays, tasks, loops, conditions, handlers, roles and the default callback's output. */
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import type { Node as YNode } from 'yaml';
import { unifiedHunks } from '../git/diff';
import { groupsOf as userGroups } from '../shell/identity';
import type { SimState } from '../state';
import { dirname, joinPath, normalize } from '../vfs/path';
import { Vfs } from '../vfs/vfs';
import { evalCondition, pyStr, templateValue, TemplateError, toBool, Vars } from './jinja';
import { groupHosts, hostVars, Inventory, matchPattern } from './inventory';
import { ModCtx, moduleName, ModResult, parseKv, runModule } from './modules';
import { connect, Target } from './connect';

export class AnsibleError extends Error {
  constructor(msg: string, public code = 1) {
    super(msg);
  }
}

type Obj = Record<string, unknown>;
const LINES = new WeakMap<object, { line: number; col: number }>();

/** YAML → JS, remembering where every mapping starts (for error messages). */
export function loadYaml(text: string, path: string): unknown {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: false });
  if (doc.errors.length) {
    const e = doc.errors[0];
    const pos = e.linePos?.[0] ?? { line: 1, col: 1 };
    throw new AnsibleError(`ERROR! Syntax Error while loading YAML.\n  ${e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')}\n\nThe error appears to be in '${path}': line ${pos.line}, column ${pos.col}, but may\nbe elsewhere in the file depending on the exact syntax problem.`, 4);
  }
  const conv = (n: unknown): unknown => {
    if (isAlias(n)) return conv(n.resolve(doc));
    if (isScalar(n)) return n.value;
    if (isSeq(n)) return n.items.map(conv);
    if (isMap(n)) {
      const o: Obj = {};
      for (const it of n.items) o[String(isScalar(it.key) ? it.key.value : it.key)] = conv(it.value);
      const r = (n as YNode).range;
      if (r) LINES.set(o, lc.linePos(r[0]));
      return o;
    }
    return n ?? null;
  };
  return conv(doc.contents);
}

function where(o: object, path: string): string {
  const p = LINES.get(o);
  return p ? `\n\nThe error appears to be in '${path}': line ${p.line}, column ${p.col}, but may\nbe elsewhere in the file depending on the exact syntax problem.` : '';
}

const TASK_KEYS = new Set([
  'name', 'when', 'loop', 'with_items', 'with_list', 'with_dict', 'loop_control', 'register', 'notify', 'become', 'become_user', 'tags', 'vars',
  'ignore_errors', 'changed_when', 'failed_when', 'args', 'listen', 'delegate_to', 'run_once', 'no_log', 'environment', 'check_mode', 'diff',
  'block', 'rescue', 'always', 'until', 'retries', 'delay', 'timeout', 'any_errors_fatal', 'debugger', 'throttle', 'connection', 'remote_user',
]);

interface Task {
  name?: string;
  action: string;
  args: Obj;
  raw: Obj;
  role?: string;
  /** Directory files/ and templates/ are searched in first. */
  base: string;
  tags: string[];
  vars: Obj;
  when: unknown[];
  become?: boolean;
  block?: { block: Task[]; rescue: Task[]; always: Task[] };
  file: string;
}

interface HostRun {
  name: string;
  target: Target | null;
  vars: Obj;
  facts: Obj;
  registered: Obj;
  failed: boolean;
  unreachable: boolean;
  notified: Set<string>;
  counts: { ok: number; changed: number; unreachable: number; failed: number; skipped: number; rescued: number; ignored: number };
}

export interface PlaybookOptions {
  inventory: Inventory;
  /** Directory of the inventory file (group_vars / host_vars). */
  inventoryDir: string | null;
  limit?: string;
  tags?: string[];
  skipTags?: string[];
  check: boolean;
  diff: boolean;
  extraVars: Obj;
  become: boolean;
  remoteUser?: string;
  privateKey?: string;
  verbose: number;
}

export function header(kind: string, title: string): string {
  const h = `${kind} [${title}] `;
  return h + '*'.repeat(Math.max(3, 79 - h.length));
}

const jsonC = (o: Obj) => '{' + Object.keys(o).sort().map((k) => `${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(', ') + '}';
export const jsonPretty = (o: unknown) => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v), 4);

export class PlaybookRunner {
  out: string[] = [];
  /** UNREACHABLE lines waiting for the next task header (when facts aren't gathered). */
  private pending: string[] = [];
  private vfs: Vfs;
  hosts = new Map<string, HostRun>();

  constructor(private state: SimState, private o: PlaybookOptions) {
    this.vfs = new Vfs(state.fs, { name: state.user, groups: userGroups(state, state.user) });
  }

  private read(path: string): string | null {
    try {
      return this.vfs.readFile(path);
    } catch {
      return null;
    }
  }

  private yamlFile(path: string): unknown {
    const t = this.read(path);
    return t === null ? undefined : loadYaml(t, path);
  }

  /** group_vars/ and host_vars/ next to the inventory and the playbook. */
  private fileVars(host: string, dirs: string[]): Obj {
    const out: Obj = {};
    const load = (dir: string, name: string) => {
      for (const ext of ['', '.yml', '.yaml']) {
        const v = this.yamlFile(joinPath(dir, name + ext));
        if (v && typeof v === 'object') Object.assign(out, v);
      }
      try {
        if (this.vfs.isDir(joinPath(dir, name))) for (const f of this.vfs.readdir(joinPath(dir, name)).sort()) Object.assign(out, (this.yamlFile(joinPath(joinPath(dir, name), f)) as Obj) ?? {});
      } catch {
        /* none */
      }
    };
    const inv = this.o.inventory;
    const groups = ['all', ...[...inv.groups.keys()].filter((g) => g !== 'all' && groupHosts(inv, g).includes(host))];
    for (const d of dirs) for (const g of groups) load(joinPath(d, 'group_vars'), g);
    for (const d of dirs) load(joinPath(d, 'host_vars'), host);
    return out;
  }

  private parseTasks(list: unknown, file: string, base: string, role?: string, inherited: { tags: string[]; when: unknown[]; become?: boolean } = { tags: [], when: [] }): Task[] {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw new AnsibleError(`ERROR! A malformed block was encountered while loading tasks: ${pyStr(list)} should be a list or None but is <class 'str'>`, 4);
    const out: Task[] = [];
    for (const raw of list as Obj[]) {
      if (!raw || typeof raw !== 'object') throw new AnsibleError(`ERROR! A malformed block was encountered while loading tasks${where(raw ?? {}, file)}`, 4);
      const tags = [...inherited.tags, ...(raw.tags === undefined ? [] : Array.isArray(raw.tags) ? raw.tags.map(String) : String(raw.tags).split(',').map((s) => s.trim()))];
      const when = [...inherited.when, ...(raw.when === undefined ? [] : Array.isArray(raw.when) ? raw.when : [raw.when])];
      const become = raw.become === undefined ? inherited.become : toBool(raw.become);
      if ('block' in raw) {
        const inh = { tags, when, become };
        out.push({
          name: raw.name as string | undefined, action: 'block', args: {}, raw, role, base, tags, vars: (raw.vars as Obj) ?? {}, when: [], become, file,
          block: { block: this.parseTasks(raw.block, file, base, role, inh), rescue: this.parseTasks(raw.rescue, file, base, role, inh), always: this.parseTasks(raw.always, file, base, role, inh) },
        });
        continue;
      }
      if ('import_tasks' in raw || 'include_tasks' in raw) {
        const rel = String(raw.import_tasks ?? raw.include_tasks);
        const p = normalize(joinPath(base === dirname(file) ? dirname(file) : joinPath(base, 'tasks'), rel));
        const sub = this.yamlFile(p);
        if (sub === undefined) throw new AnsibleError(`ERROR! Could not find or access '${p}' on the Ansible Controller.`, 1);
        out.push(...this.parseTasks(sub, p, base, role, { tags, when, become }));
        continue;
      }
      const actions = Object.keys(raw).filter((k) => !TASK_KEYS.has(k) && !k.startsWith('with_'));
      if (actions.length > 1) throw new AnsibleError(`ERROR! conflicting action statements: ${actions.join(', ')}${where(raw, file)}`, 4);
      if (!actions.length) throw new AnsibleError(`ERROR! no module/action detected in task.${where(raw, file)}`, 4);
      const action = actions[0];
      if (!moduleName(action)) {
        const looksLikeArg = ['name', 'state', 'src', 'dest', 'path', 'mode', 'owner', 'enabled'].includes(action);
        const msg = looksLikeArg
          ? `ERROR! '${action}' is not a valid attribute for a Task. The error appears to be in '${file}'. Check the indentation: module arguments must be indented under the module name.`
          : `ERROR! couldn't resolve module/action '${action}'. This often indicates a misspelling, missing collection, or incorrect module path.`;
        throw new AnsibleError(msg + where(raw, file), 4);
      }
      const v = raw[action];
      const args: Obj = typeof v === 'string' ? parseKv(v) : v && typeof v === 'object' ? { ...(v as Obj) } : {};
      if (raw.args && typeof raw.args === 'object') Object.assign(args, raw.args);
      out.push({ name: raw.name === undefined ? undefined : String(raw.name), action, args, raw, role, base, tags, vars: (raw.vars as Obj) ?? {}, when, become, file });
    }
    return out;
  }

  private loadRole(name: string, playDir: string): { tasks: Task[]; handlers: Task[]; defaults: Obj; vars: Obj } {
    const dir = [joinPath(playDir, `roles/${name}`), joinPath(playDir, name)].find((d) => this.vfs.isDir(d));
    if (!dir) throw new AnsibleError(`ERROR! the role '${name}' was not found in ${playDir}/roles:${playDir}\n\nThe error appears to be in '${playDir}': but may\nbe elsewhere in the file depending on the exact syntax problem.`, 1);
    const f = (sub: string) => {
      const p = joinPath(dir, `${sub}/main.yml`);
      return { p, v: this.yamlFile(p) ?? this.yamlFile(joinPath(dir, `${sub}/main.yaml`)) };
    };
    const t = f('tasks');
    const h = f('handlers');
    return {
      tasks: this.parseTasks(t.v, t.p, dir, name),
      handlers: this.parseTasks(h.v, h.p, dir, name),
      defaults: (f('defaults').v as Obj) ?? {},
      vars: (f('vars').v as Obj) ?? {},
    };
  }

  private findLocal(task: Task, playDir: string, kind: 'files' | 'templates', src: string): { path: string; content: string } | null {
    const cands = src.startsWith('/') ? [src] : [joinPath(task.base, `${kind}/${src}`), joinPath(task.base, src), joinPath(playDir, `${kind}/${src}`), joinPath(playDir, src), joinPath(this.state.cwd, src)];
    for (const c of cands) {
      const t = this.read(normalize(c));
      if (t !== null) return { path: normalize(c), content: t };
    }
    return null;
  }

  private facts(h: HostRun): Obj {
    const m = h.target!.m;
    const ip = m.machine?.ip ?? m.net?.interfaces.find((i) => i.name !== 'lo')?.ip ?? '127.0.0.1';
    return {
      ansible_hostname: m.hostname,
      ansible_nodename: m.hostname,
      ansible_fqdn: m.hostname,
      ansible_default_ipv4: { address: ip, interface: 'eth0' },
      ansible_all_ipv4_addresses: [ip],
      ansible_distribution: 'Ubuntu',
      ansible_distribution_version: '24.04',
      ansible_distribution_major_version: '24',
      ansible_distribution_release: 'noble',
      ansible_os_family: 'Debian',
      ansible_system: 'Linux',
      ansible_architecture: 'x86_64',
      ansible_kernel: '6.8.0-1015-aws',
      ansible_pkg_mgr: 'apt',
      ansible_service_mgr: 'systemd',
      ansible_processor_vcpus: m.perf?.cpus ?? 2,
      ansible_memtotal_mb: Math.round((m.perf?.memTotalKb ?? 4028488) / 1024),
      ansible_user_id: h.target!.user,
    };
  }

  private varsFor(h: HostRun, extra: Obj): Vars {
    const inv = this.o.inventory;
    const groups: Record<string, string[]> = {};
    for (const g of inv.groups.keys()) groups[g] = groupHosts(inv, g);
    const hostvars: Record<string, Obj> = {};
    for (const [n, r] of this.hosts) hostvars[n] = { ...r.vars, ...r.facts, ...r.registered, inventory_hostname: n };
    for (const n of inv.hosts.keys()) hostvars[n] ??= { ...hostVars(inv, n), inventory_hostname: n };
    return {
      ...h.vars,
      ...h.facts,
      ansible_facts: Object.fromEntries(Object.entries(h.facts).map(([k, v]) => [k.replace(/^ansible_/, ''), v])),
      ...extra,
      ...h.registered,
      ...this.o.extraVars,
      inventory_hostname: h.name,
      inventory_hostname_short: h.name.split('.')[0],
      group_names: [...inv.groups.keys()].filter((g) => g !== 'all' && g !== 'ungrouped' && groups[g].includes(h.name)),
      groups,
      hostvars,
      ansible_check_mode: this.o.check,
      play_hosts: [...this.hosts.values()].filter((x) => !x.failed && !x.unreachable).map((x) => x.name),
      ansible_play_hosts: [...this.hosts.values()].filter((x) => !x.failed && !x.unreachable).map((x) => x.name),
    };
  }

  private selected(t: Task): boolean {
    if (t.tags.includes('never') && !(this.o.tags ?? []).some((x) => t.tags.includes(x))) return false;
    if (this.o.skipTags?.some((x) => t.tags.includes(x))) return false;
    if (!this.o.tags?.length || this.o.tags.includes('all')) return true;
    if (t.action === 'block') return true;
    return t.tags.includes('always') || this.o.tags.some((x) => t.tags.includes(x) || (x === 'tagged' && t.tags.length > 0) || (x === 'untagged' && !t.tags.length));
  }

  private label(t: Task): string {
    const n = t.name ?? t.action;
    return t.role ? `${t.role} : ${n}` : n;
  }

  private printDiff(r: ModResult) {
    if (!this.o.diff || !r.diff) return;
    for (const d of r.diff) {
      const hunks = unifiedHunks(d.before, d.after);
      if (!hunks) continue;
      this.out.push(`--- before: ${d.path}`, `+++ after: ${d.path}`, hunks.replace(/\n$/, ''), '');
    }
  }

  /** Run one task on every active host. Returns hosts that failed (not ignored) for block rescue. */
  private runTask(t: Task, live: HostRun[], playVars: Obj, playDir: string, handlerNames: Set<string>, playBecome: boolean): Set<HostRun> {
    const failedNow = new Set<HostRun>();
    if (t.block) {
      const hosts = live.filter((h) => !h.failed && !h.unreachable);
      const conds = (h: HostRun) => t.when.every((w) => evalCondition(w, this.varsFor(h, { ...playVars, ...t.vars })));
      const runList = (tasks: Task[], hs: HostRun[]) => {
        const failed = new Set<HostRun>();
        for (const sub of tasks) {
          const active = hs.filter((h) => !failed.has(h) && !h.unreachable);
          if (!active.length) break;
          for (const f of this.runTaskWithVars(sub, active, { ...playVars, ...t.vars }, playDir, handlerNames, playBecome)) failed.add(f);
        }
        return failed;
      };
      const eligible = hosts.filter(conds);
      const failed = runList(t.block.block, eligible);
      if (failed.size && t.block.rescue.length) {
        for (const h of failed) {
          h.failed = false;
          h.counts.failed--;
          h.counts.rescued++;
        }
        const again = runList(t.block.rescue, [...failed]);
        for (const h of again) {
          h.failed = true;
          failedNow.add(h);
        }
      } else for (const h of failed) failedNow.add(h);
      if (t.block.always.length) {
        const keep = eligible.filter((h) => !h.unreachable);
        const flags = keep.map((h) => h.failed);
        keep.forEach((h) => (h.failed = false));
        runList(t.block.always, keep);
        keep.forEach((h, i) => (h.failed = h.failed || flags[i]));
      }
      return failedNow;
    }
    return this.runTaskWithVars(t, live, playVars, playDir, handlerNames, playBecome);
  }

  private runTaskWithVars(t: Task, live: HostRun[], playVars: Obj, playDir: string, handlerNames: Set<string>, playBecome: boolean): Set<HostRun> {
    const failedNow = new Set<HostRun>();
    if (!this.selected(t)) return failedNow;
    if (t.block) return this.runTask(t, live, playVars, playDir, handlerNames, playBecome);
    const hosts = live.filter((h) => !h.failed && !h.unreachable);
    if (!hosts.length) return failedNow;
    let title = this.label(t);
    try {
      if (title.includes('{{')) title = String(templateValue(title, this.varsFor(hosts[0], { ...playVars, ...t.vars })));
    } catch {
      /* keep raw */
    }
    this.out.push('', header('TASK', title), ...this.pending);
    this.pending = [];
    for (const h of hosts) {
      const vars = this.varsFor(h, { ...playVars, ...t.vars });
      const become = t.become ?? playBecome;
      const loopRaw = t.raw.loop ?? t.raw.with_items ?? t.raw.with_list ?? (t.raw.with_dict !== undefined ? '__dict__' : undefined);
      let items: unknown[] | null = null;
      const loopVar = String((t.raw.loop_control as Obj | undefined)?.loop_var ?? 'item');
      try {
        if (loopRaw === '__dict__') {
          const d = templateValue(t.raw.with_dict, vars) as Obj;
          items = Object.entries(d).map(([key, value]) => ({ key, value }));
        } else if (loopRaw !== undefined) {
          const v = templateValue(loopRaw, vars);
          if (!Array.isArray(v)) throw new TemplateError(`Invalid data passed to 'loop', it requires a list, got this instead: ${pyStr(v)}. Hint: If you passed a list/dict of just one element, try adding wantlist=True to your lookup invocation or use q/query instead of lookup.`);
          items = t.raw.with_items !== undefined ? v.flat() : v;
        }
      } catch (e) {
        this.fatal(h, { msg: `The task includes an option with an undefined variable. The error was: ${(e as Error).message}` }, t);
        failedNow.add(h);
        continue;
      }
      const results: ModResult[] = [];
      let anyChanged = false;
      let anyFailed = false;
      let allSkipped = true;
      for (const item of items ?? [undefined]) {
        const iv = items ? { ...vars, [loopVar]: item } : vars;
        const label = (t.raw.loop_control as Obj | undefined)?.label;
        const itemTxt = items ? ` => (item=${pyStr(label !== undefined ? templateValue(label, iv) : item)})` : '';
        let ok: boolean;
        try {
          ok = t.when.every((w) => evalCondition(w, iv));
        } catch (e) {
          this.fatal(h, { msg: `The conditional check '${pyStr(t.when.find(() => true))}' failed. The error was: error while evaluating conditional (${pyStr(t.when[0])}): ${(e as Error).message}` }, t);
          anyFailed = true;
          break;
        }
        if (!ok) {
          this.out.push(items ? `skipping: [${h.name}]${itemTxt}` : `skipping: [${h.name}]`);
          results.push({ changed: false, skipped: true });
          continue;
        }
        allSkipped = false;
        let args: Obj;
        try {
          args = templateValue(t.args, iv) as Obj;
        } catch (e) {
          this.fatal(h, { msg: `The task includes an option with an undefined variable. The error was: ${(e as Error).message}` }, t, itemTxt);
          anyFailed = true;
          continue;
        }
        if (moduleName(t.action) === 'assert') args.__eval = (s: string) => evalCondition(s, iv);
        if (become && h.target!.user !== 'root' && !h.target!.canSudo) {
          this.fatal(h, { msg: 'Missing sudo password' }, t, itemTxt);
          anyFailed = true;
          continue;
        }
        const ctx: ModCtx = {
          m: h.target!.m,
          user: h.target!.user,
          become: become || h.target!.user === 'root',
          check: this.o.check || t.raw.check_mode === true,
          vars: iv,
          findLocal: (kind, src) => this.findLocal(t, playDir, kind, src),
        };
        let r: ModResult;
        try {
          r = runModule(t.action, ctx, args);
        } catch (e) {
          r = { changed: false, failed: true, msg: (e as Error).message };
        }
        if (t.raw.changed_when !== undefined) r.changed = evalCondition(t.raw.changed_when, { ...iv, ...r, [String(t.raw.register ?? '_')]: r });
        if (t.raw.failed_when !== undefined) r.failed = evalCondition(t.raw.failed_when, { ...iv, ...r, [String(t.raw.register ?? '_')]: r });
        if (r.ansible_facts) Object.assign(h.registered, r.ansible_facts);
        results.push(r);
        this.printDiff(r);
        if (r.failed) {
          anyFailed = true;
          const shown: Obj = { changed: r.changed, msg: r.msg };
          for (const k of ['rc', 'stdout', 'stderr', 'stdout_lines', 'stderr_lines', 'cmd', 'assertion', 'evaluated_to']) if (k in r) shown[k] = r[k];
          if (items) Object.assign(shown, { ansible_loop_var: loopVar, item });
          this.out.push(items ? `failed: [${h.name}]${itemTxt.replace(' => ', ' ')} => ${jsonC(shown)}` : `fatal: [${h.name}]: FAILED! => ${jsonC(shown)}`);
          continue;
        }
        if (r.changed) anyChanged = true;
        const mod = moduleName(t.action);
        if (mod === 'debug') {
          const body = '__var' in r ? { [String(r.__var)]: (() => { try { return templateValue(`{{ ${r.__var} }}`, iv); } catch { return 'VARIABLE IS NOT DEFINED!'; } })() } : { msg: r.msg };
          this.out.push(`ok: [${h.name}]${itemTxt} => ${jsonPretty(items ? { ...body, ansible_loop_var: loopVar, item } : body)}`);
          continue;
        }
        const word = r.skipped ? 'skipping' : r.changed ? 'changed' : 'ok';
        const verbose = this.o.verbose ? ` => ${jsonPretty(Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('__') && k !== 'diff')))}` : '';
        this.out.push(`${word}: [${h.name}]${itemTxt}${verbose}`);
      }
      const reg = t.raw.register ? String(t.raw.register) : null;
      const summary: ModResult = items
        ? { changed: anyChanged, failed: anyFailed, skipped: allSkipped, results: results.map((r, i) => ({ ...r, item: items![i] })), msg: anyFailed ? 'One or more items failed' : 'All items completed' }
        : results[0] ?? { changed: false, failed: anyFailed };
      if (reg) h.registered[reg] = Object.fromEntries(Object.entries(summary).filter(([k]) => !k.startsWith('__') && k !== 'diff'));
      if (anyFailed) {
        if (t.raw.ignore_errors && toBool(t.raw.ignore_errors)) {
          this.out.push('...ignoring');
          h.counts.ignored++;
          h.counts.ok++;
          if (anyChanged || results.some((r) => r.changed)) h.counts.changed++;
        } else {
          h.counts.failed++;
          h.failed = true;
          failedNow.add(h);
        }
        continue;
      }
      if (allSkipped && (items ? true : results[0]?.skipped)) {
        h.counts.skipped++;
        continue;
      }
      h.counts.ok++;
      if (anyChanged) {
        h.counts.changed++;
        const n = t.raw.notify;
        for (const x of n === undefined ? [] : Array.isArray(n) ? n : [n]) {
          const name = String(templateValue(x, vars));
          if (!handlerNames.has(name)) throw new AnsibleError(`ERROR! The requested handler '${name}' was not found in either the main handlers list nor in the listening handlers list`, 1);
          h.notified.add(name);
        }
      }
    }
    return failedNow;
  }

  private fatal(h: HostRun, body: Obj, _t: Task, itemTxt = '') {
    this.out.push(itemTxt ? `failed: [${h.name}]${itemTxt.replace(' => ', ' ')} => ${jsonC({ changed: false, ...body })}` : `fatal: [${h.name}]: FAILED! => ${jsonC({ changed: false, ...body })}`);
  }

  private runHandlers(handlers: Task[], live: HostRun[], playVars: Obj, playDir: string, become: boolean) {
    for (const hd of handlers) {
      const names = [this.label(hd), hd.name ?? '', ...(hd.raw.listen === undefined ? [] : Array.isArray(hd.raw.listen) ? hd.raw.listen.map(String) : [String(hd.raw.listen)])];
      const hs = live.filter((h) => !h.failed && !h.unreachable && names.some((n) => h.notified.has(n)));
      if (!hs.length) continue;
      const before = this.out.length;
      this.runTaskWithVars({ ...hd, tags: [] }, hs, playVars, playDir, new Set(), become);
      const i = this.out.findIndex((l, k) => k >= before && l.startsWith('TASK ['));
      if (i >= 0) this.out[i] = header('RUNNING HANDLER', this.label(hd));
      for (const h of hs) for (const n of names) h.notified.delete(n);
    }
  }

  /** Parse the playbook (and roles) without running it: --syntax-check. */
  validateOnly(playbookPath: string): void {
    this.parse(playbookPath);
  }

  private parse(playbookPath: string) {
    const doc = this.yamlFile(playbookPath);
    if (doc === undefined) throw new AnsibleError(`ERROR! the playbook: ${playbookPath.split('/').pop()} could not be found`, 1);
    if (!Array.isArray(doc)) throw new AnsibleError(`ERROR! A playbook must be a list of plays, got a <class 'dict'> instead${where((doc as object) ?? {}, playbookPath)}`, 4);
    const playDir = dirname(playbookPath);
    const inv = this.o.inventory;
    // Parse everything first: syntax errors stop the run before anything changes.
    const plays = (doc as Obj[]).map((p) => {
      if (!p || typeof p !== 'object' || !('hosts' in p)) {
        if (p && typeof p === 'object' && ('import_playbook' in p)) throw new AnsibleError('ERROR! import_playbook is not supported by devquest', 1);
        throw new AnsibleError(`ERROR! the field 'hosts' is required but was not set`, 4);
      }
      const roles = ((p.roles as unknown[]) ?? []).map((r) => (typeof r === 'string' ? { role: r } : (r as Obj)));
      const loaded = roles.map((r) => ({ spec: r, ...this.loadRole(String(r.role ?? r.name), playDir) }));
      const playTags = p.tags === undefined ? [] : Array.isArray(p.tags) ? p.tags.map(String) : [String(p.tags)];
      const tagged = (ts: Task[], extra: string[]) => ts.map((t) => ({ ...t, tags: [...extra, ...t.tags] }));
      return {
        p,
        tasks: [
          ...tagged(this.parseTasks(p.pre_tasks, playbookPath, playDir), playTags),
          ...loaded.flatMap((r) => tagged(r.tasks, [...playTags, ...(r.spec.tags ? (Array.isArray(r.spec.tags) ? r.spec.tags.map(String) : [String(r.spec.tags)]) : [])])),
          ...tagged(this.parseTasks(p.tasks, playbookPath, playDir), playTags),
          ...tagged(this.parseTasks(p.post_tasks, playbookPath, playDir), playTags),
        ],
        handlers: [...loaded.flatMap((r) => r.handlers), ...this.parseTasks(p.handlers, playbookPath, playDir)],
        roleDefaults: Object.assign({}, ...loaded.map((r) => r.defaults)) as Obj,
        roleVars: Object.assign({}, ...loaded.map((r) => ({ ...r.vars, ...((r.spec.vars as Obj) ?? {}) }))) as Obj,
      };
    });
    return { plays, playDir, inv };
  }

  run(playbookPath: string): number {
    const { plays, playDir, inv } = this.parse(playbookPath);
    for (const play of plays) {
      const p = play.p;
      const pattern = String(p.hosts);
      let { hosts } = matchPattern(inv, pattern);
      if (this.o.limit) {
        const lim = matchPattern(inv, this.o.limit).hosts;
        hosts = hosts.filter((h) => lim.includes(h));
      }
      const title = p.name ? String(p.name) : pattern;
      this.out.push('', header('PLAY', title));
      if (!hosts.length) {
        this.out.push('skipping: no hosts matched');
        continue;
      }
      const varsFiles: Obj = {};
      for (const vf of (p.vars_files as string[]) ?? []) {
        const fp = normalize(joinPath(playDir, vf));
        const v = this.yamlFile(fp);
        if (v === undefined) throw new AnsibleError(`ERROR! vars file ${vf} was not found\nCould not find file on the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option`, 1);
        Object.assign(varsFiles, v);
      }
      const playVars: Obj = { ...((p.vars as Obj) ?? {}), ...varsFiles, ...play.roleVars };
      const become = toBool(p.become ?? this.o.become);
      for (const name of hosts) {
        let h = this.hosts.get(name);
        if (!h) {
          h = { name, target: null, vars: {}, facts: {}, registered: {}, failed: false, unreachable: false, notified: new Set(), counts: { ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 } };
          this.hosts.set(name, h);
        }
        h.vars = { ...play.roleDefaults, ...hostVars(inv, name), ...this.fileVars(name, [...new Set([this.o.inventoryDir ?? playDir, playDir])]) };
        h.failed = false;
        h.notified.clear();
      }
      const live = hosts.map((n) => this.hosts.get(n)!);
      // Connect (first task or fact gathering reports unreachable hosts).
      const connectAll = () => {
        for (const h of live) {
          if (h.target || h.unreachable) continue;
          const v = this.varsFor(h, playVars);
          const user = String(templateValue(v.ansible_user ?? p.remote_user ?? this.o.remoteUser ?? this.state.user, v));
          const r = connect(this.state, {
            host: String(templateValue(v.ansible_host ?? h.name, v)),
            user,
            key: (v.ansible_ssh_private_key_file ?? v.ansible_private_key_file ?? this.o.privateKey) as string | undefined,
            local: v.ansible_connection === 'local',
          });
          if ('error' in r) {
            h.unreachable = true;
            h.counts.unreachable++;
            (gather ? this.out : this.pending).push(`fatal: [${h.name}]: UNREACHABLE! => ${jsonPretty({ changed: false, msg: r.error, unreachable: true })}`);
          } else h.target = r;
        }
      };
      const gather = p.gather_facts === undefined ? true : toBool(p.gather_facts);
      if (gather) {
        this.out.push('', header('TASK', 'Gathering Facts'));
        const before = this.out.length;
        connectAll();
        for (const h of live) {
          if (h.unreachable || this.out.slice(before).some((l) => l.includes(`[${h.name}]: UNREACHABLE`))) continue;
          h.facts = this.facts(h);
          h.counts.ok++;
          this.out.push(`ok: [${h.name}]`);
        }
      }
      const handlerNames = new Set<string>();
      for (const hd of play.handlers) {
        handlerNames.add(this.label(hd));
        if (hd.name) handlerNames.add(hd.name);
        for (const l of hd.raw.listen === undefined ? [] : Array.isArray(hd.raw.listen) ? hd.raw.listen : [hd.raw.listen]) handlerNames.add(String(l));
      }
      let stopped = false;
      for (const t of play.tasks) {
        if (!live.some((h) => !h.failed && !h.unreachable)) {
          this.out.push('', 'NO MORE HOSTS LEFT ' + '*'.repeat(60));
          stopped = true;
          break;
        }
        if (!gather && this.selected(t)) connectAll();
        this.runTask(t, live, playVars, playDir, handlerNames, become);
      }
      if (!stopped) this.runHandlers(play.handlers, live, playVars, playDir, become);
    }
    this.out.push('', 'PLAY RECAP ' + '*'.repeat(68));
    for (const h of [...this.hosts.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const c = h.counts;
      const col = (k: string, n: number) => `${k}=${String(n).padEnd(4)}`;
      this.out.push(`${h.name.padEnd(26)} : ${col('ok', c.ok)} ${col('changed', c.changed)} ${col('unreachable', c.unreachable)} ${col('failed', c.failed)} ${col('skipped', c.skipped)} ${col('rescued', c.rescued)} ${col('ignored', c.ignored)}`);
    }
    this.out.push('');
    const anyFailed = [...this.hosts.values()].some((h) => h.counts.failed > 0);
    const anyUnreach = [...this.hosts.values()].some((h) => h.counts.unreachable > 0);
    (this.state.ansible ??= { runs: [] }).runs.push({
      playbook: playbookPath,
      check: this.o.check,
      at: this.state.clock,
      recap: Object.fromEntries([...this.hosts.values()].map((h) => [h.name, { ok: h.counts.ok, changed: h.counts.changed, unreachable: h.counts.unreachable, failed: h.counts.failed, skipped: h.counts.skipped }])),
    });
    return anyFailed ? 2 : anyUnreach ? 4 : 0;
  }
}
