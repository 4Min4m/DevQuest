/** Terraform providers: schemas and CRUD for each resource type, on top of the simulated world. */
import type { CommandContext } from '../shell/types';
import type { SimState } from '../state';
import * as api from '../aws/api';
import { AwsError, Caller } from '../aws/api';
import { callerFor, CliError } from '../aws/cli';
import { Vfs } from '../vfs/vfs';

export type Attrs = Record<string, unknown>;

export interface AttrSchema {
  type: 'string' | 'number' | 'bool' | 'list' | 'set' | 'map' | 'any';
  required?: boolean;
  optional?: boolean;
  computed?: boolean;
  forceNew?: boolean;
  sensitive?: boolean;
  default?: unknown;
  /** Nested block (repeated); its attributes. */
  block?: Record<string, AttrSchema>;
  maxItems?: number;
}

export interface ProviderCtx {
  state: SimState;
  cmd: CommandContext;
  /** Provider configuration (region, default_tags...). */
  config: Attrs;
  /** Directory of the module (local_file paths). */
  dir: string;
  /** Deterministic randomness per resource address. */
  seed: number;
  aws(): Caller;
}

export interface ResourceType {
  /** Name used in error messages, e.g. "S3 Bucket". */
  label: string;
  schema: Record<string, AttrSchema>;
  create(p: ProviderCtx, cfg: Attrs): Attrs;
  /** Current attributes, or null when the object no longer exists. */
  read(p: ProviderCtx, prior: Attrs): Attrs | null;
  update?(p: ProviderCtx, prior: Attrs, cfg: Attrs): Attrs;
  delete(p: ProviderCtx, prior: Attrs): void;
  importer?(p: ProviderCtx, id: string): Attrs | null;
  /** Computed values that can be known at plan time. */
  plan?(p: ProviderCtx, cfg: Attrs): Attrs;
  /** Seconds the create takes (progress lines). */
  createSeconds?: number;
}

export interface DataType {
  schema: Record<string, AttrSchema>;
  read(p: ProviderCtx, cfg: Attrs): Attrs;
}

export class ProviderError extends Error {
  constructor(public summary: string, public detail = '') {
    super(summary);
  }
}

const STATUS: Record<string, number> = { NoSuchBucket: 404, BucketAlreadyExists: 409, BucketAlreadyOwnedByYou: 409, BucketNotEmpty: 409, AccessDenied: 403, UnauthorizedOperation: 403 };

/** Wrap an AWS API error the way the AWS provider (SDK v2) reports it. */
function awsCall<T>(what: string, service: string, op: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof AwsError) {
      const status = STATUS[e.code] ?? (e.code.includes('NotFound') ? 400 : 400);
      throw new ProviderError(`${what}: operation error ${service}: ${e.op || op}, https response error StatusCode: ${status}, RequestID: 2b4f6a8c-1d3e-4f5a-9b7c-0e1d2c3b4a59, api error ${e.code}: ${e.message}`);
    }
    throw e;
  }
}

const tagsOf = (p: ProviderCtx, cfg: Attrs) => ({ ...((p.config.default_tags as Attrs[] | undefined)?.[0]?.tags as Record<string, string> | undefined), ...((cfg.tags as Record<string, string>) ?? {}) });
const TAGS: Record<string, AttrSchema> = { tags: { type: 'map', optional: true }, tags_all: { type: 'map', computed: true } };

const b = (v: unknown, d = false) => (v === undefined || v === null ? d : v === true || v === 'true');
const block = (cfg: Attrs, name: string): Attrs | undefined => (cfg[name] as Attrs[] | undefined)?.[0];

// ------------------------------------------------------------------ AWS

const s3Bucket: ResourceType = {
  label: 'S3 Bucket',
  schema: {
    bucket: { type: 'string', optional: true, computed: true, forceNew: true },
    bucket_prefix: { type: 'string', optional: true, forceNew: true },
    force_destroy: { type: 'bool', optional: true, default: false },
    id: { type: 'string', computed: true },
    arn: { type: 'string', computed: true },
    region: { type: 'string', computed: true },
    bucket_domain_name: { type: 'string', computed: true },
    bucket_regional_domain_name: { type: 'string', computed: true },
    hosted_zone_id: { type: 'string', computed: true },
    ...TAGS,
  },
  plan: (p, cfg) => (cfg.bucket ? { id: cfg.bucket, arn: `arn:aws:s3:::${cfg.bucket}`, bucket_domain_name: `${cfg.bucket}.s3.amazonaws.com`, region: p.aws().region } : {}),
  create(p, cfg) {
    const c = p.aws();
    const name = (cfg.bucket as string) ?? `${(cfg.bucket_prefix as string) ?? 'terraform-'}${String(20261106090000 + p.seed).padEnd(26, '0')}`;
    awsCall(`creating S3 Bucket (${name})`, 'S3', 'CreateBucket', () => api.createBucket(c, name));
    c.aws.buckets[name].tags = tagsOf(p, cfg);
    return this.read(p, { bucket: name, force_destroy: cfg.force_destroy ?? false, tags: cfg.tags ?? null })!;
  },
  read(p, prior) {
    const c = p.aws();
    const bk = c.aws.buckets[prior.bucket as string];
    if (!bk) return null;
    const tags = bk.tags ?? {};
    return {
      bucket: bk.name,
      bucket_prefix: prior.bucket_prefix ?? null,
      force_destroy: prior.force_destroy ?? false,
      id: bk.name,
      arn: `arn:aws:s3:::${bk.name}`,
      region: bk.region,
      bucket_domain_name: `${bk.name}.s3.amazonaws.com`,
      bucket_regional_domain_name: `${bk.name}.s3.${bk.region}.amazonaws.com`,
      hosted_zone_id: 'Z3AQBSTGFYJSTF',
      tags: prior.tags === undefined ? (Object.keys(tags).length ? tags : null) : diffTags(prior.tags as Record<string, string> | null, tags, p),
      tags_all: tags,
    };
  },
  update(p, prior, cfg) {
    const c = p.aws();
    c.aws.buckets[prior.bucket as string].tags = tagsOf(p, cfg);
    return { ...this.read(p, prior)!, force_destroy: cfg.force_destroy ?? false, tags: cfg.tags ?? null };
  },
  delete(p, prior) {
    const c = p.aws();
    const bk = c.aws.buckets[prior.bucket as string];
    if (bk && prior.force_destroy) {
      bk.objects = {};
      bk.versions = {};
    }
    awsCall(`deleting S3 Bucket (${prior.bucket})`, 'S3', 'DeleteBucket', () => api.deleteBucket(c, prior.bucket as string));
  },
  importer(p, id) {
    return this.read(p, { bucket: id, force_destroy: false });
  },
};

/** Tags as Terraform sees them after refresh: what's on the object minus provider default_tags. */
function diffTags(_prior: Record<string, string> | null, real: Record<string, string>, p: ProviderCtx): Record<string, string> | null {
  const defaults = ((p.config.default_tags as Attrs[] | undefined)?.[0]?.tags as Record<string, string>) ?? {};
  const own = Object.fromEntries(Object.entries(real).filter(([k, v]) => defaults[k] !== v));
  return Object.keys(own).length ? own : null;
}

