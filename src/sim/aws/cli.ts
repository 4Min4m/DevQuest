/** The aws CLI (v2): credentials, global options, output formats and the supported services. */
import type { CommandContext, CommandDef } from '../shell/types';
import type { SimState } from '../state';
import { joinPath } from '../vfs/path';
import { Vfs } from '../vfs/vfs';
import * as api from './api';
import { AwsError, Caller } from './api';
import { jmes, JmesError } from './jmes';
import { iso, instanceShape, shapes, stateOf } from './shapes';
import type { AwsState, Instance, SgRule, Tags } from './types';

export class CliError extends Error {
  constructor(msg: string, public code: number) {
    super(msg);
  }
}

// ------------------------------------------------------------------ config files

function readIni(ctx: CommandContext, path: string): Record<string, Record<string, string>> {
  let text = '';
  try {
    text = ctx.vfs.readFile(path);
  } catch {
    return {};
  }
  const out: Record<string, Record<string, string>> = {};
  let sec = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      sec = s[1].replace(/^profile\s+/, '');
      out[sec] ??= {};
      continue;
    }
    const kv = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && sec) out[sec][kv[1]] = kv[2];
  }
  return out;
}

function writeIni(ctx: CommandContext, path: string, data: Record<string, Record<string, string>>, config: boolean) {
  const text = Object.entries(data)
    .map(([sec, kv]) => `[${config && sec !== 'default' ? 'profile ' + sec : sec}]\n` + Object.entries(kv).map(([k, v]) => `${k} = ${v}\n`).join(''))
    .join('');
  ctx.vfs.mkdir(path.replace(/\/[^/]+$/, ''), { parents: true });
  ctx.vfs.writeFile(path, text);
}

interface Resolved {
  keyId?: string;
  secret?: string;
  region?: string;
  profile: string;
  source: string;
}

export function resolveConfig(ctx: CommandContext, g: Globals): Resolved {
  const home = ctx.state.vars.HOME ?? '/';
  const creds = readIni(ctx, ctx.env.AWS_SHARED_CREDENTIALS_FILE ?? `${home}/.aws/credentials`);
  const conf = readIni(ctx, ctx.env.AWS_CONFIG_FILE ?? `${home}/.aws/config`);
  const profile = g.profile ?? ctx.env.AWS_PROFILE ?? 'default';
  if ((g.profile || ctx.env.AWS_PROFILE) && !creds[profile] && !conf[profile]) throw new CliError(`\nThe config profile (${profile}) could not be found\n`, 255);
  const r: Resolved = { profile, source: '' };
  if (ctx.env.AWS_ACCESS_KEY_ID && ctx.env.AWS_SECRET_ACCESS_KEY) {
    r.keyId = ctx.env.AWS_ACCESS_KEY_ID;
    r.secret = ctx.env.AWS_SECRET_ACCESS_KEY;
    r.source = 'env';
  } else if (creds[profile]?.aws_access_key_id) {
    r.keyId = creds[profile].aws_access_key_id;
    r.secret = creds[profile].aws_secret_access_key;
    r.source = 'shared-credentials-file';
  } else if (conf[profile]?.aws_access_key_id) {
    r.keyId = conf[profile].aws_access_key_id;
    r.secret = conf[profile].aws_secret_access_key;
    r.source = 'config-file';
  }
  r.region = g.region ?? ctx.env.AWS_REGION ?? ctx.env.AWS_DEFAULT_REGION ?? conf[profile]?.region;
  return r;
}

// ------------------------------------------------------------------ args

export interface Globals {
  region?: string;
  profile?: string;
  output?: string;
  query?: string;
  dryRun: boolean;
}

type Args = Record<string, string[] | true>;

const BOOL_FLAGS = new Set(['dry-run', 'no-dry-run', 'recursive', 'force', 'delete', 'map-public-ip-on-launch', 'no-map-public-ip-on-launch', 'associate-public-ip-address', 'no-associate-public-ip-address', 'no-cli-pager', 'human-readable', 'summarize', 'debug', 'include-all-instances', 'enable-dns-hostnames', 'no-paginate']);

/** Options that take several values (`--instance-ids i-1 i-2`). */
const LIST_OPTS = new Set(['instance-ids', 'filters', 'tag-specifications', 'security-group-ids', 'security-groups', 'resources', 'tags', 'group-ids', 'group-names', 'key-names', 'volume-ids', 'allocation-ids', 'subnet-ids', 'vpc-ids', 'route-table-ids', 'image-ids', 'owners']);

function parseArgs(raw: string[]): { pos: string[]; args: Args; g: Globals } {
  const pos: string[] = [];
  const args: Args = {};
  const g: Globals = { dryRun: false };
  const a = [...raw];
  while (a.length) {
    let x = a.shift()!;
    if (!x.startsWith('--')) {
      pos.push(x);
      continue;
    }
    let inline: string | undefined;
    const eq = x.indexOf('=');
    if (eq > 0) {
      inline = x.slice(eq + 1);
      x = x.slice(0, eq);
    }
    const key = x.slice(2);
    if (BOOL_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const vals: string[] = inline !== undefined ? [inline] : [];
    if (inline === undefined && a.length && !a[0].startsWith('--')) vals.push(a.shift()!);
    while (inline === undefined && LIST_OPTS.has(key) && a.length && !a[0].startsWith('--')) vals.push(a.shift()!);
    if (!vals.length) throw new CliError(`\naws: error: argument --${key}: expected one argument\n`, 252);
    if (key === 'region') g.region = vals[0];
    else if (key === 'profile') g.profile = vals[0];
    else if (key === 'output') g.output = vals[0];
    else if (key === 'query') g.query = vals[0];
    else if (key === 'cli-input-json' || key === 'endpoint-url') throw new CliError(`\ndevquest: --${key} is not simulated\n`, 252);
    else args[key] = [...((args[key] as string[]) ?? []), ...vals];
  }
  if (args['dry-run']) g.dryRun = true;
  return { pos, args, g };
}

function readArg(ctx: CommandContext, v: string): string {
  const m = /^fileb?:\/\/(.+)$/.exec(v);
  if (!m) return v;
  const p = ctx.resolve(m[1].replace(/^~(?=\/)/, ctx.state.vars.HOME ?? '~'));
  try {
    return ctx.vfs.readFile(p);
  } catch {
    throw new CliError(`\nError parsing parameter '${'value'}': Unable to load paramfile ${v}: [Errno 2] No such file or directory: '${m[1]}'\n`, 252);
  }
}

/** AWS shorthand: `Key=Name,Value=web` or `Name=tag:env,Values=a,b` (or JSON). */
export function shorthand(s: string): Record<string, unknown> {
  const t = s.trim();
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  const out: Record<string, unknown> = {};
  const parts = t.split(',');
  let lastKey = '';
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0 && !p.slice(0, i).includes('[')) {
      lastKey = p.slice(0, i);
      out[lastKey] = p.slice(i + 1);
    } else if (lastKey) {
      out[lastKey] = ([] as unknown[]).concat(out[lastKey], p);
    }
  }
  return out;
}

