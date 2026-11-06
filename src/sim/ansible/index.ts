/** The ansible, ansible-playbook and ansible-inventory commands. */
import { groupsOf as userGroups } from '../shell/identity';
import type { CommandContext, CommandDef } from '../shell/types';
import type { SimState } from '../state';
import { dirname, normalize } from '../vfs/path';
import { Vfs } from '../vfs/vfs';
import { connect } from './connect';
import { pyStr, templateValue } from './jinja';
import { groupHosts, hostVars, Inventory, InventoryError, matchPattern, parseIni, parseInventory } from './inventory';
import { moduleName, ModResult, parseKv, runModule } from './modules';
import { AnsibleError, jsonPretty, loadYaml, PlaybookRunner } from './playbook';

const VERSION = 'ansible [core 2.17.5]';

interface Cfg {
  path: string | null;
  inventory?: string;
  remoteUser?: string;
  privateKey?: string;
  become?: boolean;
}

function vfsOf(state: SimState): Vfs {
  return new Vfs(state.fs, { name: state.user, groups: userGroups(state, state.user) });
}

function readCfg(ctx: CommandContext): Cfg {
  const v = vfsOf(ctx.state);
  const home = ctx.state.vars.HOME ?? '/';
  const cands = [ctx.env.ANSIBLE_CONFIG, ctx.resolve('ansible.cfg'), `${home}/.ansible.cfg`, '/etc/ansible/ansible.cfg'].filter(Boolean) as string[];
  for (const p of cands) {
    let text: string;
    try {
      text = v.readFile(ctx.resolve(p));
    } catch {
      continue;
    }
    const cfg: Cfg = { path: ctx.resolve(p) };
    let section = '';
    for (const raw of text.split('\n')) {
      const line = raw.replace(/[#;].*$/, '').trim();
      const sec = /^\[(.+)\]$/.exec(line);
      if (sec) {
        section = sec[1];
        continue;
      }
      const kv = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
      if (!kv) continue;
      const [, k, val] = kv;
      if (section === 'defaults' && k === 'inventory') cfg.inventory = val.replace(/^~/, home);
      if (section === 'defaults' && k === 'remote_user') cfg.remoteUser = val;
      if (section === 'defaults' && k === 'private_key_file') cfg.privateKey = val;
      if (section === 'privilege_escalation' && k === 'become') cfg.become = /^(true|yes|1)$/i.test(val);
    }
    // The inventory path in ansible.cfg is relative to the config file.
    if (cfg.inventory && !cfg.inventory.startsWith('/')) cfg.inventory = normalize(dirname(cfg.path!) + '/' + cfg.inventory);
    return cfg;
  }
  return { path: null };
}

interface Common {
  inventory: string[];
  extraVars: Record<string, unknown>;
  become: boolean;
  user?: string;
  key?: string;
  check: boolean;
  diff: boolean;
  limit?: string;
  verbose: number;
  rest: string[];
  module?: string;
  args?: string;
  tags?: string[];
  skipTags?: string[];
  flags: Set<string>;
}

function parseArgs(ctx: CommandContext, adhoc: boolean): Common {
  const a = [...ctx.args];
  const c: Common = { inventory: [], extraVars: {}, become: false, check: false, diff: false, verbose: 0, rest: [], flags: new Set() };
  const val = (flag: string) => {
    const v = a.shift();
    if (v === undefined) throw new AnsibleError(`usage: ${ctx.name} [-h] ...\n${ctx.name}: error: argument ${flag}: expected one argument`, 2);
    return v;
  };
  while (a.length) {
    let x = a.shift()!;
    const eq = /^(--[\w-]+)=(.*)$/.exec(x);
    if (eq) {
      x = eq[1];
      a.unshift(eq[2]);
    }
    if (x === '-i' || x === '--inventory' || x === '--inventory-file') c.inventory.push(val(x));
    else if (x === '-e' || x === '--extra-vars') {
      const v = val(x);
      if (v.startsWith('@')) {
        try {
          Object.assign(c.extraVars, loadYaml(vfsOf(ctx.state).readFile(ctx.resolve(v.slice(1))), v.slice(1)) as object);
        } catch {
          throw new AnsibleError(`ERROR! file could not read: ${v.slice(1)}`, 5);
        }
      } else if (v.trim().startsWith('{')) Object.assign(c.extraVars, JSON.parse(v));
      else Object.assign(c.extraVars, parseKv(v));
    } else if (x === '-b' || x === '--become') c.become = true;
    else if (x === '-u' || x === '--user') c.user = val(x);
    else if (x === '--key-file' || x === '--private-key') c.key = val(x);
    else if (x === '-C' || x === '--check') c.check = true;
    else if (x === '-D' || x === '--diff') c.diff = true;
    else if (x === '-l' || x === '--limit') c.limit = val(x);
    else if (x === '-t' || x === '--tags') c.tags = [...(c.tags ?? []), ...val(x).split(',')];
    else if (x === '--skip-tags') c.skipTags = [...(c.skipTags ?? []), ...val(x).split(',')];
    else if (/^-v+$/.test(x)) c.verbose = x.length - 1;
    else if (adhoc && (x === '-m' || x === '--module-name')) c.module = val(x);
    else if (adhoc && (x === '-a' || x === '--args')) c.args = val(x);
    else if (['--syntax-check', '--list-hosts', '--list-tasks', '--version', '--list', '--graph', '--host', '-h', '--help', '--yaml'].includes(x)) c.flags.add(x);
    else if (x === '-K' || x === '--ask-become-pass' || x === '-k' || x === '--ask-pass') throw new AnsibleError(`devquest: ${x} prompts for a password; cloud images use passwordless sudo, so just drop it`, 1);
    else if (x.startsWith('-')) throw new AnsibleError(`usage: ${ctx.name} [-h] [--version] [-v] ...\n${ctx.name}: error: unrecognized arguments: ${x}`, 2);
    else c.rest.push(x);
  }
  return c;
}

/** Load the inventory (-i paths, a "host1,host2," list, ansible.cfg, or /etc/ansible/hosts). */
function loadInventory(ctx: CommandContext, c: Common, cfg: Cfg): { inv: Inventory; dir: string | null } {
  const sources = c.inventory.length ? c.inventory : [cfg.inventory ?? '/etc/ansible/hosts'];
  const v = vfsOf(ctx.state);
  const merged: Inventory = parseIni('');
  let dir: string | null = null;
  let parsed = 0;
  for (const src of sources) {
    if (src.includes(',') && !v.exists(ctx.resolve(src))) {
      for (const h of src.split(',').map((s) => s.trim()).filter(Boolean)) {
        merged.hosts.set(h, {});
        merged.groups.get('ungrouped')!.hosts.push(h);
      }
      parsed++;
      continue;
    }
    const path = ctx.resolve(src);
    let text: string;
    try {
      text = v.readFile(path);
    } catch {
      if (c.inventory.length) ctx.note(`[WARNING]: Unable to parse ${path} as an inventory source\n`);
      continue;
    }
    try {
      const inv = parseInventory(text, path);
      for (const [h, hv] of inv.hosts) merged.hosts.set(h, { ...(merged.hosts.get(h) ?? {}), ...hv });
      for (const [g, gv] of inv.groups) {
        const cur = merged.groups.get(g);
        if (!cur) merged.groups.set(g, gv);
        else {
          cur.hosts.push(...gv.hosts.filter((h) => !cur.hosts.includes(h)));
          cur.children.push(...gv.children.filter((h) => !cur.children.includes(h)));
          Object.assign(cur.vars, gv.vars);
        }
      }
      dir ??= dirname(path);
      parsed++;
    } catch (e) {
      ctx.note(`[WARNING]:  * Failed to parse ${path} with ini plugin: ${(e as Error).message}\n[WARNING]: Unable to parse ${path} as an inventory source\n`);
    }
  }
  if (!parsed) ctx.note('[WARNING]: No inventory was parsed, only implicit localhost is available\n');
  // Implicit localhost.
  if (!merged.hosts.has('localhost')) {
    /* only matched by name, like Ansible's implicit localhost */
  }
  return { inv: merged, dir };
}

function targets(ctx: CommandContext, inv: Inventory, pattern: string, limit?: string): string[] {
  const { hosts, unmatched } = matchPattern(inv, pattern);
  let out = hosts;
  for (const u of unmatched) {
    if (u === 'localhost' || u === '127.0.0.1') {
      inv.hosts.set(u, { ansible_connection: 'local' });
      out.push(u);
    } else ctx.note(`[WARNING]: Could not match supplied host pattern, ignoring: ${u}\n`);
  }
  if (limit) {
    const lim = matchPattern(inv, limit).hosts;
    out = out.filter((h) => lim.includes(h));
  }
  return out;
}

function fail(ctx: CommandContext, e: unknown): number {
  if (e instanceof AnsibleError) {
    ctx.err(e.message + '\n');
    return e.code;
  }
  if (e instanceof InventoryError) {
    ctx.err(`ERROR! ${e.message}\n`);
    return 1;
  }
  throw e;
}

function versionText(cfg: Cfg): string {
  return `${VERSION}\n  config file = ${cfg.path ?? 'None'}\n  configured module search path = ['/home/student/.ansible/plugins/modules']\n  ansible python module location = /usr/lib/python3/dist-packages/ansible\n  python version = 3.12.3 (main, Sep 11 2024, 14:17:37) [GCC 13.2.0]\n  jinja version = 3.1.2\n`;
}

export const ansible: CommandDef = {
  name: 'ansible',
  summary: 'run one Ansible module on hosts (ansible web -m ping)',
  run(ctx) {
    try {
      const cfg = readCfg(ctx);
      const c = parseArgs(ctx, true);
      if (c.flags.has('--version')) {
        ctx.out(versionText(cfg));
        return 0;
      }
      const pattern = c.rest[0];
      if (!pattern) throw new AnsibleError('usage: ansible [-h] [--version] [-v] [-b] [-i INVENTORY] [-m MODULE_NAME] [-a MODULE_ARGS] pattern\nansible: error: the following arguments are required: pattern', 2);
      const { inv } = loadInventory(ctx, c, cfg);
      const hosts = targets(ctx, inv, pattern, c.limit);
      if (c.flags.has('--list-hosts')) {
        ctx.out(`  hosts (${hosts.length}):\n` + hosts.map((h) => `    ${h}\n`).join(''));
        return 0;
      }
      if (!hosts.length) {
        ctx.note('[WARNING]: No hosts matched, nothing to do\n');
        return 0;
      }
      const mod = c.module ?? 'command';
      if (!moduleName(mod)) throw new AnsibleError(`ERROR! couldn't resolve module/action '${mod}'. This often indicates a misspelling, missing collection, or incorrect module path.`, 1);
      const canonical = moduleName(mod)!;
      let code = 0;
      for (const h of hosts) {
        const hv: Record<string, unknown> = { ...hostVars(inv, h), ...c.extraVars, inventory_hostname: h };
        const t = connect(ctx.state, {
          host: String(templateValue(hv.ansible_host ?? h, hv)),
          user: String(hv.ansible_user ?? c.user ?? cfg.remoteUser ?? ctx.state.user),
          key: (hv.ansible_ssh_private_key_file ?? c.key ?? cfg.privateKey) as string | undefined,
          local: hv.ansible_connection === 'local',
        });
        if ('error' in t) {
          ctx.out(`${h} | UNREACHABLE! => ${jsonPretty({ changed: false, msg: t.error, unreachable: true })}\n`);
          code = Math.max(code, 4);
          continue;
        }
        const become = c.become || !!cfg.become;
        if (become && !t.canSudo) {
          ctx.out(`${h} | FAILED! => ${jsonPretty({ changed: false, msg: 'Missing sudo password' })}\n`);
          code = Math.max(code, 2);
          continue;
        }
        let args = c.args ? parseKv(c.args) : {};
        if ((canonical === 'command' || canonical === 'shell') && c.args) args = { ...parseKv(c.args), _raw_params: c.args.replace(/^(chdir|creates|removes)=\S+\s+/, '') };
        args = templateValue(args, hv) as Record<string, unknown>;
        if ((canonical === 'command' || canonical === 'shell') && !args._raw_params && !args.cmd) {
          ctx.out(`${h} | FAILED! => ${jsonPretty({ changed: false, msg: 'No argument passed to command module' })}\n`);
          code = Math.max(code, 2);
          continue;
        }
        const r: ModResult = runModule(mod, { m: t.m, user: t.user, become: become || t.user === 'root', check: c.check, vars: hv, findLocal: (_k, src) => {
          try {
            const p = ctx.resolve(src);
            return { path: p, content: vfsOf(ctx.state).readFile(p) };
          } catch {
            return null;
          }
        } }, args);
        if (canonical === 'command' || canonical === 'shell') {
          if (r.skipped) {
            ctx.out(`${h} | SKIPPED\n`);
            continue;
          }
          const text = [r.stdout, r.stderr].filter((x) => x).join('\n');
          if (r.failed) {
            ctx.out(`${h} | FAILED | rc=${r.rc ?? 1} >>\n${text ? text + '\n' : ''}${r.msg}\n`);
            code = Math.max(code, 2);
          } else ctx.out(`${h} | ${r.changed ? 'CHANGED' : 'SUCCESS'} | rc=${r.rc} >>\n${text ? text + '\n' : ''}`);
          continue;
        }
        const shown: Record<string, unknown> = {};
        if (canonical === 'ping' || !c.check) shown.ansible_facts = { discovered_interpreter_python: '/usr/bin/python3' };
        for (const [k, v] of Object.entries(r)) if (!k.startsWith('__') && !['diff', 'stdout', 'stdout_lines', 'failed', 'skipped'].includes(k)) shown[k] = v;
        if (canonical === 'debug') {
          delete shown.ansible_facts;
          if ('__var' in r) {
            delete shown.msg;
            try {
              shown[String(r.__var)] = templateValue(`{{ ${r.__var} }}`, hv);
            } catch {
              shown[String(r.__var)] = 'VARIABLE IS NOT DEFINED!';
            }
          }
        }
        if (r.failed) {
          ctx.out(`${h} | FAILED! => ${jsonPretty(shown)}\n`);
          code = Math.max(code, 2);
        } else ctx.out(`${h} | ${r.changed ? 'CHANGED' : 'SUCCESS'} => ${jsonPretty(shown)}\n`);
      }
      return code;
    } catch (e) {
      return fail(ctx, e);
    }
  },
};

export const ansiblePlaybook: CommandDef = {
  name: 'ansible-playbook',
  summary: 'run an Ansible playbook against inventory hosts',
  run(ctx) {
    try {
      const cfg = readCfg(ctx);
      const c = parseArgs(ctx, false);
      if (c.flags.has('--version')) {
        ctx.out(versionText(cfg).replace('ansible [', 'ansible-playbook ['));
        return 0;
      }
      if (!c.rest.length) throw new AnsibleError('usage: ansible-playbook [-h] [--version] [-v] [-i INVENTORY] [-l SUBSET] [-e EXTRA_VARS] [-C] [-D] playbook [playbook ...]\nansible-playbook: error: the following arguments are required: playbook', 2);
      const { inv, dir } = loadInventory(ctx, c, cfg);
      let code = 0;
      for (const pb of c.rest) {
        const path = ctx.resolve(pb);
        const runner = new PlaybookRunner(ctx.state, {
          inventory: inv,
          inventoryDir: dir,
          limit: c.limit,
          tags: c.tags,
          skipTags: c.skipTags,
          check: c.check,
          diff: c.diff,
          extraVars: c.extraVars,
          become: c.become || !!cfg.become,
          remoteUser: c.user ?? cfg.remoteUser,
          privateKey: c.key ?? cfg.privateKey,
          verbose: c.verbose,
        });
        if (c.flags.has('--syntax-check') || c.flags.has('--list-hosts')) {
          const doc = loadYaml(vfsOrThrow(ctx, path, pb), path);
          if (!Array.isArray(doc)) throw new AnsibleError(`ERROR! A playbook must be a list of plays, got a <class 'dict'> instead`, 4);
          // Parse tasks (module names, structure) without running anything.
          const dry = new PlaybookRunner(structuredClone(ctx.state), { ...runnerOpts(inv, dir, c, cfg), check: true });
          dry.validateOnly(path);
          ctx.out(`\nplaybook: ${pb}\n`);
          if (c.flags.has('--list-hosts')) {
            (doc as Record<string, unknown>[]).forEach((p, i) => {
              let hosts = matchPattern(inv, String(p.hosts)).hosts;
              if (c.limit) hosts = hosts.filter((h) => matchPattern(inv, c.limit!).hosts.includes(h));
              ctx.out(`\n  play #${i + 1} (${p.hosts}): ${p.name ?? p.hosts}\tTAGS: []\n    pattern: ['${p.hosts}']\n    hosts (${hosts.length}):\n${hosts.map((h) => `      ${h}\n`).join('')}`);
            });
          }
          continue;
        }
        let r: number;
        try {
          r = runner.run(path);
        } finally {
          if (runner.out.length) ctx.out(runner.out.join('\n') + '\n');
        }
        code = Math.max(code, r);
      }
      return code;
    } catch (e) {
      return fail(ctx, e);
    }
  },
};

function runnerOpts(inv: Inventory, dir: string | null, c: Common, cfg: Cfg) {
  return { inventory: inv, inventoryDir: dir, limit: c.limit, tags: c.tags, skipTags: c.skipTags, check: c.check, diff: c.diff, extraVars: c.extraVars, become: c.become || !!cfg.become, remoteUser: c.user ?? cfg.remoteUser, privateKey: c.key ?? cfg.privateKey, verbose: c.verbose };
}

function vfsOrThrow(ctx: CommandContext, path: string, name: string): string {
  try {
    return vfsOf(ctx.state).readFile(path);
  } catch {
    throw new AnsibleError(`ERROR! the playbook: ${name} could not be found`, 1);
  }
}

export const ansibleInventory: CommandDef = {
  name: 'ansible-inventory',
  summary: 'show the parsed inventory (--list, --graph)',
  run(ctx) {
    try {
      const cfg = readCfg(ctx);
      const c = parseArgs(ctx, false);
      const { inv } = loadInventory(ctx, c, cfg);
      if (c.flags.has('--graph')) {
        const lines: string[] = [];
        const walk = (g: string, depth: number) => {
          const pad = depth === 0 ? '' : '  ' + '|  '.repeat(depth - 1) + '|--';
          lines.push(`${pad}@${g}:`);
          const grp = inv.groups.get(g)!;
          const kids = g === 'all' ? ['ungrouped', ...grp.children.filter((x) => x !== 'ungrouped')] : grp.children;
          for (const k of kids) if (inv.groups.has(k)) walk(k, depth + 1);
          const own = g === 'all' ? [] : grp.hosts;
          for (const h of own) lines.push('  ' + '|  '.repeat(depth) + '|--' + h);
        };
        walk(c.rest[0] ?? 'all', 0);
        ctx.out(lines.join('\n') + '\n');
        return 0;
      }
      if (c.flags.has('--host')) {
        const h = c.rest[0];
        if (!h || !inv.hosts.has(h)) throw new AnsibleError(`ERROR! You must pass a single valid host to --host parameter`, 1);
        ctx.out(jsonPretty(hostVars(inv, h)) + '\n');
        return 0;
      }
      if (!c.flags.has('--list')) throw new AnsibleError('usage: ansible-inventory [-h] [--version] [-v] [-i INVENTORY] [--list] [--host HOST] [--graph [GROUP]]\nansible-inventory: error: No action selected, at least one of --host, --graph or --list needs to be specified.', 2);
      const out: Record<string, unknown> = { _meta: { hostvars: Object.fromEntries([...inv.hosts.keys()].filter((h) => Object.keys(hostVars(inv, h)).length).map((h) => [h, hostVars(inv, h)])) } };
      for (const [g, gv] of inv.groups) {
        const entry: Record<string, unknown> = {};
        if (gv.children.length) entry.children = gv.children;
        if (gv.hosts.length && g !== 'all') entry.hosts = gv.hosts;
        if (g === 'all') entry.children = ['ungrouped', ...gv.children.filter((x) => x !== 'ungrouped')];
        if (Object.keys(entry).length) out[g] = entry;
      }
      void groupHosts;
      void pyStr;
      ctx.out(jsonPretty(out) + '\n');
      return 0;
    } catch (e) {
      return fail(ctx, e);
    }
  },
};

export const ansibleCommands: CommandDef[] = [ansible, ansiblePlaybook, ansibleInventory];