function bucketSub(label: string, schema: Record<string, AttrSchema>, apply: (p: ProviderCtx, bk: ReturnType<Caller['aws']['buckets']['x']['valueOf']> & import('../aws/types').Bucket, cfg: Attrs | null) => void, readBack: (bk: import('../aws/types').Bucket) => Attrs | null): ResourceType {
  return {
    label,
    schema: { bucket: { type: 'string', required: true, forceNew: true }, id: { type: 'string', computed: true }, ...schema },
    create(p, cfg) {
      const c = p.aws();
      const bk = awsCall(`creating ${label} (${cfg.bucket})`, 'S3', 'Put' + label.replace(/[^A-Za-z]/g, ''), () => api.bucketOf(c, cfg.bucket as string, 'PutBucket'));
      awsCall(`creating ${label} (${cfg.bucket})`, 'S3', 'Put' + label.replace(/[^A-Za-z]/g, ''), () => apply(p, bk as never, cfg));
      return this.read(p, { bucket: cfg.bucket })!;
    },
    read(p, prior) {
      const bk = p.aws().aws.buckets[prior.bucket as string];
      if (!bk) return null;
      const r = readBack(bk);
      return r ? { bucket: bk.name, id: bk.name, ...r } : null;
    },
    update(p, _prior, cfg) {
      return this.create(p, cfg);
    },
    delete(p, prior) {
      const bk = p.aws().aws.buckets[prior.bucket as string];
      if (bk) apply(p, bk as never, null);
    },
    importer(p, id) {
      return this.read(p, { bucket: id });
    },
  };
}

const s3Versioning = bucketSub(
  'S3 Bucket Versioning',
  { versioning_configuration: { type: 'list', block: { status: { type: 'string', required: true } }, maxItems: 1, required: true } },
  (_p, bk, cfg) => {
    if (!cfg) {
      if (bk.versioning) bk.versioning = 'Suspended';
      return;
    }
    const st = String(block(cfg, 'versioning_configuration')?.status);
    if (!['Enabled', 'Suspended', 'Disabled'].includes(st)) throw new AwsError('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema', 'PutBucketVersioning');
    bk.versioning = st === 'Disabled' ? undefined : (st as 'Enabled' | 'Suspended');
  },
  (bk) => (bk.versioning ? { versioning_configuration: [{ status: bk.versioning }] } : null),
);

const s3PublicAccess = bucketSub(
  'S3 Bucket Public Access Block',
  {
    block_public_acls: { type: 'bool', optional: true, default: false },
    block_public_policy: { type: 'bool', optional: true, default: false },
    ignore_public_acls: { type: 'bool', optional: true, default: false },
    restrict_public_buckets: { type: 'bool', optional: true, default: false },
  },
  (_p, bk, cfg) => {
    bk.blockPublic = cfg ? ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets'].some((k) => b(cfg[k])) : false;
  },
  (bk) => ({ block_public_acls: bk.blockPublic, block_public_policy: bk.blockPublic, ignore_public_acls: bk.blockPublic, restrict_public_buckets: bk.blockPublic }),
);

const normJson = (s: unknown) => {
  try {
    return JSON.stringify(JSON.parse(String(s)));
  } catch {
    return String(s);
  }
};

const s3Policy = bucketSub(
  'S3 Bucket Policy',
  { policy: { type: 'string', required: true } },
  (p, bk, cfg) => {
    if (!cfg) {
      delete bk.policy;
      return;
    }
    api.validatePolicy(String(cfg.policy), bk.name, 'PutBucketPolicy');
    if (bk.blockPublic && api.publicRead({ ...bk, blockPublic: false, policy: String(cfg.policy) })) {
      throw new AwsError('AccessDenied', `User: arn:aws:iam::${api.ACCOUNT}:user/${p.aws().user} is not authorized to perform: s3:PutBucketPolicy on resource: "arn:aws:s3:::${bk.name}" because public policies are blocked by the BlockPublicPolicy block public access setting.`, 'PutBucketPolicy');
    }
    bk.policy = normJson(cfg.policy);
  },
  (bk) => (bk.policy ? { policy: bk.policy } : null),
);

const s3Website = bucketSub(
  'S3 Bucket Website Configuration',
  {
    index_document: { type: 'list', block: { suffix: { type: 'string', required: true } }, maxItems: 1, optional: true },
    error_document: { type: 'list', block: { key: { type: 'string', required: true } }, maxItems: 1, optional: true },
    website_endpoint: { type: 'string', computed: true },
    website_domain: { type: 'string', computed: true },
  },
  (_p, bk, cfg) => {
    if (!cfg) {
      delete bk.website;
      return;
    }
    bk.website = { index: String(block(cfg, 'index_document')?.suffix ?? 'index.html'), error: block(cfg, 'error_document')?.key as string | undefined };
  },
  (bk) =>
    bk.website
      ? {
          index_document: [{ suffix: bk.website.index }],
          error_document: bk.website.error ? [{ key: bk.website.error }] : [],
          website_endpoint: `${bk.name}.s3-website-${bk.region}.amazonaws.com`,
          website_domain: `s3-website-${bk.region}.amazonaws.com`,
        }
      : null,
);

function etagOf(body: string) {
  let h = 0;
  for (const ch of body) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(4);
}

const s3Object: ResourceType = {
  label: 'S3 Object',
  schema: {
    bucket: { type: 'string', required: true, forceNew: true },
    key: { type: 'string', required: true, forceNew: true },
    content: { type: 'string', optional: true },
    source: { type: 'string', optional: true },
    content_type: { type: 'string', optional: true, computed: true },
    etag: { type: 'string', optional: true, computed: true },
    id: { type: 'string', computed: true },
    ...TAGS,
  },
  plan(p, cfg) {
    const body = bodyOf(p, cfg);
    return body === null ? {} : { etag: etagOf(body), id: cfg.key };
  },
  create(p, cfg) {
    const c = p.aws();
    const body = bodyOf(p, cfg) ?? '';
    awsCall(`uploading S3 Object (${cfg.key}) to Bucket (${cfg.bucket})`, 'S3', 'PutObject', () => api.putObject(c, cfg.bucket as string, cfg.key as string, body, (cfg.content_type as string) ?? undefined));
    return { ...this.read(p, cfg)!, content: cfg.content ?? null, source: cfg.source ?? null, tags: cfg.tags ?? null };
  },
  read(p, prior) {
    const o = p.aws().aws.buckets[prior.bucket as string]?.objects[prior.key as string];
    if (!o) return null;
    return { bucket: prior.bucket, key: prior.key, content: prior.content ?? null, source: prior.source ?? null, content_type: o.contentType ?? 'binary/octet-stream', etag: etagOf(o.body), id: prior.key, tags: prior.tags ?? null, tags_all: {} };
  },
  update(p, _prior, cfg) {
    return this.create(p, cfg);
  },
  delete(p, prior) {
    awsCall(`deleting S3 Bucket (${prior.bucket}) Object (${prior.key})`, 'S3', 'DeleteObject', () => api.deleteObject(p.aws(), prior.bucket as string, prior.key as string));
  },
};

function bodyOf(p: ProviderCtx, cfg: Attrs): string | null {
  if (typeof cfg.content === 'string') return cfg.content;
  if (typeof cfg.source === 'string') {
    try {
      const path = cfg.source.startsWith('/') ? cfg.source : `${p.dir}/${cfg.source}`;
      return new Vfs(p.state.fs, { name: p.state.user, groups: [] }).readFile(path);
    } catch {
      throw new ProviderError(`opening S3 Object source (${cfg.source}): open ${cfg.source}: no such file or directory`);
    }
  }
  return null;
}