function tagsFrom(specs: string[] | undefined, type: string): Tags {
  const tags: Tags = {};
  for (const s of specs ?? []) {
    let j: unknown;
    try {
      j = s.trim().startsWith('[') || s.trim().startsWith('{') ? JSON.parse(s) : undefined;
    } catch {
      j = undefined;
    }
    if (j !== undefined) {
      for (const spec of (Array.isArray(j) ? j : [j]) as { ResourceType?: string; Tags?: { Key: string; Value: string }[]; Key?: string; Value?: string }[]) {
        if (spec.Key) tags[spec.Key] = spec.Value ?? '';
        if (!spec.ResourceType || spec.ResourceType === type) for (const t of spec.Tags ?? []) tags[t.Key] = t.Value;
      }
      continue;
    }
    const rt = /ResourceType=([\w-]+)/.exec(s)?.[1];
    if (rt && rt !== type) continue;
    for (const m of s.matchAll(/\{?Key=([^,}]+),Value=([^}\]]*)\}?/g)) tags[m[1]] = m[2];
  }
  return tags;
}

// ------------------------------------------------------------------ output

function textOut(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return v.map((x) => (x === null ? 'None' : String(x))).join('\t');
    return v.map(textOut).join('\n');
  }
  const entries = Object.entries(v as Record<string, unknown>);
  const scalars = entries.filter(([, x]) => x === null || typeof x !== 'object').map(([, x]) => (x === null ? 'None' : String(x)));
  const nested = entries.filter(([, x]) => x !== null && typeof x === 'object');
  const lines: string[] = [];
  if (scalars.length) lines.push(scalars.join('\t'));
  for (const [k, x] of nested) {
    const t = textOut(x);
    if (!t) continue;
    if (Array.isArray(x) && x.some((y) => y && typeof y === 'object')) lines.push(...t.split('\n').map((l) => `${k.toUpperCase()}\t${l}`));
    else lines.push(`${k.toUpperCase()}\t${t}`);
  }
  return lines.join('\n');
}

function tableOut(title: string, v: unknown): string {
  const rows: string[][] = [];
  const add = (x: unknown) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) rows.push(Object.entries(x).filter(([, y]) => y === null || typeof y !== 'object').map(([k, y]) => `${k}: ${y}`));
    else if (Array.isArray(x)) rows.push(x.map((y) => (y && typeof y === 'object' ? JSON.stringify(y) : String(y))));
    else rows.push([String(x)]);
  };
  if (Array.isArray(v)) v.forEach(add);
  else add(v);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  const inner = Math.max(title.length + 4, widths.reduce((a, b) => a + b + 3, 0) - 1);
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const left = Math.floor((inner - title.length) / 2);
  const out = ['-'.repeat(inner + 2), `|${' '.repeat(left)}${title}${' '.repeat(inner - left - title.length)}|`, `+${'-'.repeat(inner)}+`];
  for (const r of rows) {
    let line = '|' + r.map((c, i) => ` ${pad(c, widths[i])} `).join('|');
    line = pad(line, inner + 1) + '|';
    out.push(line);
  }
  out.push('+' + '-'.repeat(inner) + '+');
  return out.join('\n');
}

const opTitle = (op: string) => op.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');

// ------------------------------------------------------------------ filters

type Getter = (x: never) => unknown;
const tagGetter = (name: string) => (x: { tags: Tags }) => x.tags[name];

const FILTERS: Record<string, Record<string, Getter>> = {
  instance: {
    'instance-state-name': (i: Instance) => i.state,
    'instance-id': (i: Instance) => i.id,
    'instance-type': (i: Instance) => i.type,
    'vpc-id': (i: Instance) => i.vpcId,
    'subnet-id': (i: Instance) => i.subnetId,
    'key-name': (i: Instance) => i.keyName,
    'image-id': (i: Instance) => i.ami,
    'ip-address': (i: Instance) => i.publicIp,
    'private-ip-address': (i: Instance) => i.privateIp,
    'instance.group-id': (i: Instance) => i.sgIds,
  },
  volume: { status: (v: { state: string }) => v.state, 'volume-id': (v: { id: string }) => v.id, 'attachment.instance-id': (v: { attachedTo?: string }) => v.attachedTo, size: (v: { size: number }) => String(v.size), 'volume-type': (v: { type: string }) => v.type },
  sg: { 'group-name': (g: { name: string }) => g.name, 'group-id': (g: { id: string }) => g.id, 'vpc-id': (g: { vpcId: string }) => g.vpcId },
  subnet: { 'vpc-id': (s: { vpcId: string }) => s.vpcId, 'subnet-id': (s: { id: string }) => s.id, 'availability-zone': (s: { az: string }) => s.az, 'default-for-az': (s: { vpcId: string; __default?: boolean }) => String(!!s.__default) },
  vpc: { 'vpc-id': (v: { id: string }) => v.id, 'is-default': (v: { isDefault: boolean }) => String(v.isDefault), 'cidr-block': (v: { cidr: string }) => v.cidr, cidr: (v: { cidr: string }) => v.cidr },
  igw: { 'attachment.vpc-id': (g: { vpcId?: string }) => g.vpcId, 'internet-gateway-id': (g: { id: string }) => g.id },
  rtb: { 'vpc-id': (r: { vpcId: string }) => r.vpcId, 'association.subnet-id': (r: { subnets: string[] }) => r.subnets, 'association.main': (r: { main: boolean }) => String(r.main), 'route-table-id': (r: { id: string }) => r.id },
  address: { 'public-ip': (a: { publicIp: string }) => a.publicIp, 'instance-id': (a: { instanceId?: string }) => a.instanceId, 'allocation-id': (a: { allocationId: string }) => a.allocationId, domain: () => 'vpc' },
  keypair: { 'key-name': (k: { name: string }) => k.name },
  image: { name: (id: string) => api.AMIS[id].name, 'image-id': (id: string) => id, 'owner-id': () => '099720109477', architecture: () => 'x86_64', state: () => 'available' },
};

