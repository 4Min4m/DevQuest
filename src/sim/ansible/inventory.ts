/** Ansible inventories (INI and YAML) and host patterns. */
import { parse as parseYaml } from 'yaml';

export interface Inventory {
  /** Hosts in definition order, with their own vars. */
  hosts: Map<string, Record<string, unknown>>;
  /** Group → direct hosts, child groups and vars. */
  groups: Map<string, { hosts: string[]; children: string[]; vars: Record<string, unknown> }>;
}

function group(inv: Inventory, name: string) {
  let g = inv.groups.get(name);
  if (!g) {
    g = { hosts: [], children: [], vars: {} };
    inv.groups.set(name, g);
  }
  return g;
}

function addHost(inv: Inventory, host: string, vars: Record<string, unknown>, grp: string) {
  inv.hosts.set(host, { ...(inv.hosts.get(host) ?? {}), ...vars });
  const g = group(inv, grp);
  if (!g.hosts.includes(host)) g.hosts.push(host);
}

function scalar(v: string): unknown {
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^(true|True|yes)$/.test(v)) return true;
  if (/^(false|False|no)$/.test(v)) return false;
  return v.replace(/^(['"])(.*)\1$/, '$2');
}

function kv(parts: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i)] = scalar(p.slice(i + 1));
  }
  return out;
}

/** Expand `web[1:3]` style ranges. */
function expand(host: string): string[] {
  const m = /^(.*)\[(\d+):(\d+)\](.*)$/.exec(host);
  if (!m) return [host];
  const out: string[] = [];
  const width = m[2].length;
  for (let i = Number(m[2]); i <= Number(m[3]); i++) out.push(m[1] + String(i).padStart(width, '0') + m[4]);
  return out;
}

export class InventoryError extends Error {}