const vpc: ResourceType = {
  label: 'EC2 VPC',
  schema: {
    cidr_block: { type: 'string', required: true, forceNew: true },
    enable_dns_hostnames: { type: 'bool', optional: true, computed: true },
    enable_dns_support: { type: 'bool', optional: true, default: true },
    instance_tenancy: { type: 'string', optional: true, default: 'default' },
    id: { type: 'string', computed: true },
    arn: { type: 'string', computed: true },
    default_security_group_id: { type: 'string', computed: true },
    main_route_table_id: { type: 'string', computed: true },
    owner_id: { type: 'string', computed: true },
    ...TAGS,
  },
  createSeconds: 2,
  create(p, cfg) {
    const c = p.aws();
    const v = awsCall('creating EC2 VPC', 'EC2', 'CreateVpc', () => api.createVpc(c, cfg.cidr_block as string, tagsOf(p, cfg)));
    v.dnsHostnames = b(cfg.enable_dns_hostnames);
    return { ...this.read(p, { id: v.id })!, tags: cfg.tags ?? null };
  },
  read(p, prior) {
    const c = p.aws();
    const v = c.aws.vpcs.find((x) => x.id === prior.id);
    if (!v) return null;
    return {
      cidr_block: v.cidr,
      enable_dns_hostnames: !!v.dnsHostnames,
      enable_dns_support: true,
      instance_tenancy: 'default',
      id: v.id,
      arn: `arn:aws:ec2:${v.region}:${api.ACCOUNT}:vpc/${v.id}`,
      default_security_group_id: c.aws.securityGroups.find((g) => g.vpcId === v.id && g.name === 'default')?.id,
      main_route_table_id: c.aws.routeTables.find((r) => r.vpcId === v.id && r.main)?.id,
      owner_id: api.ACCOUNT,
      tags: diffTags(null, v.tags, p),
      tags_all: v.tags,
    };
  },
  update(p, prior, cfg) {
    const v = p.aws().aws.vpcs.find((x) => x.id === prior.id)!;
    v.tags = tagsOf(p, cfg);
    v.dnsHostnames = b(cfg.enable_dns_hostnames);
    return this.read(p, prior)!;
  },
  delete(p, prior) {
    awsCall(`deleting EC2 VPC (${prior.id})`, 'EC2', 'DeleteVpc', () => api.deleteVpc(p.aws(), prior.id as string));
  },
  importer(p, id) {
    return this.read(p, { id });
  },
};

const subnet: ResourceType = {
  label: 'EC2 Subnet',
  schema: {
    vpc_id: { type: 'string', required: true, forceNew: true },
    cidr_block: { type: 'string', required: true, forceNew: true },
    availability_zone: { type: 'string', optional: true, computed: true, forceNew: true },
    map_public_ip_on_launch: { type: 'bool', optional: true, default: false },
    id: { type: 'string', computed: true },
    arn: { type: 'string', computed: true },
    owner_id: { type: 'string', computed: true },
    ...TAGS,
  },
  create(p, cfg) {
    const c = p.aws();
    const s = awsCall('creating EC2 Subnet', 'EC2', 'CreateSubnet', () => api.createSubnet(c, cfg.vpc_id as string, cfg.cidr_block as string, (cfg.availability_zone as string) ?? undefined, tagsOf(p, cfg)));
    s.mapPublicIp = b(cfg.map_public_ip_on_launch);
    return { ...this.read(p, { id: s.id })!, tags: cfg.tags ?? null };
  },
  read(p, prior) {
    const s = p.aws().aws.subnets.find((x) => x.id === prior.id);
    if (!s) return null;
    return { vpc_id: s.vpcId, cidr_block: s.cidr, availability_zone: s.az, map_public_ip_on_launch: s.mapPublicIp, id: s.id, arn: `arn:aws:ec2:${s.region}:${api.ACCOUNT}:subnet/${s.id}`, owner_id: api.ACCOUNT, tags: diffTags(null, s.tags, p), tags_all: s.tags };
  },
  update(p, prior, cfg) {
    const s = p.aws().aws.subnets.find((x) => x.id === prior.id)!;
    s.mapPublicIp = b(cfg.map_public_ip_on_launch);
    s.tags = tagsOf(p, cfg);
    return this.read(p, prior)!;
  },
  delete(p, prior) {
    awsCall(`deleting EC2 Subnet (${prior.id})`, 'EC2', 'DeleteSubnet', () => api.deleteSubnet(p.aws(), prior.id as string));
  },
  importer(p, id) {
    return this.read(p, { id });
  },
};

const igw: ResourceType = {
  label: 'EC2 Internet Gateway',
  schema: { vpc_id: { type: 'string', optional: true }, id: { type: 'string', computed: true }, arn: { type: 'string', computed: true }, owner_id: { type: 'string', computed: true }, ...TAGS },
  create(p, cfg) {
    const c = p.aws();
    const g = awsCall('creating EC2 Internet Gateway', 'EC2', 'CreateInternetGateway', () => api.createIgw(c, tagsOf(p, cfg)));
    if (cfg.vpc_id) awsCall(`attaching EC2 Internet Gateway (${g.id}) to VPC (${cfg.vpc_id})`, 'EC2', 'AttachInternetGateway', () => api.attachIgw(c, g.id, cfg.vpc_id as string));
    return { ...this.read(p, { id: g.id })!, tags: cfg.tags ?? null };
  },
  read(p, prior) {
    const g = p.aws().aws.igws.find((x) => x.id === prior.id);
    if (!g) return null;
    return { vpc_id: g.vpcId ?? null, id: g.id, arn: `arn:aws:ec2:${g.region}:${api.ACCOUNT}:internet-gateway/${g.id}`, owner_id: api.ACCOUNT, tags: diffTags(null, g.tags, p), tags_all: g.tags };
  },
  update(p, prior, cfg) {
    const c = p.aws();
    const g = c.aws.igws.find((x) => x.id === prior.id)!;
    if (g.vpcId !== cfg.vpc_id) {
      if (g.vpcId) api.detachIgw(c, g.id, g.vpcId);
      if (cfg.vpc_id) awsCall(`attaching EC2 Internet Gateway (${g.id})`, 'EC2', 'AttachInternetGateway', () => api.attachIgw(c, g.id, cfg.vpc_id as string));
    }
    g.tags = tagsOf(p, cfg);
    return this.read(p, prior)!;
  },
  delete(p, prior) {
    const c = p.aws();
    const g = c.aws.igws.find((x) => x.id === prior.id);
    if (g?.vpcId) api.detachIgw(c, g.id, g.vpcId);
    awsCall(`deleting EC2 Internet Gateway (${prior.id})`, 'EC2', 'DeleteInternetGateway', () => api.deleteIgw(c, prior.id as string));
  },
};

const routeBlock: Record<string, AttrSchema> = { cidr_block: { type: 'string', optional: true }, gateway_id: { type: 'string', optional: true } };