function applyFilters<T>(kind: string, items: T[], filters: string[] | undefined): T[] {
  if (!filters?.length) return items;
  const parsed = filters.flatMap((f) => {
    const j = f.trim().startsWith('[') ? JSON.parse(f) : [shorthand(f)];
    return (j as { Name: string; Values: unknown }[]).map((x) => ({ name: String(x.Name), values: ([] as unknown[]).concat(x.Values).map(String) }));
  });
  return items.filter((it) =>
    parsed.every(({ name, values }) => {
      const get = name.startsWith('tag:') ? tagGetter(name.slice(4)) : name === 'tag-key' ? (x: { tags: Tags }) => Object.keys(x.tags) : FILTERS[kind]?.[name];
      if (!get) throw new AwsError('InvalidParameterValue', `The filter '${name}' is invalid`, '');
      const v = (get as (x: T) => unknown)(it);
      const vs = (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined).map(String);
      return values.some((want) => {
        const re = new RegExp('^' + want.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        return vs.some((x) => re.test(x));
      });
    }),
  );
}

// ------------------------------------------------------------------ services

interface Ctx {
  ctx: CommandContext;
  c: Caller;
  args: Args;
  g: Globals;
  op: string;
}

const one = (x: Ctx, k: string): string | undefined => {
  const v = x.args[k];
  return v === true || v === undefined ? undefined : readArg(x.ctx, v[0]);
};
const many = (x: Ctx, k: string): string[] => {
  const v = x.args[k];
  return v === true || v === undefined ? [] : v.flatMap((s) => (s.trim().startsWith('[') ? (JSON.parse(s) as string[]) : [s]));
};
const need = (x: Ctx, k: string): string => {
  const v = one(x, k);
  if (v === undefined) throw new CliError(`\naws: error: the following arguments are required: --${k}\n`, 252);
  return v;
};

function dry(x: Ctx, action: string) {
  if (!x.g.dryRun) return;
  api.authorize(x.c, action, opTitle(x.op));
  throw new AwsError('DryRunOperation', 'Request would have succeeded, but DryRun flag is set.', opTitle(x.op));
}

function ruleFrom(x: Ctx): SgRule {
  const perms = one(x, 'ip-permissions');
  if (perms) {
    const p = (perms.trim().startsWith('[') ? JSON.parse(perms)[0] : shorthand(perms)) as Record<string, unknown>;
    const ranges = (p.IpRanges as { CidrIp: string }[] | string | undefined) ?? [];
    const cidrs = typeof ranges === 'string' ? [...ranges.matchAll(/CidrIp=([\d./]+)/g)].map((m) => m[1]) : ranges.map((r) => r.CidrIp);
    return { protocol: String(p.IpProtocol), from: Number(p.FromPort ?? -1), to: Number(p.ToPort ?? -1), cidrs, groups: [] };
  }
  const protocol = need(x, 'protocol');
  const port = one(x, 'port');
  const [from, to] = port === undefined ? [-1, -1] : port === 'all' ? [0, 65535] : port.split('-').map(Number).concat(Number(port.split('-')[0])).slice(0, 2);
  const cidr = one(x, 'cidr');
  const src = one(x, 'source-group');
  if (!cidr && !src) throw new CliError('\nAn error occurred (MissingParameter) when calling the AuthorizeSecurityGroupIngress operation: Either \'cidr\' or \'source-group\' must be specified\n', 254);
  return { protocol: protocol === 'all' ? '-1' : protocol, from, to, cidrs: cidr ? [cidr] : [], groups: src ? [src] : [] };
}

const ec2 = (x: Ctx): unknown => {
  const { c } = x;
  const aws = c.aws;
  api.settle(c);
  const inRegion = <T extends { region: string }>(l: T[]) => l.filter((i) => i.region === c.region);
  const T = opTitle(x.op);
  switch (x.op) {
    case 'describe-instances': {
      api.authorize(c, 'ec2:DescribeInstances', T);
      let list = inRegion(aws.instances);
      const ids = many(x, 'instance-ids');
      for (const id of ids) api.instanceOf(c, id, T);
      if (ids.length) list = list.filter((i) => ids.includes(i.id));
      list = applyFilters('instance', list, many(x, 'filters'));
      return { Reservations: list.map((i) => ({ Groups: [], Instances: [instanceShape(aws, i)], OwnerId: api.ACCOUNT, ReservationId: 'r-' + i.id.slice(2) })) };
    }
    case 'run-instances': {
      dry(x, 'ec2:RunInstances');
      const ud = one(x, 'user-data');
      const insts = api.runInstances(c, {
        ami: need(x, 'image-id'),
        type: one(x, 'instance-type') ?? 'm1.small',
        count: Number(one(x, 'count') ?? 1),
        keyName: one(x, 'key-name'),
        sgIds: [...many(x, 'security-group-ids'), ...many(x, 'security-groups')],
        subnetId: one(x, 'subnet-id'),
        publicIp: x.args['associate-public-ip-address'] ? true : x.args['no-associate-public-ip-address'] ? false : undefined,
        userData: ud,
        tags: tagsFrom(many(x, 'tag-specifications'), 'instance'),
      });
      return { Groups: [], Instances: insts.map((i) => instanceShape(aws, i)), OwnerId: api.ACCOUNT, ReservationId: 'r-' + insts[0].id.slice(2) };
    }
    case 'start-instances':
    case 'stop-instances':
    case 'terminate-instances':
    case 'reboot-instances': {
      const verb = x.op.split('-')[0] as 'start' | 'stop' | 'terminate' | 'reboot';
      dry(x, `ec2:${T}`);
      const ch = api.setInstanceState(c, many(x, 'instance-ids'), verb);
      if (verb === 'reboot') return undefined;
      const key = { start: 'StartingInstances', stop: 'StoppingInstances', terminate: 'TerminatingInstances' }[verb];
      return { [key]: ch.map((s) => ({ CurrentState: stateOf(s.cur), InstanceId: s.id, PreviousState: stateOf(s.prev) })) };
    }
    case 'get-console-output': {
      api.authorize(c, 'ec2:GetConsoleOutput', T);
      const i = api.instanceOf(c, need(x, 'instance-id'), T);
      const m = c.state.machines?.[i.machine];
      let log = '';
      try {
        log = m ? new Vfs(m.fs, { name: 'root', groups: ['root'] }).readFile('/var/log/cloud-init-output.log') : '';
      } catch {
        log = '';
      }
      return { InstanceId: i.id, Timestamp: iso(c.state.clock), Output: `[    0.000000] Linux version 6.8.0-1015-aws\n${log}` };
    }
    case 'describe-vpcs':
      api.authorize(c, 'ec2:DescribeVpcs', T);
      return { Vpcs: applyFilters('vpc', inRegion(aws.vpcs), many(x, 'filters')).filter((v) => !many(x, 'vpc-ids').length || many(x, 'vpc-ids').includes(v.id)).map(shapes.vpc) };
    case 'create-vpc':
      dry(x, 'ec2:CreateVpc');
      return { Vpc: shapes.vpc(api.createVpc(c, need(x, 'cidr-block'), tagsFrom(many(x, 'tag-specifications'), 'vpc'))) };
    case 'delete-vpc':
      api.deleteVpc(c, need(x, 'vpc-id'));
      return undefined;
    case 'modify-vpc-attribute':
      api.vpcOf(c, need(x, 'vpc-id'), T).dnsHostnames = true;
      return undefined;
    case 'describe-subnets':
      api.authorize(c, 'ec2:DescribeSubnets', T);
      return { Subnets: applyFilters('subnet', inRegion(aws.subnets), many(x, 'filters')).filter((s) => !many(x, 'subnet-ids').length || many(x, 'subnet-ids').includes(s.id)).map((s) => shapes.subnet(aws, s)) };
    case 'create-subnet':
      dry(x, 'ec2:CreateSubnet');
      return { Subnet: shapes.subnet(aws, api.createSubnet(c, need(x, 'vpc-id'), need(x, 'cidr-block'), one(x, 'availability-zone'), tagsFrom(many(x, 'tag-specifications'), 'subnet'))) };
    case 'delete-subnet':
      api.deleteSubnet(c, need(x, 'subnet-id'));
      return undefined;
    case 'modify-subnet-attribute': {
      api.authorize(c, 'ec2:ModifySubnetAttribute', T);
      const s = api.subnetOf(c, need(x, 'subnet-id'), T);
      if (x.args['map-public-ip-on-launch']) s.mapPublicIp = true;
      else if (x.args['no-map-public-ip-on-launch']) s.mapPublicIp = false;
      else throw new CliError('\nAn error occurred (InvalidParameterCombination) when calling the ModifySubnetAttribute operation: No attributes specified.\n', 254);
      return undefined;
    }
    case 'describe-internet-gateways':
      api.authorize(c, 'ec2:DescribeInternetGateways', T);
      return { InternetGateways: applyFilters('igw', inRegion(aws.igws), many(x, 'filters')).map(shapes.igw) };
    case 'create-internet-gateway':
      return { InternetGateway: shapes.igw(api.createIgw(c, tagsFrom(many(x, 'tag-specifications'), 'internet-gateway'))) };
    case 'attach-internet-gateway':
      api.attachIgw(c, need(x, 'internet-gateway-id'), need(x, 'vpc-id'));
      return undefined;
    case 'detach-internet-gateway':
      api.detachIgw(c, need(x, 'internet-gateway-id'), need(x, 'vpc-id'));
      return undefined;
    case 'delete-internet-gateway':
      api.deleteIgw(c, need(x, 'internet-gateway-id'));
      return undefined;
    case 'describe-route-tables':
      api.authorize(c, 'ec2:DescribeRouteTables', T);
      return { RouteTables: applyFilters('rtb', inRegion(aws.routeTables), many(x, 'filters')).filter((r) => !many(x, 'route-table-ids').length || many(x, 'route-table-ids').includes(r.id)).map((r) => shapes.routeTable(aws, r)) };
    case 'create-route-table':
      return { RouteTable: shapes.routeTable(aws, api.createRouteTable(c, need(x, 'vpc-id'), tagsFrom(many(x, 'tag-specifications'), 'route-table'))) };
    case 'create-route':
      api.createRoute(c, need(x, 'route-table-id'), need(x, 'destination-cidr-block'), one(x, 'gateway-id') ?? need(x, 'nat-gateway-id'));
      return { Return: true };
    case 'associate-route-table':
      return { AssociationId: api.associateRouteTable(c, need(x, 'route-table-id'), need(x, 'subnet-id')), AssociationState: { State: 'associated' } };
    case 'describe-security-groups': {
      api.authorize(c, 'ec2:DescribeSecurityGroups', T);
      const ids = many(x, 'group-ids');
      for (const id of ids) api.sgOf(c, id, T);
      const names = many(x, 'group-names');
      return { SecurityGroups: applyFilters('sg', inRegion(aws.securityGroups), many(x, 'filters')).filter((g) => (!ids.length || ids.includes(g.id)) && (!names.length || names.includes(g.name))).map(shapes.sg) };
    }
    case 'create-security-group': {
      dry(x, 'ec2:CreateSecurityGroup');
      const g = api.createSecurityGroup(c, need(x, 'group-name'), need(x, 'description'), one(x, 'vpc-id'), tagsFrom(many(x, 'tag-specifications'), 'security-group'));
      return { GroupId: g.id };
    }
    case 'delete-security-group':
      api.deleteSecurityGroup(c, one(x, 'group-id') ?? need(x, 'group-name'));
      return undefined;
    case 'authorize-security-group-ingress':
    case 'authorize-security-group-egress': {
      const id = one(x, 'group-id') ?? need(x, 'group-name');
      api.authorizeIngress(c, id, ruleFrom(x), x.op.endsWith('egress'));
      const g = api.sgOf(c, id, T);
      const r = ruleFrom(x);
      return { Return: true, SecurityGroupRules: r.cidrs.map((cidr) => ({ SecurityGroupRuleId: 'sgr-0' + api.newId(aws, 'x').slice(3), GroupId: g.id, GroupOwnerId: api.ACCOUNT, IsEgress: x.op.endsWith('egress'), IpProtocol: r.protocol, FromPort: r.from, ToPort: r.to, CidrIpv4: cidr })) };
    }
    case 'revoke-security-group-ingress':
    case 'revoke-security-group-egress':
      api.revokeIngress(c, one(x, 'group-id') ?? need(x, 'group-name'), ruleFrom(x), x.op.endsWith('egress'));
      return { Return: true };
    case 'describe-key-pairs': {
      api.authorize(c, 'ec2:DescribeKeyPairs', T);
      const names = many(x, 'key-names');
      for (const n of names) if (!inRegion(aws.keyPairs).some((k) => k.name === n)) throw new AwsError('InvalidKeyPair.NotFound', `The key pair '${n}' does not exist`, T);
      return { KeyPairs: applyFilters('keypair', inRegion(aws.keyPairs), many(x, 'filters')).filter((k) => !names.length || names.includes(k.name)).map(shapes.keyPair) };
    }
    case 'create-key-pair': {
      const k = api.createKeyPair(c, need(x, 'key-name'));
      return { KeyFingerprint: k.fingerprint, KeyMaterial: k.material, KeyName: k.name, KeyPairId: k.id };
    }
    case 'delete-key-pair':
      api.deleteKeyPair(c, need(x, 'key-name'));
      return { Return: true };
    case 'describe-volumes': {
      api.authorize(c, 'ec2:DescribeVolumes', T);
      const ids = many(x, 'volume-ids');
      return { Volumes: applyFilters('volume', inRegion(aws.volumes), many(x, 'filters')).filter((v) => !ids.length || ids.includes(v.id)).map(shapes.volume) };
    }
    case 'create-volume':
      return shapes.volume(api.createVolume(c, Number(need(x, 'size')), need(x, 'availability-zone'), one(x, 'volume-type'), tagsFrom(many(x, 'tag-specifications'), 'volume')));
    case 'delete-volume':
      dry(x, 'ec2:DeleteVolume');
      api.deleteVolume(c, need(x, 'volume-id'));
      return undefined;
    case 'describe-addresses':
      api.authorize(c, 'ec2:DescribeAddresses', T);
      return { Addresses: applyFilters('address', inRegion(aws.addresses), many(x, 'filters')).filter((a) => !many(x, 'allocation-ids').length || many(x, 'allocation-ids').includes(a.allocationId)).map(shapes.address) };
    case 'allocate-address': {
      const a = api.allocateAddress(c, tagsFrom(many(x, 'tag-specifications'), 'elastic-ip'));
      return { PublicIp: a.publicIp, AllocationId: a.allocationId, PublicIpv4Pool: 'amazon', NetworkBorderGroup: c.region, Domain: 'vpc' };
    }
    case 'associate-address':
      return { AssociationId: api.associateAddress(c, need(x, 'allocation-id'), need(x, 'instance-id')) };
    case 'release-address':
      api.releaseAddress(c, need(x, 'allocation-id'));
      return undefined;
    case 'describe-images': {
      api.authorize(c, 'ec2:DescribeImages', T);
      const ids = many(x, 'image-ids');
      for (const id of ids) if (!api.AMIS[id]) throw new AwsError('InvalidAMIID.NotFound', `The image id '[${id}]' does not exist`, T);
      const list = applyFilters('image', Object.keys(api.AMIS), many(x, 'filters')).filter((id) => !ids.length || ids.includes(id));
      return { Images: list.map(shapes.image) };
    }
    case 'create-tags':
    case 'delete-tags': {
      api.authorize(c, `ec2:${T}`, T);
      const tags = tagsFrom(many(x, 'tags').map((t) => (t.startsWith('Key=') ? `{${t}}` : t)), '');
      for (const id of many(x, 'resources')) {
        const all = [...aws.instances, ...aws.vpcs, ...aws.subnets, ...aws.securityGroups, ...aws.volumes, ...aws.igws, ...aws.routeTables] as { id: string; tags: Tags }[];
        const r = all.find((o) => o.id === id) ?? aws.addresses.find((a) => a.allocationId === id);
        if (!r) throw new AwsError('InvalidID', `The ID '${id}' is not valid`, T);
        for (const [k, v] of Object.entries(tags)) {
          if (x.op === 'create-tags') r.tags[k] = v;
          else delete r.tags[k];
        }
      }
      return undefined;
    }
    case 'describe-regions':
      api.authorize(c, 'ec2:DescribeRegions', T);
      return { Regions: api.REGIONS.map((r) => ({ Endpoint: `ec2.${r}.amazonaws.com`, RegionName: r, OptInStatus: 'opt-in-not-required' })) };
    case 'describe-availability-zones':
      api.authorize(c, 'ec2:DescribeAvailabilityZones', T);
      return { AvailabilityZones: ['a', 'b', 'c'].map((z, i) => ({ State: 'available', RegionName: c.region, ZoneName: c.region + z, ZoneId: `use1-az${i + 1}`, ZoneType: 'availability-zone' })) };
    case 'wait': {
      return undefined;
    }
  }
  throw unsupported('ec2', x.op);
};


function unsupported(svc: string, op: string): CliError {
  return new CliError(`\naws: [ERROR]: argument operation: Found invalid choice '${op}'\n\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\n\ndevquest: 'aws ${svc} ${op}' is not simulated (or doesn't exist). Try 'aws ${svc} help'.\n`, 252);
}

function s3api(x: Ctx): unknown {
  const { c } = x;
  const T = opTitle(x.op);
  const bucket = () => need(x, 'bucket');
  switch (x.op) {
    case 'list-buckets':
      api.authorize(c, 's3:ListAllMyBuckets', T);
      return { Buckets: Object.values(c.aws.buckets).map((b) => ({ Name: b.name, CreationDate: iso(b.created) })), Owner: { DisplayName: 'student', ID: 'a1b2c3d4e5f6' } };
    case 'create-bucket': {
      const cfg = one(x, 'create-bucket-configuration');
      const loc = cfg ? String(shorthand(cfg).LocationConstraint ?? '') : '';
      if (c.region === 'us-east-1' && loc === 'us-east-1') throw new AwsError('InvalidLocationConstraint', 'The specified location-constraint is not valid', T);
      if (c.region !== 'us-east-1' && !loc) throw new AwsError('IllegalLocationConstraintException', 'The unspecified location constraint is incompatible for the region specific endpoint this request was sent to.', T);
      api.createBucket(c, bucket(), loc || c.region);
      return { Location: c.region === 'us-east-1' ? `/${bucket()}` : `http://${bucket()}.s3.amazonaws.com/` };
    }
    case 'delete-bucket':
      api.deleteBucket(c, bucket());
      return undefined;
    case 'head-bucket':
      api.bucketOf(c, bucket(), T);
      return { BucketRegion: c.aws.buckets[bucket()].region, AccessPointAlias: false };
    case 'put-bucket-versioning': {
      api.authorize(c, 's3:PutBucketVersioning', T);
      const b = api.bucketOf(c, bucket(), T);
      const st = String(shorthand(need(x, 'versioning-configuration')).Status);
      if (st !== 'Enabled' && st !== 'Suspended') throw new AwsError('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema', T);
      b.versioning = st;
      return undefined;
    }
    case 'get-bucket-versioning': {
      api.authorize(c, 's3:GetBucketVersioning', T);
      const b = api.bucketOf(c, bucket(), T);
      return b.versioning ? { Status: b.versioning } : undefined;
    }
    case 'put-public-access-block': {
      api.authorize(c, 's3:PutBucketPublicAccessBlock', T);
      const b = api.bucketOf(c, bucket(), T);
      const conf = shorthand(need(x, 'public-access-block-configuration'));
      b.blockPublic = ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].some((k) => String(conf[k]) === 'true');
      return undefined;
    }
    case 'delete-public-access-block':
      api.authorize(c, 's3:PutBucketPublicAccessBlock', T);
      api.bucketOf(c, bucket(), T).blockPublic = false;
      return undefined;
    case 'get-public-access-block': {
      api.authorize(c, 's3:GetBucketPublicAccessBlock', T);
      const b = api.bucketOf(c, bucket(), T);
      const v = b.blockPublic;
      return { PublicAccessBlockConfiguration: { BlockPublicAcls: v, IgnorePublicAcls: v, BlockPublicPolicy: v, RestrictPublicBuckets: v } };
    }
    case 'put-bucket-policy': {
      api.authorize(c, 's3:PutBucketPolicy', T);
      const b = api.bucketOf(c, bucket(), T);
      const pol = need(x, 'policy');
      api.validatePolicy(pol, b.name, T);
      if (b.blockPublic && api.publicRead({ ...b, blockPublic: false, policy: pol })) {
        throw new AwsError('AccessDenied', `User: arn:aws:iam::${api.ACCOUNT}:user/${c.user} is not authorized to perform: s3:PutBucketPolicy on resource: "arn:aws:s3:::${b.name}" because public policies are blocked by the BlockPublicPolicy block public access setting.`, T);
      }
      b.policy = pol;
      return undefined;
    }
    case 'get-bucket-policy': {
      api.authorize(c, 's3:GetBucketPolicy', T);
      const b = api.bucketOf(c, bucket(), T);
      if (!b.policy) throw new AwsError('NoSuchBucketPolicy', 'The bucket policy does not exist', T);
      return { Policy: JSON.stringify(JSON.parse(b.policy)) };
    }
    case 'delete-bucket-policy':
      api.authorize(c, 's3:DeleteBucketPolicy', T);
      delete api.bucketOf(c, bucket(), T).policy;
      return undefined;
    case 'list-objects-v2':
    case 'list-objects': {
      api.authorize(c, 's3:ListBucket', T);
      const b = api.bucketOf(c, bucket(), T);
      const prefix = one(x, 'prefix') ?? '';
      const keys = Object.keys(b.objects).filter((k) => k.startsWith(prefix)).sort();
      const contents = keys.map((k) => ({ Key: k, LastModified: iso(b.objects[k].modified), ETag: `"${b.objects[k].etag}"`, Size: b.objects[k].body.length, StorageClass: 'STANDARD' }));
      return contents.length ? { Contents: contents, RequestCharged: null, KeyCount: contents.length } : { RequestCharged: null, KeyCount: 0 };
    }
    case 'list-object-versions': {
      api.authorize(c, 's3:ListBucketVersions', T);
      const b = api.bucketOf(c, bucket(), T);
      const versions: unknown[] = [];
      for (const k of new Set([...Object.keys(b.objects), ...Object.keys(b.versions ?? {})])) {
        const cur = b.objects[k];
        if (cur) versions.push({ ETag: `"${cur.etag}"`, Size: cur.body.length, Key: k, VersionId: cur.versionId ?? 'null', IsLatest: true, LastModified: iso(cur.modified) });
        for (const o of b.versions?.[k] ?? []) versions.push({ ETag: `"${o.etag}"`, Size: o.body.length, Key: k, VersionId: o.versionId ?? 'null', IsLatest: false, LastModified: iso(o.modified) });
      }
      return { Versions: versions };
    }
    case 'head-object': {
      const o = api.getObject(c, bucket(), need(x, 'key'));
      return { AcceptRanges: 'bytes', LastModified: new Date(o.modified).toUTCString(), ContentLength: o.body.length, ContentType: o.contentType, Metadata: {} };
    }
    case 'get-object': {
      const o = api.getObject(c, bucket(), need(x, 'key'));
      const outfile = x.ctx.args[x.ctx.args.length - 1];
      x.ctx.vfs.writeFile(x.ctx.resolve(outfile), o.body);
      return { AcceptRanges: 'bytes', LastModified: new Date(o.modified).toUTCString(), ContentLength: o.body.length, ContentType: o.contentType, Metadata: {} };
    }
    case 'put-object': {
      const body = one(x, 'body');
      let text = '';
      if (body !== undefined) {
        try {
          text = x.ctx.vfs.readFile(x.ctx.resolve(body));
        } catch {
          throw new CliError(`\nError parsing parameter '--body': Blob values must be a path to a file.\n`, 252);
        }
      }
      api.putObject(c, bucket(), need(x, 'key'), text, one(x, 'content-type'));
      return { ETag: `"${c.aws.buckets[bucket()].objects[need(x, 'key')].etag}"`, ServerSideEncryption: 'AES256' };
    }
    case 'delete-object':
      api.deleteObject(c, bucket(), need(x, 'key'));
      return undefined;
    case 'get-bucket-website': {
      const b = api.bucketOf(c, bucket(), T);
      if (!b.website) throw new AwsError('NoSuchWebsiteConfiguration', 'The specified bucket does not have a website configuration', T);
      return { IndexDocument: { Suffix: b.website.index }, ...(b.website.error ? { ErrorDocument: { Key: b.website.error } } : {}) };
    }
  }
  throw unsupported('s3api', x.op);
}