export function parseIni(text: string): Inventory {
  const inv: Inventory = { hosts: new Map(), groups: new Map() };
  group(inv, 'all');
  group(inv, 'ungrouped');
  let section = 'ungrouped';
  let kind: 'hosts' | 'vars' | 'children' = 'hosts';
  text.split('\n').forEach((raw, idx) => {
    const line = raw.replace(/\s[#;].*$/, '').replace(/^[#;].*$/, '').trim();
    if (!line) return;
    const sec = /^\[([^\]:]+)(?::(vars|children))?\]$/.exec(line);
    if (sec) {
      section = sec[1];
      kind = (sec[2] as 'vars' | 'children') ?? 'hosts';
      group(inv, section);
      return;
    }
    if (line.startsWith('[')) throw new InventoryError(`Invalid section entry: '${line}'. Please make sure that there are no spaces in the section entry, and that there are no other invalid characters`);
    const parts = line.split(/\s+/);
    if (kind === 'vars') {
      const i = line.indexOf('=');
      if (i < 0) throw new InventoryError(`/inventory:${idx + 1}: Expected key=value, got: ${line}`);
      group(inv, section).vars[line.slice(0, i).trim()] = scalar(line.slice(i + 1).trim());
    } else if (kind === 'children') {
      const g = group(inv, section);
      group(inv, parts[0]);
      if (!g.children.includes(parts[0])) g.children.push(parts[0]);
    } else {
      for (const h of expand(parts[0])) addHost(inv, h, kv(parts.slice(1)), section);
    }
  });
  return finish(inv);
}

export function parseYamlInventory(text: string): Inventory {
  const inv: Inventory = { hosts: new Map(), groups: new Map() };
  group(inv, 'ungrouped');
  const doc = parseYaml(text) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') throw new InventoryError('Invalid data from file, expected dictionary and got:\n\n' + String(doc));
  const walk = (name: string, body: Record<string, unknown> | null) => {
    const g = group(inv, name);
    if (!body) return;
    for (const [h, hv] of Object.entries((body.hosts as Record<string, Record<string, unknown> | null>) ?? {})) for (const x of expand(h)) addHost(inv, x, hv ?? {}, name);
    Object.assign(g.vars, (body.vars as Record<string, unknown>) ?? {});
    for (const [c, cb] of Object.entries((body.children as Record<string, Record<string, unknown> | null>) ?? {})) {
      if (!g.children.includes(c)) g.children.push(c);
      walk(c, cb);
    }
  };
  for (const [name, body] of Object.entries(doc)) walk(name, body as Record<string, unknown>);
  return finish(inv);
}

/** Every group is a child of all; hosts in no group are "ungrouped". */
function finish(inv: Inventory): Inventory {
  const all = group(inv, 'all');
  for (const name of inv.groups.keys()) if (name !== 'all' && !all.children.includes(name) && ![...inv.groups.values()].some((g) => g.children.includes(name))) all.children.push(name);
  const ung = group(inv, 'ungrouped');
  ung.hosts = ung.hosts.filter((h) => ![...inv.groups.entries()].some(([n, g]) => n !== 'ungrouped' && n !== 'all' && g.hosts.includes(h)));
  return inv;
}

export function parseInventory(text: string, path: string): Inventory {
  if (/\.ya?ml$/.test(path) || /^\s*all\s*:/m.test(text) && !/^\[/m.test(text)) return parseYamlInventory(text);
  return parseIni(text);
}

/** Hosts in a group, recursively, in inventory order. */
export function groupHosts(inv: Inventory, name: string, seen = new Set<string>()): string[] {
  if (name === 'all') return [...inv.hosts.keys()];
  const g = inv.groups.get(name);
  if (!g || seen.has(name)) return [];
  seen.add(name);
  const set = new Set([...g.hosts, ...g.children.flatMap((c) => groupHosts(inv, c, seen))]);
  return [...inv.hosts.keys()].filter((h) => set.has(h));
}

/** Groups a host belongs to (directly or through parents), outermost first. */
export function groupsOf(inv: Inventory, host: string): string[] {
  const out: string[] = [];
  for (const name of inv.groups.keys()) if (name !== 'all' && groupHosts(inv, name).includes(host)) out.push(name);
  // Parents before children so child group vars win.
  const depth = (n: string): number => {
    const parent = [...inv.groups.entries()].find(([p, g]) => p !== 'all' && g.children.includes(n));
    return parent ? 1 + depth(parent[0]) : 0;
  };
  return out.sort((a, b) => depth(a) - depth(b));
}

/** Resolve a pattern like `web:db:!web2` or `web:&prod` (also comma separated). Unknown parts are returned in `unmatched`. */
export function matchPattern(inv: Inventory, pattern: string): { hosts: string[]; unmatched: string[] } {
  const parts = pattern.split(/[:,]/).filter(Boolean);
  let acc: string[] = [];
  const unmatched: string[] = [];
  const one = (p: string): string[] => {
    if (p === 'all' || p === '*') return [...inv.hosts.keys()];
    if (inv.groups.has(p)) return groupHosts(inv, p);
    if (inv.hosts.has(p)) return [p];
    if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return [...inv.hosts.keys()].filter((h) => re.test(h));
    }
    unmatched.push(p);
    return [];
  };
  for (const p of parts) {
    if (p.startsWith('!')) {
      const ex = one(p.slice(1));
      acc = acc.filter((h) => !ex.includes(h));
    } else if (p.startsWith('&')) {
      const inter = one(p.slice(1));
      acc = acc.filter((h) => inter.includes(h));
    } else for (const h of one(p)) if (!acc.includes(h)) acc.push(h);
  }
  const order = [...inv.hosts.keys()];
  return { hosts: acc.sort((a, b) => order.indexOf(a) - order.indexOf(b)), unmatched };
}

/** Variables for a host: all → parent groups → child groups → host (host vars win). */
export function hostVars(inv: Inventory, host: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(inv.groups.get('all')?.vars ?? {}) };
  for (const g of groupsOf(inv, host)) Object.assign(out, inv.groups.get(g)!.vars);
  Object.assign(out, inv.hosts.get(host) ?? {});
  return out;
}