const routeTable: ResourceType = {
  label: 'Route Table',
  schema: { vpc_id: { type: 'string', required: true, forceNew: true }, route: { type: 'set', block: routeBlock, optional: true, computed: true }, id: { type: 'string', computed: true }, arn: { type: 'string', computed: true }, owner_id: { type: 'string', computed: true }, ...TAGS },
  create(p, cfg) {
    const c = p.aws();
    const rt = awsCall('creating Route Table', 'EC2', 'CreateRouteTable', () => api.createRouteTable(c, cfg.vpc_id as string, tagsOf(p, cfg)));
    for (const r of (cfg.route as Attrs[]) ?? []) awsCall(`creating Route in Route Table (${rt.id}) with destination (${r.cidr_block})`, 'EC2', 'CreateRoute', () => api.createRoute(c, rt.id, r.cidr_block as string, r.gateway_id as string));
    return { ...this.read(p, { id: rt.id })!, tags: cfg.tags ?? null };
  },
  read(p, prior) {
    const rt = p.aws().aws.routeTables.find((x) => x.id === prior.id);
    if (!rt) return null;
    return { vpc_id: rt.vpcId, route: rt.routes.filter((r) => r.target !== 'local').map((r) => ({ cidr_block: r.dest, gateway_id: r.target })), id: rt.id, arn: `arn:aws:ec2:${rt.region}:${api.ACCOUNT}:route-table/${rt.id}`, owner_id: api.ACCOUNT, tags: diffTags(null, rt.tags, p), tags_all: rt.tags };
  },
  update(p, prior, cfg) {
    const c = p.aws();
    const rt = c.aws.routeTables.find((x) => x.id === prior.id)!;
    rt.routes = rt.routes.filter((r) => r.target === 'local');
    for (const r of (cfg.route as Attrs[]) ?? []) awsCall(`creating Route in Route Table (${rt.id})`, 'EC2', 'CreateRoute', () => api.createRoute(c, rt.id, r.cidr_block as string, r.gateway_id as string));
    rt.tags = tagsOf(p, cfg);
    return this.read(p, prior)!;
  },
  delete(p, prior) {
    const c = p.aws();
    const rt = c.aws.routeTables.find((x) => x.id === prior.id);
    if (rt?.subnets.length) throw new ProviderError(`deleting Route Table (${prior.id}): operation error EC2: DeleteRouteTable, https response error StatusCode: 400, RequestID: 7c1d, api error DependencyViolation: The routeTable '${prior.id}' has dependencies and cannot be deleted.`);
    c.aws.routeTables = c.aws.routeTables.filter((x) => x.id !== prior.id);
  },
};

const route: ResourceType = {
  label: 'Route',
  schema: { route_table_id: { type: 'string', required: true, forceNew: true }, destination_cidr_block: { type: 'string', required: true, forceNew: true }, gateway_id: { type: 'string', optional: true }, id: { type: 'string', computed: true } },
  create(p, cfg) {
    awsCall(`creating Route in Route Table (${cfg.route_table_id}) with destination (${cfg.destination_cidr_block})`, 'EC2', 'CreateRoute', () => api.createRoute(p.aws(), cfg.route_table_id as string, cfg.destination_cidr_block as string, cfg.gateway_id as string));
    return this.read(p, cfg)!;
  },
  read(p, prior) {
    const rt = p.aws().aws.routeTables.find((x) => x.id === prior.route_table_id);
    const r = rt?.routes.find((x) => x.dest === prior.destination_cidr_block);
    if (!r) return null;
    return { route_table_id: rt!.id, destination_cidr_block: r.dest, gateway_id: r.target, id: `r-${rt!.id}${Math.abs(hashStr(r.dest))}` };
  },
  update(p, prior, cfg) {
    const rt = p.aws().aws.routeTables.find((x) => x.id === prior.route_table_id)!;
    rt.routes = rt.routes.filter((x) => x.dest !== prior.destination_cidr_block);
    return this.create(p, cfg);
  },
  delete(p, prior) {
    const rt = p.aws().aws.routeTables.find((x) => x.id === prior.route_table_id);
    if (rt) rt.routes = rt.routes.filter((x) => x.dest !== prior.destination_cidr_block);
  },
};