/** High-level `aws s3` commands print their own lines. */
function s3(x: Ctx, pos: string[]): number {
  const { ctx, c } = x;
  const parse = (u: string) => {
    const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(u);
    return m ? { bucket: m[1], key: m[2] } : null;
  };
  const date = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const wrapErr = (prefix: string, f: () => void): boolean => {
    try {
      f();
      return true;
    } catch (e) {
      if (e instanceof AwsError) {
        ctx.err(`${prefix} An error occurred (${e.code}) when calling the ${e.op} operation: ${e.message}\n`);
        return false;
      }
      throw e;
    }
  };
  const localFiles = (dir: string): string[] => {
    const out: string[] = [];
    ctx.vfs.walk(dir, (p, n) => {
      if (n.type === 'file') out.push(p.slice(dir.length + 1));
    });
    return out.sort();
  };
  switch (x.op) {
    case 'ls': {
      const target = pos[0];
      if (!target) {
        api.authorize(c, 's3:ListAllMyBuckets', 'ListBuckets');
        for (const b of Object.values(c.aws.buckets)) ctx.out(`${date(b.created)} ${b.name}\n`);
        return 0;
      }
      const t = parse(target);
      if (!t) throw new CliError(`\nusage: aws s3 ls [<S3Uri>]\n`, 252);
      api.authorize(c, 's3:ListBucket', 'ListObjectsV2');
      const b = api.bucketOf(c, t.bucket, 'ListObjectsV2');
      const keys = Object.keys(b.objects).filter((k) => k.startsWith(t.key)).sort();
      if (x.args.recursive) {
        for (const k of keys) ctx.out(`${date(b.objects[k].modified)} ${String(b.objects[k].body.length).padStart(10)} ${k}\n`);
        return keys.length ? 0 : 1;
      }
      const prefixLen = t.key && !t.key.endsWith('/') && !keys.includes(t.key) ? t.key.lastIndexOf('/') + 1 : t.key.length;
      const dirs = new Set<string>();
      for (const k of keys) {
        const rest = k.slice(prefixLen);
        if (rest.includes('/')) dirs.add(rest.slice(0, rest.indexOf('/') + 1));
      }
      for (const d of [...dirs].sort()) ctx.out(`${' '.repeat(27)}PRE ${d}\n`);
      for (const k of keys) {
        const rest = k.slice(prefixLen);
        if (!rest.includes('/')) ctx.out(`${date(b.objects[k].modified)} ${String(b.objects[k].body.length).padStart(10)} ${rest}\n`);
      }
      return keys.length ? 0 : 1;
    }
    case 'mb': {
      const t = parse(pos[0] ?? '');
      if (!t) throw new CliError('\n<S3Uri> must start with s3://\n', 252);
      return wrapErr(`make_bucket failed: s3://${t.bucket}`, () => {
        api.createBucket(c, t.bucket);
        ctx.out(`make_bucket: ${t.bucket}\n`);
      }) ? 0 : 1;
    }
    case 'rb': {
      const t = parse(pos[0] ?? '');
      if (!t) throw new CliError('\n<S3Uri> must start with s3://\n', 252);
      if (x.args.force && c.aws.buckets[t.bucket]) {
        for (const k of Object.keys(c.aws.buckets[t.bucket].objects).sort()) {
          api.deleteObject(c, t.bucket, k);
          ctx.out(`delete: s3://${t.bucket}/${k}\n`);
        }
        delete c.aws.buckets[t.bucket].versions;
      }
      return wrapErr(`remove_bucket failed: s3://${t.bucket}`, () => {
        api.deleteBucket(c, t.bucket);
        ctx.out(`remove_bucket: ${t.bucket}\n`);
      }) ? 0 : 1;
    }
    case 'cp':
    case 'mv':
    case 'sync': {
      const [src, dst] = pos;
      if (!src || !dst) throw new CliError(`\nusage: aws s3 ${x.op} <LocalPath> <S3Uri> or <S3Uri> <LocalPath> or <S3Uri> <S3Uri>\n`, 252);
      const s = parse(src);
      const d = parse(dst);
      let code = 0;
      const up = (local: string, bucket: string, key: string, shown: string) => {
        const body = ctx.vfs.readFile(local);
        const existing = c.aws.buckets[bucket]?.objects[key];
        if (x.op === 'sync' && existing?.body === body) return;
        if (!wrapErr(`upload failed: ${shown} to s3://${bucket}/${key}`, () => api.putObject(c, bucket, key, body))) {
          code = 1;
          return;
        }
        ctx.out(`upload: ${shown} to s3://${bucket}/${key}\n`);
        if (x.op === 'mv') ctx.vfs.remove(local);
      };
      if (!s && d) {
        const local = ctx.resolve(src);
        if (!ctx.vfs.exists(local)) throw new CliError(`\nThe user-provided path ${src} does not exist.\n`, 255);
        if (ctx.vfs.isDir(local)) {
          if (x.op !== 'sync' && !x.args.recursive) throw new CliError(`\nupload failed: ${src} to ${dst} [Errno 21] Is a directory: '${local}'\n`, 1);
          const files = localFiles(local);
          const prefix = d.key && !d.key.endsWith('/') ? d.key + '/' : d.key;
          for (const f of files) up(joinPath(local, f), d.bucket, prefix + f, `${src.replace(/\/$/, '')}/${f}`);
          if (x.op === 'sync' && x.args.delete) {
            const b = c.aws.buckets[d.bucket];
            for (const k of Object.keys(b?.objects ?? {}).filter((k) => k.startsWith(prefix) && !files.includes(k.slice(prefix.length)))) {
              api.deleteObject(c, d.bucket, k);
              ctx.out(`delete: s3://${d.bucket}/${k}\n`);
            }
          }
        } else {
          const key = !d.key || d.key.endsWith('/') ? d.key + local.split('/').pop() : d.key;
          up(local, d.bucket, key, src.startsWith('/') || src.startsWith('.') ? src : `./${src}`);
        }
        return code;
      }
      if (s && !d) {
        api.authorize(c, 's3:GetObject', 'GetObject');
        const b = api.bucketOf(c, s.bucket, 'ListObjectsV2');
        const keys = x.args.recursive || x.op === 'sync' ? Object.keys(b.objects).filter((k) => k.startsWith(s.key)) : [s.key];
        for (const k of keys) {
          const o = b.objects[k];
          if (!o) {
            ctx.err(`fatal error: An error occurred (404) when calling the HeadObject operation: Key "${k}" does not exist\n`);
            return 1;
          }
          const rel = keys.length > 1 || x.args.recursive ? k.slice(s.key.length).replace(/^\//, '') : k.split('/').pop()!;
          let target = ctx.resolve(dst);
          if (keys.length > 1 || x.args.recursive || x.op === 'sync') target = joinPath(target, rel);
          else if (ctx.vfs.isDir(target) || dst.endsWith('/')) target = joinPath(target, rel);
          ctx.vfs.mkdir(target.replace(/\/[^/]+$/, '') || '/', { parents: true });
          ctx.vfs.writeFile(target, o.body);
          ctx.out(`download: s3://${s.bucket}/${k} to ${dst.replace(/\/$/, '')}${keys.length > 1 || x.args.recursive ? '/' + rel : ctx.vfs.isDir(ctx.resolve(dst)) ? '/' + rel : ''}\n`);
          if (x.op === 'mv') api.deleteObject(c, s.bucket, k);
        }
        return 0;
      }
      if (s && d) {
        const o = api.getObject(c, s.bucket, s.key);
        const key = !d.key || d.key.endsWith('/') ? d.key + s.key.split('/').pop() : d.key;
        api.putObject(c, d.bucket, key, o.body);
        ctx.out(`copy: s3://${s.bucket}/${s.key} to s3://${d.bucket}/${key}\n`);
        return 0;
      }
      throw new CliError('\nError: Invalid argument type\n', 252);
    }
    case 'rm': {
      const t = parse(pos[0] ?? '');
      if (!t) throw new CliError('\n<S3Uri> must start with s3://\n', 252);
      const b = api.bucketOf(c, t.bucket, 'ListObjectsV2');
      const keys = x.args.recursive ? Object.keys(b.objects).filter((k) => k.startsWith(t.key)).sort() : [t.key];
      for (const k of keys) {
        api.deleteObject(c, t.bucket, k);
        ctx.out(`delete: s3://${t.bucket}/${k}\n`);
      }
      return 0;
    }
    case 'website': {
      const t = parse(pos[0] ?? '');
      if (!t) throw new CliError('\n<S3Uri> must start with s3://\n', 252);
      api.authorize(c, 's3:PutBucketWebsite', 'PutBucketWebsite');
      const b = api.bucketOf(c, t.bucket, 'PutBucketWebsite');
      b.website = { index: one(x, 'index-document') ?? 'index.html', error: one(x, 'error-document') };
      return 0;
    }
  }
  throw unsupported('s3', x.op);
}

function sts(x: Ctx): unknown {
  if (x.op !== 'get-caller-identity') throw unsupported('sts', x.op);
  const u = x.c.aws.users[x.c.user];
  return { UserId: u.id, Account: api.ACCOUNT, Arn: u.arn };
}

function iam(x: Ctx): unknown {
  const { c } = x;
  const T = opTitle(x.op);
  const userOf = (name: string) => {
    const u = c.aws.users[name];
    if (!u) throw new AwsError('NoSuchEntity', `The user with name ${name} cannot be found.`, T);
    return u;
  };
  const shape = (u: AwsState['users'][string]) => ({ Path: '/', UserName: u.name, UserId: u.id, Arn: u.arn, CreateDate: iso(u.created) });
  switch (x.op) {
    case 'list-users':
      api.authorize(c, 'iam:ListUsers', T);
      return { Users: Object.values(c.aws.users).map(shape) };
    case 'get-user':
      api.authorize(c, 'iam:GetUser', T);
      return { User: shape(userOf(one(x, 'user-name') ?? c.user)) };
    case 'list-attached-user-policies':
      api.authorize(c, 'iam:ListAttachedUserPolicies', T);
      return { AttachedPolicies: userOf(need(x, 'user-name')).policies.map((p) => ({ PolicyName: p, PolicyArn: `arn:aws:iam::aws:policy/${p}` })) };
  }
  throw unsupported('iam', x.op);
}

// ------------------------------------------------------------------ configure

function configure(ctx: CommandContext, pos: string[], g: Globals): number {
  const home = ctx.state.vars.HOME ?? '/';
  const credPath = `${home}/.aws/credentials`;
  const confPath = `${home}/.aws/config`;
  const profile = g.profile ?? ctx.env.AWS_PROFILE ?? 'default';
  const creds = readIni(ctx, credPath);
  const conf = readIni(ctx, confPath);
  const set = (k: string, v: string) => {
    if (k === 'aws_access_key_id' || k === 'aws_secret_access_key') {
      (creds[profile] ??= {})[k] = v;
      writeIni(ctx, credPath, creds, false);
    } else {
      (conf[profile] ??= {})[k] = v;
      writeIni(ctx, confPath, conf, true);
    }
  };
  const sub = pos[0];
  if (sub === 'set') {
    const [, key, val] = pos;
    if (!key || val === undefined) throw new CliError('\nusage: aws configure set varname value [--profile profile-name]\n', 252);
    set(key.replace(/^default\./, ''), val);
    return 0;
  }
  if (sub === 'get') {
    const k = pos[1];
    const v = creds[profile]?.[k] ?? conf[profile]?.[k];
    if (v === undefined) return 1;
    ctx.out(v + '\n');
    return 0;
  }
  if (sub === 'list') {
    const r = resolveConfig(ctx, g);
    const mask = (s?: string) => (s ? '*'.repeat(16) + s.slice(-4) : '<not set>');
    const row = (n: string, v: string, t: string, l: string) => `${n.padStart(10)} ${v.padStart(24)} ${t.padStart(16)}    ${l}\n`;
    ctx.out(row('Name', 'Value', 'Type', 'Location') + row('----', '-----', '----', '--------'));
    ctx.out(row('profile', profile === 'default' ? '<not set>' : profile, profile === 'default' ? 'None' : 'manual', profile === 'default' ? 'None' : '--profile'));
    const src = r.source === 'env' ? 'env' : r.source || 'None';
    ctx.out(row('access_key', mask(r.keyId), r.keyId ? src : 'None', r.keyId ? (r.source === 'env' ? '' : '~/.aws/credentials') : 'None'));
    ctx.out(row('secret_key', mask(r.secret), r.secret ? src : 'None', r.secret ? (r.source === 'env' ? '' : '~/.aws/credentials') : 'None'));
    ctx.out(row('region', r.region ?? '<not set>', r.region ? 'config-file' : 'None', r.region ? '~/.aws/config' : 'None'));
    return 0;
  }
  if (sub) throw new CliError(`\naws: [ERROR]: argument subcommand: Found invalid choice '${sub}'\n`, 252);
  // Interactive: answers come from stdin (one per line).
  const answers = ctx.stdin.split('\n');
  const prompts: [string, string][] = [['AWS Access Key ID', 'aws_access_key_id'], ['AWS Secret Access Key', 'aws_secret_access_key'], ['Default region name', 'region'], ['Default output format', 'output']];
  if (!ctx.stdin) {
    ctx.err('devquest: `aws configure` asks four questions; answer them with `aws configure set <name> <value>` (aws_access_key_id, aws_secret_access_key, region, output), or pipe the answers in.\n');
    return 1;
  }
  prompts.forEach(([label, key], i) => {
    const cur = creds[profile]?.[key] ?? conf[profile]?.[key];
    const shown = cur ? (key.includes('key') ? '****************' + cur.slice(-4) : cur) : 'None';
    const ans = (answers[i] ?? '').trim();
    ctx.out(`${label} [${shown}]: ${ans}\n`);
    if (ans) set(key, ans);
  });
  return 0;
}

// ------------------------------------------------------------------ entry

const SERVICES = new Set(['s3', 's3api', 'ec2', 'sts', 'iam', 'configure']);
const NEEDS_REGION = new Set(['ec2']);

export function callerFor(ctx: CommandContext, g: Globals, svc: string, opName: string): Caller {
  const st = ctx.state;
  if (!st.aws) throw new CliError(`\nCould not connect to the endpoint URL: "https://${svc}.amazonaws.com/"\n`, 255);
  const r = resolveConfig(ctx, g);
  if (!r.keyId || !r.secret) throw new CliError('\nUnable to locate credentials. You can configure credentials by running "aws configure".\n', 253);
  const region = r.region ?? (NEEDS_REGION.has(svc) ? undefined : 'us-east-1');
  if (!region) throw new CliError('\nYou must specify a region. You can also configure your region by running "aws configure".\n', 253);
  if (!api.REGIONS.includes(region)) throw new CliError(`\nCould not connect to the endpoint URL: "https://${svc === 's3api' ? 's3' : svc}.${region}.amazonaws.com/"\n`, 255);
  const key = st.aws.keys[r.keyId];
  if (!key) {
    if (svc === 'ec2') throw new AwsError('AuthFailure', 'AWS was not able to validate the provided access credentials', opName);
    if (svc.startsWith('s3')) throw new AwsError('InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.', opName);
    throw new AwsError('InvalidClientTokenId', 'The security token included in the request is invalid.', opName);
  }
  if (key.secret !== r.secret) {
    throw new AwsError('SignatureDoesNotMatch', svc === 'ec2' || svc === 'sts' || svc === 'iam' ? 'The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method. Consult the service documentation for details.' : 'The request signature we calculated does not match the signature you provided. Check your key and signing method.', opName);
  }
  return { aws: st.aws, user: key.user, region, state: st };
}

const S3_OPS: Record<string, string> = { ls: 'ListObjectsV2', mb: 'CreateBucket', rb: 'DeleteBucket', cp: 'PutObject', mv: 'PutObject', sync: 'ListObjectsV2', rm: 'DeleteObject', website: 'PutBucketWebsite' };

export const awsCommand: CommandDef = {
  name: 'aws',
  summary: 'the AWS command line interface (mock AWS account: sts, s3, s3api, ec2, iam)',
  run(ctx) {
    let parsed;
    try {
      parsed = parseArgs(ctx.args);
    } catch (e) {
      if (e instanceof CliError) {
        ctx.err(e.message);
        return e.code;
      }
      throw e;
    }
    const { pos, args, g } = parsed;
    const [svc, op, ...rest] = pos;
    if (svc === '--version' || ctx.args[0] === '--version') {
      ctx.out('aws-cli/2.17.40 Python/3.11.9 Linux/6.8.0 exe/x86_64.ubuntu.24\n');
      return 0;
    }
    if (!svc) {
      ctx.err('\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\nTo see help text, you can run:\n\n  aws help\n  aws <command> help\n  aws <command> <subcommand> help\n\naws: error: the following arguments are required: command\n');
      return 252;
    }
    if (!SERVICES.has(svc)) {
      ctx.err(`\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\n\naws: error: argument command: Invalid choice, valid choices are:\n\n${[...SERVICES].join(' | ')}\n\n(devquest simulates these services)\n`);
      return 252;
    }
    try {
      if (svc === 'configure') return configure(ctx, [op, ...rest].filter(Boolean) as string[], g);
      if (!op) throw new CliError(`\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\n\naws: error: the following arguments are required: operation\n`, 252);
      if (op === 'help') {
        ctx.out(`devquest: try \`aws ${svc} <operation>\`; see the lesson for the supported operations.\n`);
        return 0;
      }
      const opName = svc === 's3' ? S3_OPS[op] ?? opTitle(op) : opTitle(op);
      const c = callerFor(ctx, g, svc, opName);
      const x: Ctx = { ctx, c, args, g, op };
      if (svc === 's3') return s3(x, rest);
      if (svc === 'ec2' && op === 'wait') {
        api.settle(c);
        return 0;
      }
      const result = svc === 'ec2' ? ec2(x) : svc === 's3api' ? s3api(x) : svc === 'sts' ? sts(x) : iam(x);
      if (result === undefined) return 0;
      let v: unknown = result;
      if (g.query) v = jmes(g.query, v);
      const fmt = g.output ?? readIni(ctx, `${ctx.state.vars.HOME}/.aws/config`)[g.profile ?? 'default']?.output ?? 'json';
      if (fmt === 'text') ctx.out(textOut(v) + '\n');
      else if (fmt === 'table') ctx.out(tableOut(opTitle(op), v) + '\n');
      else if (fmt === 'json' || fmt === 'yaml') ctx.out(JSON.stringify(v, null, 4) + '\n');
      else throw new CliError(`\naws: error: argument --output: Invalid choice, valid choices are:\n\njson                                     | text\ntable                                    | yaml\nyaml-stream\n`, 252);
      return 0;
    } catch (e) {
      if (e instanceof CliError) {
        ctx.err(e.message);
        return e.code;
      }
      if (e instanceof AwsError) {
        ctx.err(`\nAn error occurred (${e.code}) when calling the ${e.op || opTitle(op ?? '')} operation: ${e.message}\n`);
        return e.exit;
      }
      if (e instanceof JmesError) {
        ctx.err(`\n${e.message}\n`);
        return 255;
      }
      if (e instanceof SyntaxError) {
        ctx.err(`\nError parsing parameter: Invalid JSON: ${e.message}\n`);
        return 252;
      }
      throw e;
    }
  },
};

export type { SimState };