function hashStr(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

const rtAssoc: ResourceType = {
  label: 'Route Table Association',
  schema: { subnet_id: { type: 'string', optional: true, forceNew: true }, route_table_id: { type: 'string', required: true }, id: { type: 'string', computed: true } },
  create(p, cfg) {
    const id = awsCall(`associating Route Table (${cfg.route_table_id}) with Subnet (${cfg.subnet_id})`, 'EC2', 'AssociateRouteTable', () => api.associateRouteTable(p.aws(), cfg.route_table_id as string, cfg.subnet_id as string));
    return { subnet_id: cfg.subnet_id, route_table_id: cfg.route_table_id, id };
  },
  read(p, prior) {
    const rt = p.aws().aws.routeTables.find((x) => x.subnets.includes(prior.subnet_id as string));
    return rt ? { ...prior, route_table_id: rt.id } : null;
  },
  update(p, prior, cfg) {
    this.delete(p, prior);
    return this.create(p, cfg);
  },
  delete(p, prior) {
    for (const rt of p.aws().aws.routeTables) rt.subnets = rt.subnets.filter((s) => s !== prior.subnet_id);
  },
};

const ruleBlock: Record<string, AttrSchema> = {
  from_port: { type: 'number', required: true },
  to_port: { type: 'number', required: true },
  protocol: { type: 'string', required: true },
  cidr_blocks: { type: 'list', optional: true },
  security_groups: { type: 'set', optional: true },
  description: { type: 'string', optional: true },
};

const toRule = (r: Attrs) => ({ protocol: String(r.protocol) === '-1' || String(r.protocol) === 'all' ? '-1' : String(r.protocol), from: Number(r.from_port), to: Number(r.to_port), cidrs: ((r.cidr_blocks as string[]) ?? []).map(String), groups: ((r.security_groups as string[]) ?? []).map(String), description: (r.description as string) ?? undefined });
const fromRule = (r: { protocol: string; from: number; to: number; cidrs: string[]; groups: string[]; description?: string }) => ({ from_port: r.protocol === '-1' ? 0 : r.from, to_port: r.protocol === '-1' ? 0 : r.to, protocol: r.protocol, cidr_blocks: r.cidrs, security_groups: r.groups, description: r.description ?? '' });

const sg: ResourceType = {
  label: 'Security Group',
  schema: {
    name: { type: 'string', optional: true, computed: true, forceNew: true },
    description: { type: 'string', optional: true, default: 'Managed by Terraform', forceNew: true },
    vpc_id: { type: 'string', optional: true, computed: true, forceNew: true },
    ingress: { type: 'set', block: ruleBlock, optional: true, computed: true },
    egress: { type: 'set', block: ruleBlock, optional: true, computed: true },
    id: { type: 'string', computed: true },
    arn: { type: 'string', computed: true },
    owner_id: { type: 'string', computed: true },
    ...TAGS,
  },
  create(p, cfg) {
    const c = p.aws();
    const name = (cfg.name as string) ?? `terraform-${String(20261106090000 + p.seed).padEnd(26, '0')}`;
    const g = awsCall(`creating Security Group (${name})`, 'EC2', 'CreateSecurityGroup', () => api.createSecurityGroup(c, name, (cfg.description as string) ?? 'Managed by Terraform', (cfg.vpc_id as string) ?? undefined, tagsOf(p, cfg)));
    // Terraform removes the default allow-all egress rule and manages egress itself.
    g.egress = [];
    for (const r of (cfg.ingress as Attrs[]) ?? []) awsCall(`authorizing Security Group (${g.id}) Rule (ingress)`, 'EC2', 'AuthorizeSecurityGroupIngress', () => api.authorizeIngress(c, g.id, toRule(r)));
    for (const r of (cfg.egress as Attrs[]) ?? []) g.egress.push(toRule(r));
    return { ...this.read(p, { id: g.id })!, tags: cfg.tags ?? null };
  },
  read(p, prior) {
    const g = p.aws().aws.securityGroups.find((x) => x.id === prior.id);
    if (!g) return null;
    return { name: g.name, description: g.description, vpc_id: g.vpcId, ingress: g.ingress.map(fromRule), egress: g.egress.map(fromRule), id: g.id, arn: `arn:aws:ec2:${g.region}:${api.ACCOUNT}:security-group/${g.id}`, owner_id: api.ACCOUNT, tags: diffTags(null, g.tags, p), tags_all: g.tags };
  },
  update(p, prior, cfg) {
    const c = p.aws();
    const g = c.aws.securityGroups.find((x) => x.id === prior.id)!;
    g.ingress = [];
    for (const r of (cfg.ingress as Attrs[]) ?? []) awsCall(`updating Security Group (${g.id}) ingress rules`, 'EC2', 'AuthorizeSecurityGroupIngress', () => api.authorizeIngress(c, g.id, toRule(r)));
    g.egress = ((cfg.egress as Attrs[]) ?? []).map(toRule);
    g.tags = tagsOf(p, cfg);
    return this.read(p, prior)!;
  },
  delete(p, prior) {
    awsCall(`deleting Security Group (${prior.id})`, 'EC2', 'DeleteSecurityGroup', () => api.deleteSecurityGroup(p.aws(), prior.id as string));
  },
  importer(p, id) {
    return this.read(p, { id });
  },
};

const sgIngressRule: ResourceType = {
  label: 'VPC Security Group Ingress Rule',
  schema: {
    security_group_id: { type: 'string', required: true, forceNew: true },
    cidr_ipv4: { type: 'string', optional: true },
    from_port: { type: 'number', optional: true },
    to_port: { type: 'number', optional: true },
    ip_protocol: { type: 'string', required: true },
    description: { type: 'string', optional: true },
    id: { type: 'string', computed: true },
    arn: { type: 'string', computed: true },
  },
  create(p, cfg) {
    const rule = toRule({ protocol: cfg.ip_protocol, from_port: cfg.from_port ?? -1, to_port: cfg.to_port ?? -1, cidr_blocks: cfg.cidr_ipv4 ? [cfg.cidr_ipv4] : [] });
    awsCall(`authorizing VPC Security Group Rule`, 'EC2', 'AuthorizeSecurityGroupIngress', () => api.authorizeIngress(p.aws(), cfg.security_group_id as string, rule));
    const id = `sgr-0${Math.abs(hashStr(JSON.stringify(cfg))).toString(16).padStart(16, '0').slice(0, 16)}`;
    return { ...cfg, description: cfg.description ?? null, id, arn: `arn:aws:ec2:${p.aws().region}:${api.ACCOUNT}:security-group-rule/${id}` };
  },
  read(p, prior) {
    const g = p.aws().aws.securityGroups.find((x) => x.id === prior.security_group_id);
    const ok = g?.ingress.some((r) => r.cidrs.includes(prior.cidr_ipv4 as string) && (r.protocol === '-1' || (r.from === Number(prior.from_port) && r.to === Number(prior.to_port))));
    return ok ? prior : null;
  },
  update(p, prior, cfg) {
    this.delete(p, prior);
    return this.create(p, cfg);
  },
  delete(p, prior) {
    try {
      api.revokeIngress(p.aws(), prior.security_group_id as string, toRule({ protocol: prior.ip_protocol, from_port: prior.from_port ?? -1, to_port: prior.to_port ?? -1, cidr_blocks: prior.cidr_ipv4 ? [prior.cidr_ipv4] : [] }));
    } catch {
      /* already gone */
    }
  },
};

const instance: ResourceType = {
  label: 'EC2 Instance',
  schema: {
    ami: { type: 'string', required: true, forceNew: true },
    instance_type: { type: 'string', required: true },
    key_name: { type: 'string', optional: true, computed: true, forceNew: true },
    subnet_id: { type: 'string', optional: true, computed: true, forceNew: true },
    vpc_security_group_ids: { type: 'set', optional: true, computed: true },
    associate_public_ip_address: { type: 'bool', optional: true, computed: true, forceNew: true },
    user_data: { type: 'string', optional: true },
    user_data_replace_on_change: { type: 'bool', optional: true, default: false },
    id: { type: 'string', computed: true },
    arn: { type: 'string', computed: true },
    availability_zone: { type: 'string', computed: true },
    instance_state: { type: 'string', computed: true },
    private_ip: { type: 'string', computed: true },
    public_ip: { type: 'string', computed: true },
    public_dns: { type: 'string', computed: true },
    ...TAGS,
  },
  createSeconds: 13,
  create(p, cfg) {
    const c = p.aws();
    const [inst] = awsCall('creating EC2 Instance', 'EC2', 'RunInstances', () =>
      api.runInstances(c, {
        ami: cfg.ami as string,
        type: cfg.instance_type as string,
        keyName: (cfg.key_name as string) ?? undefined,
        sgIds: (cfg.vpc_security_group_ids as string[]) ?? [],
        subnetId: (cfg.subnet_id as string) ?? undefined,
        publicIp: cfg.associate_public_ip_address === undefined || cfg.associate_public_ip_address === null ? undefined : b(cfg.associate_public_ip_address),
        userData: (cfg.user_data as string) ?? undefined,
        tags: tagsOf(p, cfg),
      }),
    );
    inst.state = 'running';
    return { ...this.read(p, { id: inst.id, user_data: cfg.user_data ?? null })!, tags: cfg.tags ?? null, user_data_replace_on_change: cfg.user_data_replace_on_change ?? false };
  },
  read(p, prior) {
    const c = p.aws();
    api.settle(c);
    const i = c.aws.instances.find((x) => x.id === prior.id);
    if (!i || i.state === 'terminated') return null;
    return {
      ami: i.ami,
      instance_type: i.type,
      key_name: i.keyName ?? null,
      subnet_id: i.subnetId,
      vpc_security_group_ids: [...i.sgIds].sort(),
      associate_public_ip_address: !!i.publicIp,
      user_data: prior.user_data ?? null,
      user_data_replace_on_change: prior.user_data_replace_on_change ?? false,
      id: i.id,
      arn: `arn:aws:ec2:${i.region}:${api.ACCOUNT}:instance/${i.id}`,
      availability_zone: i.az,
      instance_state: i.state,
      private_ip: i.privateIp,
      public_ip: i.publicIp ?? '',
      public_dns: i.publicIp ? `ec2-${i.publicIp.replace(/\./g, '-')}.compute-1.amazonaws.com` : '',
      tags: diffTags(null, i.tags, p),
      tags_all: i.tags,
    };
  },
  update(p, prior, cfg) {
    const c = p.aws();
    const i = c.aws.instances.find((x) => x.id === prior.id)!;
    if (INSTANCE_OK(cfg.instance_type)) i.type = cfg.instance_type as string;
    else throw new ProviderError(`modifying EC2 Instance (${i.id}) type: operation error EC2: ModifyInstanceAttribute, https response error StatusCode: 400, api error InvalidInstanceAttributeValue: Invalid instance type '${cfg.instance_type}'`);
    if (cfg.vpc_security_group_ids) i.sgIds = [...(cfg.vpc_security_group_ids as string[])];
    i.tags = tagsOf(p, cfg);
    // Changing user_data does not re-run it: cloud-init only runs it on the first boot.
    return { ...this.read(p, { ...prior, user_data: cfg.user_data ?? null })!, tags: cfg.tags ?? null };
  },
  delete(p, prior) {
    awsCall(`terminating EC2 Instance (${prior.id})`, 'EC2', 'TerminateInstances', () => api.setInstanceState(p.aws(), [prior.id as string], 'terminate'));
    api.settle(p.aws());
  },
  importer(p, id) {
    return this.read(p, { id });
  },
};
const INSTANCE_OK = (t: unknown) => typeof t === 'string' && !!api.INSTANCE_TYPES[t];

const eip: ResourceType = {
  label: 'EC2 EIP',
  schema: { instance: { type: 'string', optional: true }, domain: { type: 'string', optional: true, computed: true }, id: { type: 'string', computed: true }, allocation_id: { type: 'string', computed: true }, public_ip: { type: 'string', computed: true }, public_dns: { type: 'string', computed: true }, ...TAGS },
  create(p, cfg) {
    const c = p.aws();
    const a = awsCall('creating EC2 EIP', 'EC2', 'AllocateAddress', () => api.allocateAddress(c, tagsOf(p, cfg)));
    if (cfg.instance) awsCall(`associating EC2 EIP (${a.allocationId}) with EC2 Instance (${cfg.instance})`, 'EC2', 'AssociateAddress', () => api.associateAddress(c, a.allocationId, cfg.instance as string));
    return { ...this.read(p, { id: a.allocationId })!, tags: cfg.tags ?? null };
  },
  read(p, prior) {
    const a = p.aws().aws.addresses.find((x) => x.allocationId === prior.id);
    if (!a) return null;
    return { instance: a.instanceId ?? '', domain: 'vpc', id: a.allocationId, allocation_id: a.allocationId, public_ip: a.publicIp, public_dns: `ec2-${a.publicIp.replace(/\./g, '-')}.compute-1.amazonaws.com`, tags: diffTags(null, a.tags, p), tags_all: a.tags };
  },
  update(p, prior, cfg) {
    const c = p.aws();
    if (cfg.instance && cfg.instance !== prior.instance) api.associateAddress(c, prior.id as string, cfg.instance as string);
    return { ...this.read(p, prior)!, tags: cfg.tags ?? null };
  },
  delete(p, prior) {
    const c = p.aws();
    const a = c.aws.addresses.find((x) => x.allocationId === prior.id);
    if (a) Object.assign(a, { instanceId: undefined, associationId: undefined });
    awsCall(`releasing EC2 EIP (${prior.id})`, 'EC2', 'ReleaseAddress', () => api.releaseAddress(c, prior.id as string));
  },
};

const ebs: ResourceType = {
  label: 'EBS Volume',
  schema: { availability_zone: { type: 'string', required: true, forceNew: true }, size: { type: 'number', optional: true, computed: true }, type: { type: 'string', optional: true, computed: true }, id: { type: 'string', computed: true }, arn: { type: 'string', computed: true }, ...TAGS },
  create(p, cfg) {
    const v = awsCall('creating EBS Volume', 'EC2', 'CreateVolume', () => api.createVolume(p.aws(), Number(cfg.size ?? 8), cfg.availability_zone as string, (cfg.type as string) ?? 'gp3', tagsOf(p, cfg)));
    return { ...this.read(p, { id: v.id })!, tags: cfg.tags ?? null };
  },
  read(p, prior) {
    const v = p.aws().aws.volumes.find((x) => x.id === prior.id);
    if (!v) return null;
    return { availability_zone: v.az, size: v.size, type: v.type, id: v.id, arn: `arn:aws:ec2:${v.region}:${api.ACCOUNT}:volume/${v.id}`, tags: diffTags(null, v.tags, p), tags_all: v.tags };
  },
  update(p, prior, cfg) {
    const v = p.aws().aws.volumes.find((x) => x.id === prior.id)!;
    if (cfg.size !== undefined && Number(cfg.size) < v.size) throw new ProviderError(`modifying EBS Volume (${v.id}): operation error EC2: ModifyVolume, https response error StatusCode: 400, api error InvalidParameterValue: New size cannot be smaller than existing size`);
    v.size = Number(cfg.size ?? v.size);
    v.tags = tagsOf(p, cfg);
    return { ...this.read(p, prior)!, tags: cfg.tags ?? null };
  },
  delete(p, prior) {
    awsCall(`deleting EBS Volume (${prior.id})`, 'EC2', 'DeleteVolume', () => api.deleteVolume(p.aws(), prior.id as string));
  },
};

// ------------------------------------------------------------------ AWS data sources

const filtersOf = (cfg: Attrs) => ((cfg.filter as Attrs[]) ?? []).map((f) => ({ name: String(f.name), values: ((f.values as string[]) ?? []).map(String) }));
const matchVal = (pat: string, v: string) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(v);

const awsData: Record<string, DataType> = {
  aws_ami: {
    schema: { most_recent: { type: 'bool', optional: true }, owners: { type: 'list', optional: true }, filter: { type: 'set', block: { name: { type: 'string', required: true }, values: { type: 'set', required: true } }, optional: true }, id: { type: 'string', computed: true }, image_id: { type: 'string', computed: true }, name: { type: 'string', computed: true }, owner_id: { type: 'string', computed: true }, architecture: { type: 'string', computed: true } },
    read(p, cfg) {
      p.aws();
      const ids = Object.keys(api.AMIS).filter((id) => {
        const owners = ((cfg.owners as string[]) ?? []).map(String);
        if (owners.length && !owners.some((o) => o === '099720109477' || o === 'amazon' || o === 'self' && false)) return false;
        return filtersOf(cfg).every((f) => {
          const v = f.name === 'name' ? api.AMIS[id].name : f.name === 'virtualization-type' ? 'hvm' : f.name === 'architecture' ? 'x86_64' : f.name === 'root-device-type' ? 'ebs' : f.name === 'image-id' ? id : '';
          return f.values.some((pat) => matchVal(pat, v));
        });
      });
      if (!ids.length) throw new ProviderError('Your query returned no results. Please change your search criteria and try again.');
      if (ids.length > 1 && !b(cfg.most_recent)) throw new ProviderError('Your query returned more than one result. Please try a more specific search criteria, or set `most_recent` attribute to true.');
      const id = ids.sort((a, z) => api.AMIS[z].created.localeCompare(api.AMIS[a].created))[0];
      return { ...cfg, id, image_id: id, name: api.AMIS[id].name, owner_id: '099720109477', architecture: 'x86_64' };
    },
  },
  aws_vpc: {
    schema: { default: { type: 'bool', optional: true }, id: { type: 'string', optional: true, computed: true }, tags: { type: 'map', optional: true, computed: true }, cidr_block: { type: 'string', computed: true }, arn: { type: 'string', computed: true }, main_route_table_id: { type: 'string', computed: true } },
    read(p, cfg) {
      const c = p.aws();
      const list = c.aws.vpcs.filter((v) => v.region === c.region && (cfg.default === undefined || cfg.default === null || v.isDefault === b(cfg.default)) && (!cfg.id || v.id === cfg.id) && Object.entries((cfg.tags as Record<string, string>) ?? {}).every(([k, val]) => v.tags[k] === val));
      if (list.length !== 1) throw new ProviderError(list.length ? 'multiple EC2 VPCs matched; use additional constraints to reduce matches to a single EC2 VPC' : 'no matching EC2 VPC found');
      const v = list[0];
      return { ...cfg, id: v.id, cidr_block: v.cidr, arn: `arn:aws:ec2:${v.region}:${api.ACCOUNT}:vpc/${v.id}`, tags: v.tags, main_route_table_id: c.aws.routeTables.find((r) => r.vpcId === v.id && r.main)?.id };
    },
  },
  aws_subnets: {
    schema: { filter: { type: 'set', block: { name: { type: 'string', required: true }, values: { type: 'set', required: true } }, optional: true }, ids: { type: 'list', computed: true }, id: { type: 'string', computed: true } },
    read(p, cfg) {
      const c = p.aws();
      const ids = c.aws.subnets.filter((s) => s.region === c.region && filtersOf(cfg).every((f) => f.values.includes(f.name === 'vpc-id' ? s.vpcId : f.name === 'availability-zone' ? s.az : f.name.startsWith('tag:') ? s.tags[f.name.slice(4)] : ''))).map((s) => s.id);
      return { ...cfg, ids, id: c.region };
    },
  },
  aws_caller_identity: {
    schema: { account_id: { type: 'string', computed: true }, arn: { type: 'string', computed: true }, user_id: { type: 'string', computed: true }, id: { type: 'string', computed: true } },
    read(p) {
      const c = p.aws();
      const u = c.aws.users[c.user];
      return { account_id: api.ACCOUNT, arn: u.arn, user_id: u.id, id: api.ACCOUNT };
    },
  },
  aws_region: {
    schema: { name: { type: 'string', computed: true }, id: { type: 'string', computed: true }, description: { type: 'string', computed: true } },
    read(p) {
      const r = p.aws().region;
      return { name: r, id: r, description: r === 'us-east-1' ? 'US East (N. Virginia)' : r };
    },
  },
  aws_availability_zones: {
    schema: { state: { type: 'string', optional: true }, names: { type: 'list', computed: true }, id: { type: 'string', computed: true } },
    read(p, cfg) {
      const r = p.aws().region;
      return { ...cfg, names: ['a', 'b', 'c'].map((z) => r + z), id: r };
    },
  },
};

// ------------------------------------------------------------------ random / local / null

const WORDS = ['brave', 'calm', 'eager', 'fancy', 'gentle', 'happy', 'jolly', 'keen', 'lively', 'proud', 'quick', 'sharp', 'smart', 'witty'];
const ANIMALS = ['badger', 'cobra', 'dingo', 'falcon', 'gecko', 'heron', 'koala', 'lemur', 'marten', 'otter', 'panda', 'quail', 'raven', 'tiger'];

function rnd(seed: number, i: number): number {
  let x = (seed * 2654435761 + i * 40503 + 12345) >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 4294967296;
}

const keepers: Record<string, AttrSchema> = { keepers: { type: 'map', optional: true, forceNew: true } };

const randomTypes: Record<string, ResourceType> = {
  random_id: {
    label: 'random_id',
    schema: { byte_length: { type: 'number', required: true, forceNew: true }, prefix: { type: 'string', optional: true, forceNew: true }, ...keepers, id: { type: 'string', computed: true }, hex: { type: 'string', computed: true }, dec: { type: 'string', computed: true }, b64_url: { type: 'string', computed: true }, b64_std: { type: 'string', computed: true } },
    create(p, cfg) {
      const n = Number(cfg.byte_length);
      const bytes = Array.from({ length: n }, (_, i) => Math.floor(rnd(p.seed, i) * 256));
      const hex = bytes.map((x) => x.toString(16).padStart(2, '0')).join('');
      const b64 = btoa(String.fromCharCode(...bytes));
      const prefix = (cfg.prefix as string) ?? '';
      return { ...cfg, prefix: cfg.prefix ?? null, keepers: cfg.keepers ?? null, id: b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), hex: prefix + hex, dec: prefix + BigInt('0x' + (hex || '0')).toString(), b64_url: prefix + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), b64_std: prefix + b64 };
    },
    read: (_p, prior) => prior,
    delete: () => undefined,
  },
  random_pet: {
    label: 'random_pet',
    schema: { length: { type: 'number', optional: true, default: 2, forceNew: true }, separator: { type: 'string', optional: true, default: '-', forceNew: true }, prefix: { type: 'string', optional: true, forceNew: true }, ...keepers, id: { type: 'string', computed: true } },
    create(p, cfg) {
      const len = Number(cfg.length ?? 2);
      const parts = Array.from({ length: len }, (_, i) => (i === len - 1 ? ANIMALS : WORDS)[Math.floor(rnd(p.seed, i) * 14)]);
      if (cfg.prefix) parts.unshift(String(cfg.prefix));
      return { length: len, separator: cfg.separator ?? '-', prefix: cfg.prefix ?? null, keepers: cfg.keepers ?? null, id: parts.join(String(cfg.separator ?? '-')) };
    },
    read: (_p, prior) => prior,
    delete: () => undefined,
  },
  random_string: {
    label: 'random_string',
    schema: { length: { type: 'number', required: true, forceNew: true }, special: { type: 'bool', optional: true, default: true, forceNew: true }, upper: { type: 'bool', optional: true, default: true, forceNew: true }, numeric: { type: 'bool', optional: true, default: true, forceNew: true }, ...keepers, result: { type: 'string', computed: true }, id: { type: 'string', computed: true } },
    create(p, cfg) {
      let chars = 'abcdefghijklmnopqrstuvwxyz';
      if (b(cfg.upper, true)) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      if (b(cfg.numeric, true)) chars += '0123456789';
      if (b(cfg.special, true)) chars += '!@#%&*()-_=+[]{}<>:?';
      const s = Array.from({ length: Number(cfg.length) }, (_, i) => chars[Math.floor(rnd(p.seed, i) * chars.length)]).join('');
      return { length: cfg.length, special: b(cfg.special, true), upper: b(cfg.upper, true), numeric: b(cfg.numeric, true), keepers: cfg.keepers ?? null, result: s, id: s };
    },
    read: (_p, prior) => prior,
    delete: () => undefined,
  },
  random_integer: {
    label: 'random_integer',
    schema: { min: { type: 'number', required: true, forceNew: true }, max: { type: 'number', required: true, forceNew: true }, ...keepers, result: { type: 'number', computed: true }, id: { type: 'string', computed: true } },
    create(p, cfg) {
      const v = Number(cfg.min) + Math.floor(rnd(p.seed, 1) * (Number(cfg.max) - Number(cfg.min) + 1));
      return { min: cfg.min, max: cfg.max, keepers: cfg.keepers ?? null, result: v, id: String(v) };
    },
    read: (_p, prior) => prior,
    delete: () => undefined,
  },
};
randomTypes.random_password = {
  ...randomTypes.random_string,
  label: 'random_password',
  schema: { ...randomTypes.random_string.schema, result: { type: 'string', computed: true, sensitive: true } },
  create(p, cfg) {
    return { ...randomTypes.random_string.create(p, cfg), id: 'none' };
  },
};

const localFile: ResourceType = {
  label: 'local_file',
  schema: { filename: { type: 'string', required: true, forceNew: true }, content: { type: 'string', optional: true, forceNew: true }, file_permission: { type: 'string', optional: true, default: '0777', forceNew: true }, id: { type: 'string', computed: true } },
  plan: (_p, cfg) => (typeof cfg.content === 'string' ? { id: sha1ish(cfg.content) } : {}),
  create(p, cfg) {
    const v = new Vfs(p.state.fs, { name: p.state.user, groups: [] }, () => p.state.clock);
    const path = String(cfg.filename).startsWith('/') ? String(cfg.filename) : `${p.dir}/${String(cfg.filename).replace(/^\.\//, '')}`;
    try {
      v.mkdir(path.replace(/\/[^/]+$/, ''), { parents: true });
      v.writeFile(path, String(cfg.content ?? ''));
      v.chmod(path, parseInt(String(cfg.file_permission ?? '0777'), 8) & 0o755);
    } catch (e) {
      throw new ProviderError(`Create local file error\n\nAn unexpected error occurred while writing the file\n\n+Original Error: open ${cfg.filename}: ${(e as Error).message}`);
    }
    return { filename: cfg.filename, content: cfg.content ?? '', file_permission: cfg.file_permission ?? '0777', id: sha1ish(String(cfg.content ?? '')) };
  },
  read(p, prior) {
    const path = String(prior.filename).startsWith('/') ? String(prior.filename) : `${p.dir}/${String(prior.filename).replace(/^\.\//, '')}`;
    try {
      const t = new Vfs(p.state.fs, { name: 'root', groups: ['root'] }).readFile(path);
      return t === prior.content ? prior : null;
    } catch {
      return null;
    }
  },
  delete(p, prior) {
    const path = String(prior.filename).startsWith('/') ? String(prior.filename) : `${p.dir}/${String(prior.filename).replace(/^\.\//, '')}`;
    try {
      new Vfs(p.state.fs, { name: p.state.user, groups: [] }).remove(path);
    } catch {
      /* gone */
    }
  },
};

function sha1ish(s: string): string {
  let h1 = 0x67452301;
  let h2 = 0xefcdab89;
  for (const ch of s) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 2654435761) >>> 0;
    h2 = Math.imul(h2 ^ h1, 1597334677) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(3).slice(0, 40);
}

const nullResource: ResourceType = {
  label: 'null_resource',
  schema: { triggers: { type: 'map', optional: true, forceNew: true }, id: { type: 'string', computed: true } },
  create: (p, cfg) => ({ triggers: cfg.triggers ?? null, id: String(1000000000000000000 + Math.floor(rnd(p.seed, 3) * 8999999999999999)).slice(0, 19) }),
  read: (_p, prior) => prior,
  delete: () => undefined,
};

const terraformData: ResourceType = {
  label: 'terraform_data',
  schema: { input: { type: 'any', optional: true }, triggers_replace: { type: 'any', optional: true, forceNew: true }, output: { type: 'any', computed: true }, id: { type: 'string', computed: true } },
  plan: (_p, cfg) => (cfg.input !== undefined ? { output: cfg.input } : {}),
  create: (p, cfg) => ({ input: cfg.input ?? null, triggers_replace: cfg.triggers_replace ?? null, output: cfg.input ?? null, id: `8f6d2b1c-${String(p.seed).padStart(4, '0')}-4e2a-9c3d-5b7a1e0f2d4c` }),
  read: (_p, prior) => prior,
  update: (_p, prior, cfg) => ({ ...prior, input: cfg.input ?? null, output: cfg.input ?? null }),
  delete: () => undefined,
};

const localData: Record<string, DataType> = {
  local_file: {
    schema: { filename: { type: 'string', required: true }, content: { type: 'string', computed: true }, id: { type: 'string', computed: true } },
    read(p, cfg) {
      const path = String(cfg.filename).startsWith('/') ? String(cfg.filename) : `${p.dir}/${String(cfg.filename).replace(/^\.\//, '')}`;
      try {
        const t = new Vfs(p.state.fs, { name: p.state.user, groups: [] }).readFile(path);
        return { filename: cfg.filename, content: t, id: sha1ish(t) };
      } catch {
        throw new ProviderError(`Read local file data source error\n\nThe file at given path cannot be read.\n\n+Original Error: open ${cfg.filename}: no such file or directory`);
      }
    },
  },
};

export interface Provider {
  source: string;
  version: string;
  resources: Record<string, ResourceType>;
  data: Record<string, DataType>;
}

export const PROVIDERS: Record<string, Provider> = {
  aws: {
    source: 'hashicorp/aws',
    version: '5.72.1',
    resources: {
      aws_s3_bucket: s3Bucket,
      aws_s3_object: s3Object,
      aws_s3_bucket_versioning: s3Versioning,
      aws_s3_bucket_public_access_block: s3PublicAccess,
      aws_s3_bucket_policy: s3Policy,
      aws_s3_bucket_website_configuration: s3Website,
      aws_vpc: vpc,
      aws_subnet: subnet,
      aws_internet_gateway: igw,
      aws_route_table: routeTable,
      aws_route: route,
      aws_route_table_association: rtAssoc,
      aws_security_group: sg,
      aws_vpc_security_group_ingress_rule: sgIngressRule,
      aws_instance: instance,
      aws_eip: eip,
      aws_ebs_volume: ebs,
    },
    data: awsData,
  },
  random: { source: 'hashicorp/random', version: '3.6.3', resources: randomTypes, data: {} },
  local: { source: 'hashicorp/local', version: '2.5.2', resources: { local_file: localFile }, data: localData },
  null: { source: 'hashicorp/null', version: '3.2.3', resources: { null_resource: nullResource }, data: {} },
  terraform: { source: 'terraform.io/builtin/terraform', version: '', resources: { terraform_data: terraformData }, data: {} },
};

/** Provider name for a resource type (aws_instance → aws). */
export function providerOf(type: string): string {
  if (type === 'terraform_data') return 'terraform';
  return type.split('_')[0];
}

/** An AWS caller from the provider config + the shell's credentials, with Terraform's error wording. */
export function awsCaller(cmd: CommandContext, config: Attrs): Caller {
  try {
    return callerFor(cmd, { region: (config.region as string) ?? undefined, profile: (config.profile as string) ?? undefined, dryRun: false }, 'ec2', 'GetCallerIdentity');
  } catch (e) {
    if (e instanceof CliError) {
      if (e.message.includes('Unable to locate credentials')) throw new ProviderError('No valid credential sources found', 'Please see https://registry.terraform.io/providers/hashicorp/aws\nfor more information about providing credentials.\n\nError: failed to refresh cached credentials, no EC2 IMDS role found, operation error ec2imds: GetMetadata, request canceled, context deadline exceeded');
      if (e.message.includes('specify a region')) throw new ProviderError('Missing required argument', 'The argument "region" is required, but was not set.');
      if (e.message.includes('profile')) throw new ProviderError(`failed to get shared config profile, ${config.profile}`);
      if (e.message.includes('endpoint')) throw new ProviderError(`invalid AWS Region: ${config.region}`);
      throw new ProviderError(e.message.trim());
    }
    if (e instanceof AwsError) {
      throw new ProviderError('Retrieving AWS account details: validating provider credentials: retrieving caller identity from STS: operation error STS: GetCallerIdentity, https response error StatusCode: 403, RequestID: 1f2e3d4c-5b6a-4789-8a9b-0c1d2e3f4a5b, api error ' + e.code + ': ' + e.message);
    }
    throw e;
  }
}
