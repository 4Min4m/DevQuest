/** The mock AWS API: every operation the aws CLI and Terraform's aws provider use. */
import type { SimState } from '../state';
import { Vfs } from '../vfs/vfs';
import { createMachine, machineShell } from '../machines';
import type { AwsState, Bucket, Instance, SgRule, Tags } from './types';

export const ACCOUNT = '123456789012';
export const WORKSTATION_PUBLIC_IP = '203.0.113.10';
export const DEFAULT_KEY = { id: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

export const AMIS: Record<string, { name: string; description: string; user: string; created: string }> = {
  'ami-04b70fa74e45c3917': { name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20240423', description: 'Canonical, Ubuntu, 24.04 LTS, amd64 noble image', user: 'ubuntu', created: '2024-04-23T09:40:51.000Z' },
  'ami-0e86e20dae9224db8': { name: 'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20240411', description: 'Canonical, Ubuntu, 22.04 LTS, amd64 jammy image', user: 'ubuntu', created: '2024-04-11T08:12:30.000Z' },
};

export const INSTANCE_TYPES: Record<string, { vcpu: number; memMb: number; hourly: number }> = {
  't2.micro': { vcpu: 1, memMb: 1024, hourly: 0.0116 },
  't3.micro': { vcpu: 2, memMb: 1024, hourly: 0.0104 },
  't3.small': { vcpu: 2, memMb: 2048, hourly: 0.0208 },
  't3.medium': { vcpu: 2, memMb: 4096, hourly: 0.0416 },
  'm5.large': { vcpu: 2, memMb: 8192, hourly: 0.096 },
};

export const REGIONS = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'];

export class AwsError extends Error {
  constructor(public code: string, message: string, public op = '', public exit = 254) {
    super(message);
  }
}

function hex(n: number, len: number): string {
  let x = (n * 2654435761 + 0x9e3779b9) >>> 0;
  let out = '';
  while (out.length < len) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += (x >>> 8).toString(16).padStart(6, '0');
  }
  return out.slice(0, len);
}

export function newId(aws: AwsState, prefix: string, len = 17): string {
  aws.seq++;
  return `${prefix}-0${hex(aws.seq, len - 1)}`;
}

export function createAwsState(opts: { users?: Record<string, string[]> } = {}): AwsState {
  const aws: AwsState = { account: ACCOUNT, keys: {}, users: {}, buckets: {}, vpcs: [], subnets: [], igws: [], routeTables: [], securityGroups: [], keyPairs: [], instances: [], volumes: [], addresses: [], seq: 0, calls: [] };
  const users = opts.users ?? { student: ['*'] };
  let i = 0;
  for (const [name, allow] of Object.entries(users)) {
    aws.users[name] = { name, id: `AIDA${hex(100 + i, 17).toUpperCase()}`, arn: `arn:aws:iam::${ACCOUNT}:user/${name}`, created: Date.UTC(2026, 0, 12), allow, policies: allow.includes('*') ? ['AdministratorAccess'] : [] };
    const key = i === 0 ? DEFAULT_KEY : { id: `AKIA${hex(200 + i, 16).toUpperCase()}`, secret: hex(300 + i, 40) };
    aws.keys[key.id] = { secret: key.secret, user: name };
    i++;
  }
  // The default VPC every account has in us-east-1.
  const region = 'us-east-1';
  const vpc = { id: 'vpc-0d1e2f3a4b5c6d7e8', cidr: '172.31.0.0/16', isDefault: true, tags: {}, region, dnsHostnames: true };
  aws.vpcs.push(vpc);
  aws.subnets.push(
    { id: 'subnet-0a1b2c3d4e5f60718', vpcId: vpc.id, cidr: '172.31.0.0/20', az: 'us-east-1a', mapPublicIp: true, tags: {}, region },
    { id: 'subnet-0b2c3d4e5f6071829', vpcId: vpc.id, cidr: '172.31.16.0/20', az: 'us-east-1b', mapPublicIp: true, tags: {}, region },
  );
  aws.igws.push({ id: 'igw-0c3d4e5f60718293a', vpcId: vpc.id, tags: {}, region });
  aws.routeTables.push({ id: 'rtb-0e5f60718293a4b5c', vpcId: vpc.id, main: true, routes: [{ dest: '172.31.0.0/16', target: 'local' }, { dest: '0.0.0.0/0', target: 'igw-0c3d4e5f60718293a' }], subnets: [], tags: {}, region });
  aws.securityGroups.push(defaultSg('sg-0f60718293a4b5c6d', vpc.id, region));
  return aws;
}

function defaultSg(id: string, vpcId: string, region: string) {
  return {
    id,
    name: 'default',
    description: 'default VPC security group',
    vpcId,
    ingress: [{ protocol: '-1', from: -1, to: -1, cidrs: [], groups: [id] }],
    egress: [{ protocol: '-1', from: -1, to: -1, cidrs: ['0.0.0.0/0'], groups: [] }],
    tags: {},
    region,
  };
}

// ------------------------------------------------------------------ identity

export interface Caller {
  aws: AwsState;
  user: string;
  region: string;
  state: SimState;
}

function actionMatches(pattern: string, action: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return re.test(action);
}

/** IAM: may the caller do `action`? Throws AccessDenied like the real API. */
export function authorize(c: Caller, action: string, op: string, resource = '*'): void {
  c.aws.calls.push(action);
  const u = c.aws.users[c.user];
  if (!u || u.allow.some((p) => actionMatches(p, action))) return;
  const arn = u.arn;
  if (action.startsWith('ec2:')) throw new AwsError('UnauthorizedOperation', `You are not authorized to perform this operation. User: ${arn} is not authorized to perform: ${action} because no identity-based policy allows the ${action} action. Encoded authorization failure message: 5Xh2...`, op);
  throw new AwsError('AccessDenied', `User: ${arn} is not authorized to perform: ${action} on resource: ${resource} because no identity-based policy allows the ${action} action`, op);
}

// ------------------------------------------------------------------ S3

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** Bucket names other AWS accounts already own (globally unique namespace). */
export const TAKEN_BUCKETS = new Set(['test', 'backup', 'my-bucket', 'website', 'assets', 'data', 'logs', 'devops']);

export function bucketOf(c: Caller, name: string, op: string): Bucket {
  const b = c.aws.buckets[name];
  if (!b) throw new AwsError('NoSuchBucket', 'The specified bucket does not exist', op);
  return b;
}

export function createBucket(c: Caller, name: string, region = c.region): Bucket {
  const op = 'CreateBucket';
  authorize(c, 's3:CreateBucket', op, `arn:aws:s3:::${name}`);
  if (!BUCKET_RE.test(name) || name.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(name)) throw new AwsError('InvalidBucketName', 'The specified bucket is not valid.', op);
  if (c.aws.buckets[name]) throw new AwsError('BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.', op);
  if (TAKEN_BUCKETS.has(name)) throw new AwsError('BucketAlreadyExists', 'The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.', op);
  const b: Bucket = { name, region, created: c.state.clock, blockPublic: true, objects: {} };
  c.aws.buckets[name] = b;
  return b;
}

export function deleteBucket(c: Caller, name: string): void {
  const op = 'DeleteBucket';
  authorize(c, 's3:DeleteBucket', op, `arn:aws:s3:::${name}`);
  const b = bucketOf(c, name, op);
  if (Object.keys(b.objects).length || Object.values(b.versions ?? {}).some((v) => v.length)) throw new AwsError('BucketNotEmpty', 'The bucket you tried to delete is not empty', op);
  delete c.aws.buckets[name];
}

function etag(body: string): string {
  let h = 0;
  for (const ch of body) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return hex(h, 32);
}

export function putObject(c: Caller, bucket: string, key: string, body: string, contentType?: string): void {
  const op = 'PutObject';
  authorize(c, 's3:PutObject', op, `arn:aws:s3:::${bucket}/${key}`);
  const b = bucketOf(c, bucket, op);
  const prev = b.objects[key];
  const obj = { body, modified: c.state.clock, etag: etag(body), contentType: contentType ?? guessType(key), versionId: b.versioning === 'Enabled' ? hex(c.aws.seq++, 32) : undefined };
  if (prev && b.versioning === 'Enabled') ((b.versions ??= {})[key] ??= []).unshift(prev);
  b.objects[key] = obj;
}

export function deleteObject(c: Caller, bucket: string, key: string): void {
  const op = 'DeleteObject';
  authorize(c, 's3:DeleteObject', op, `arn:aws:s3:::${bucket}/${key}`);
  const b = bucketOf(c, bucket, op);
  const prev = b.objects[key];
  if (prev && b.versioning === 'Enabled') ((b.versions ??= {})[key] ??= []).unshift(prev);
  delete b.objects[key];
}

export function getObject(c: Caller, bucket: string, key: string): { body: string; contentType?: string; modified: number } {
  const op = 'GetObject';
  authorize(c, 's3:GetObject', op, `arn:aws:s3:::${bucket}/${key}`);
  const b = bucketOf(c, bucket, op);
  const o = b.objects[key];
  if (!o) throw new AwsError('404', 'Not Found', 'HeadObject');
  return o;
}

function guessType(key: string): string {
  if (/\.html?$/.test(key)) return 'text/html';
  if (key.endsWith('.css')) return 'text/css';
  if (key.endsWith('.js')) return 'application/javascript';
  if (key.endsWith('.json')) return 'application/json';
  if (/\.(png|jpe?g|gif)$/.test(key)) return 'image/' + key.split('.').pop()!.replace('jpg', 'jpeg');
  return 'binary/octet-stream';
}

/** Does the bucket policy let anyone (Principal "*") read objects? */
export function publicRead(b: Bucket): boolean {
  if (b.blockPublic || !b.policy) return false;
  try {
    const p = JSON.parse(b.policy) as { Statement?: { Effect?: string; Principal?: unknown; Action?: string | string[]; Resource?: string | string[] }[] };
    return (p.Statement ?? []).some((s) => {
      const actions = ([] as string[]).concat(s.Action ?? []);
      const res = ([] as string[]).concat(s.Resource ?? []);
      const anyone = s.Principal === '*' || (typeof s.Principal === 'object' && s.Principal !== null && (s.Principal as { AWS?: string }).AWS === '*');
      return s.Effect === 'Allow' && anyone && actions.some((a) => actionMatches(a, 's3:GetObject')) && res.some((r) => r === `arn:aws:s3:::${b.name}/*` || r === `arn:aws:s3:::${b.name}*`);
    });
  } catch {
    return false;
  }
}

export function validatePolicy(text: string, bucket: string, op: string): void {
  let p: { Statement?: { Resource?: string | string[] }[] };
  try {
    p = JSON.parse(text);
  } catch {
    throw new AwsError('MalformedPolicy', 'Policies must be valid JSON and the first byte must be \'{\'', op);
  }
  for (const s of p.Statement ?? []) {
    for (const r of ([] as string[]).concat(s.Resource ?? [])) {
      if (!r.startsWith(`arn:aws:s3:::${bucket}`)) throw new AwsError('MalformedPolicy', 'Policy has invalid resource', op);
    }
  }
}

// ------------------------------------------------------------------ EC2 networking

export function ipToNum(ip: string): number {
  return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
}

export function numToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(ipToNum(base) / size) * size;
  const n = ipToNum(ip);
  return n >= start && n < start + size;
}

export function validCidr(cidr: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  return !!m && m.slice(1, 5).every((o) => Number(o) < 256) && Number(m[5]) <= 32;
}

export function cidrWithin(inner: string, outer: string): boolean {
  return Number(inner.split('/')[1]) >= Number(outer.split('/')[1]) && inCidr(inner.split('/')[0], outer);
}

export function cidrOverlap(a: string, b: string): boolean {
  return inCidr(a.split('/')[0], b) || inCidr(b.split('/')[0], a);
}

const notFound = (code: string, what: string, id: string, op: string) => new AwsError(code, `The ${what} ID '${id}' does not exist`, op);

export function vpcOf(c: Caller, id: string, op: string) {
  const v = c.aws.vpcs.find((x) => x.id === id && x.region === c.region);
  if (!v) throw notFound('InvalidVpcID.NotFound', 'vpc', id, op);
  return v;
}
export function subnetOf(c: Caller, id: string, op: string) {
  const v = c.aws.subnets.find((x) => x.id === id && x.region === c.region);
  if (!v) throw notFound('InvalidSubnetID.NotFound', 'subnet', id, op);
  return v;
}
export function sgOf(c: Caller, id: string, op: string) {
  const v = c.aws.securityGroups.find((x) => (x.id === id || x.name === id) && x.region === c.region);
  if (!v) throw new AwsError('InvalidGroup.NotFound', `The security group '${id}' does not exist`, op);
  return v;
}
export function instanceOf(c: Caller, id: string, op: string) {
  const v = c.aws.instances.find((x) => x.id === id && x.region === c.region);
  if (!v) throw new AwsError('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`, op);
  return v;
}

export function createVpc(c: Caller, cidr: string, tags: Tags = {}) {
  const op = 'CreateVpc';
  authorize(c, 'ec2:CreateVpc', op);
  if (!validCidr(cidr)) throw new AwsError('InvalidParameterValue', `Value (${cidr}) for parameter cidrBlock is invalid. This is not a valid CIDR block.`, op);
  const bits = Number(cidr.split('/')[1]);
  if (bits < 16 || bits > 28) throw new AwsError('InvalidVpc.Range', `The CIDR '${cidr}' is invalid.`, op);
  const vpc: import('./types').Vpc = { id: newId(c.aws, 'vpc'), cidr, isDefault: false, tags, region: c.region };
  c.aws.vpcs.push(vpc);
  c.aws.routeTables.push({ id: newId(c.aws, 'rtb'), vpcId: vpc.id, main: true, routes: [{ dest: cidr, target: 'local' }], subnets: [], tags: {}, region: c.region });
  c.aws.securityGroups.push(defaultSg(newId(c.aws, 'sg'), vpc.id, c.region));
  return vpc;
}

export function deleteVpc(c: Caller, id: string) {
  const op = 'DeleteVpc';
  authorize(c, 'ec2:DeleteVpc', op);
  const v = vpcOf(c, id, op);
  const deps = c.aws.subnets.some((s) => s.vpcId === id) || c.aws.igws.some((g) => g.vpcId === id) || c.aws.securityGroups.some((g) => g.vpcId === id && g.name !== 'default') || c.aws.routeTables.some((r) => r.vpcId === id && !r.main);
  if (deps) throw new AwsError('DependencyViolation', `The vpc '${id}' has dependencies and cannot be deleted.`, op);
  c.aws.vpcs = c.aws.vpcs.filter((x) => x !== v);
  c.aws.routeTables = c.aws.routeTables.filter((r) => r.vpcId !== id);
  c.aws.securityGroups = c.aws.securityGroups.filter((g) => g.vpcId !== id);
}

export function createSubnet(c: Caller, vpcId: string, cidr: string, az?: string, tags: Tags = {}) {
  const op = 'CreateSubnet';
  authorize(c, 'ec2:CreateSubnet', op);
  const vpc = vpcOf(c, vpcId, op);
  if (!validCidr(cidr) || !cidrWithin(cidr, vpc.cidr)) throw new AwsError('InvalidSubnet.Range', `The CIDR '${cidr}' is invalid.`, op);
  if (c.aws.subnets.some((s) => s.vpcId === vpcId && cidrOverlap(s.cidr, cidr))) throw new AwsError('InvalidSubnet.Conflict', `The CIDR '${cidr}' conflicts with another subnet`, op);
  const zone = az ?? `${c.region}a`;
  if (!zone.startsWith(c.region)) throw new AwsError('InvalidParameterValue', `Value (${zone}) for parameter availabilityZone is invalid. Subnets can currently only be created in the following availability zones: ${c.region}a, ${c.region}b, ${c.region}c.`, op);
  const s = { id: newId(c.aws, 'subnet'), vpcId, cidr, az: zone, mapPublicIp: false, tags, region: c.region };
  c.aws.subnets.push(s);
  return s;
}

export function deleteSubnet(c: Caller, id: string) {
  const op = 'DeleteSubnet';
  authorize(c, 'ec2:DeleteSubnet', op);
  subnetOf(c, id, op);
  if (c.aws.instances.some((i) => i.subnetId === id && i.state !== 'terminated')) throw new AwsError('DependencyViolation', `The subnet '${id}' has dependencies and cannot be deleted.`, op);
  c.aws.subnets = c.aws.subnets.filter((s) => s.id !== id);
  for (const rt of c.aws.routeTables) rt.subnets = rt.subnets.filter((s) => s !== id);
}

export function createIgw(c: Caller, tags: Tags = {}) {
  authorize(c, 'ec2:CreateInternetGateway', 'CreateInternetGateway');
  const g = { id: newId(c.aws, 'igw'), tags, region: c.region } as { id: string; vpcId?: string; tags: Tags; region: string };
  c.aws.igws.push(g);
  return g;
}

export function attachIgw(c: Caller, igwId: string, vpcId: string) {
  const op = 'AttachInternetGateway';
  authorize(c, 'ec2:AttachInternetGateway', op);
  const g = c.aws.igws.find((x) => x.id === igwId && x.region === c.region);
  if (!g) throw new AwsError('InvalidInternetGatewayID.NotFound', `The internetGateway ID '${igwId}' does not exist`, op);
  vpcOf(c, vpcId, op);
  if (g.vpcId) throw new AwsError('Resource.AlreadyAssociated', `resource ${igwId} is already attached to network ${g.vpcId}`, op);
  if (c.aws.igws.some((x) => x.vpcId === vpcId)) throw new AwsError('InvalidParameterValue', `Network ${vpcId} already has an internet gateway attached`, op);
  g.vpcId = vpcId;
}

export function detachIgw(c: Caller, igwId: string, vpcId: string) {
  const op = 'DetachInternetGateway';
  authorize(c, 'ec2:DetachInternetGateway', op);
  const g = c.aws.igws.find((x) => x.id === igwId);
  if (!g || g.vpcId !== vpcId) throw new AwsError('Gateway.NotAttached', `resource ${igwId} is not attached to network ${vpcId}`, op);
  delete g.vpcId;
}

export function deleteIgw(c: Caller, igwId: string) {
  const op = 'DeleteInternetGateway';
  authorize(c, 'ec2:DeleteInternetGateway', op);
  const g = c.aws.igws.find((x) => x.id === igwId);
  if (!g) throw new AwsError('InvalidInternetGatewayID.NotFound', `The internetGateway ID '${igwId}' does not exist`, op);
  if (g.vpcId) throw new AwsError('DependencyViolation', `The internetGateway '${igwId}' has dependencies and cannot be deleted.`, op);
  c.aws.igws = c.aws.igws.filter((x) => x !== g);
}

export function rtOf(c: Caller, id: string, op: string) {
  const r = c.aws.routeTables.find((x) => x.id === id && x.region === c.region);
  if (!r) throw new AwsError('InvalidRouteTableID.NotFound', `The routeTable ID '${id}' does not exist`, op);
  return r;
}

export function createRouteTable(c: Caller, vpcId: string, tags: Tags = {}) {
  const op = 'CreateRouteTable';
  authorize(c, 'ec2:CreateRouteTable', op);
  const vpc = vpcOf(c, vpcId, op);
  const r = { id: newId(c.aws, 'rtb'), vpcId, main: false, routes: [{ dest: vpc.cidr, target: 'local' }], subnets: [] as string[], tags, region: c.region };
  c.aws.routeTables.push(r);
  return r;
}

export function createRoute(c: Caller, rtId: string, dest: string, target: string) {
  const op = 'CreateRoute';
  authorize(c, 'ec2:CreateRoute', op);
  const rt = rtOf(c, rtId, op);
  if (target.startsWith('igw-')) {
    const g = c.aws.igws.find((x) => x.id === target);
    if (!g) throw new AwsError('InvalidGatewayID.NotFound', `The gateway ID '${target}' does not exist`, op);
    if (g.vpcId !== rt.vpcId) throw new AwsError('InvalidParameterValue', `route table ${rtId} and network gateway ${target} belong to different networks`, op);
  }
  if (rt.routes.some((r) => r.dest === dest)) throw new AwsError('RouteAlreadyExists', `The route identified by ${dest} already exists.`, op);
  rt.routes.push({ dest, target });
}

export function associateRouteTable(c: Caller, rtId: string, subnetId: string): string {
  const op = 'AssociateRouteTable';
  authorize(c, 'ec2:AssociateRouteTable', op);
  const rt = rtOf(c, rtId, op);
  const s = subnetOf(c, subnetId, op);
  if (s.vpcId !== rt.vpcId) throw new AwsError('InvalidParameterValue', `routeTable ${rtId} and subnet ${subnetId} belong to different networks`, op);
  if (c.aws.routeTables.some((r) => r.subnets.includes(subnetId))) throw new AwsError('Resource.AlreadyAssociated', `the specified association for route table ${rtId} conflicts with an existing association`, op);
  rt.subnets.push(subnetId);
  return `rtbassoc-0${hex(c.aws.seq++, 16)}`;
}

/** The route table a subnet uses: its explicit association, else the VPC's main table. */
export function routeTableFor(aws: AwsState, subnetId: string) {
  const s = aws.subnets.find((x) => x.id === subnetId);
  return aws.routeTables.find((r) => r.subnets.includes(subnetId)) ?? aws.routeTables.find((r) => r.vpcId === s?.vpcId && r.main);
}

export function createSecurityGroup(c: Caller, name: string, description: string, vpcId?: string, tags: Tags = {}) {
  const op = 'CreateSecurityGroup';
  authorize(c, 'ec2:CreateSecurityGroup', op);
  const vpc = vpcId ? vpcOf(c, vpcId, op) : c.aws.vpcs.find((v) => v.isDefault && v.region === c.region);
  if (!vpc) throw new AwsError('VPCIdNotSpecified', 'No default VPC for this user', op);
  if (c.aws.securityGroups.some((g) => g.vpcId === vpc.id && g.name === name)) throw new AwsError('InvalidGroup.Duplicate', `The security group '${name}' already exists for VPC '${vpc.id}'`, op);
  const g: import('./types').SecurityGroup = { id: newId(c.aws, 'sg'), name, description, vpcId: vpc.id, ingress: [] as SgRule[], egress: [{ protocol: '-1', from: -1, to: -1, cidrs: ['0.0.0.0/0'], groups: [] }], tags, region: c.region };
  c.aws.securityGroups.push(g);
  return g;
}

export function deleteSecurityGroup(c: Caller, id: string) {
  const op = 'DeleteSecurityGroup';
  authorize(c, 'ec2:DeleteSecurityGroup', op);
  const g = sgOf(c, id, op);
  if (g.name === 'default') throw new AwsError('CannotDelete', `the specified group: "${g.id}" name: "default" cannot be deleted by a user`, op);
  if (c.aws.instances.some((i) => i.state !== 'terminated' && i.sgIds.includes(g.id))) throw new AwsError('DependencyViolation', `resource ${g.id} has a dependent object`, op);
  c.aws.securityGroups = c.aws.securityGroups.filter((x) => x !== g);
}

const sameRule = (a: SgRule, b: SgRule) => a.protocol === b.protocol && a.from === b.from && a.to === b.to;

export function authorizeIngress(c: Caller, sgId: string, rule: SgRule, egress = false) {
  const op = egress ? 'AuthorizeSecurityGroupEgress' : 'AuthorizeSecurityGroupIngress';
  authorize(c, `ec2:${op}`, op);
  const g = sgOf(c, sgId, op);
  const list = egress ? g.egress : g.ingress;
  for (const cidr of rule.cidrs) {
    if (!validCidr(cidr)) throw new AwsError('InvalidParameterValue', `CIDR block ${cidr} is malformed`, op);
    if (list.some((r) => sameRule(r, rule) && r.cidrs.includes(cidr))) throw new AwsError('InvalidPermission.Duplicate', `the specified rule "peer: ${cidr}, ${rule.protocol.toUpperCase()}, from port: ${rule.from}, to port: ${rule.to}, ALLOW" already exists`, op);
  }
  const existing = list.find((r) => sameRule(r, rule));
  if (existing) {
    existing.cidrs.push(...rule.cidrs);
    existing.groups.push(...rule.groups);
  } else list.push({ ...rule, cidrs: [...rule.cidrs], groups: [...rule.groups] });
}

export function revokeIngress(c: Caller, sgId: string, rule: SgRule, egress = false) {
  const op = egress ? 'RevokeSecurityGroupEgress' : 'RevokeSecurityGroupIngress';
  authorize(c, `ec2:${op}`, op);
  const g = sgOf(c, sgId, op);
  const list = egress ? g.egress : g.ingress;
  const existing = list.find((r) => sameRule(r, rule) && rule.cidrs.every((x) => r.cidrs.includes(x)));
  if (!existing) throw new AwsError('InvalidPermission.NotFound', 'The specified rule does not exist in this security group.', op);
  existing.cidrs = existing.cidrs.filter((x) => !rule.cidrs.includes(x));
  if (!existing.cidrs.length && !existing.groups.length) {
    if (egress) g.egress = g.egress.filter((r) => r !== existing);
    else g.ingress = g.ingress.filter((r) => r !== existing);
  }
}

// ------------------------------------------------------------------ key pairs

export function createKeyPair(c: Caller, name: string) {
  const op = 'CreateKeyPair';
  authorize(c, 'ec2:CreateKeyPair', op);
  if (c.aws.keyPairs.some((k) => k.name === name && k.region === c.region)) throw new AwsError('InvalidKeyPair.Duplicate', `The keypair already exists`, op);
  const k = { name, id: newId(c.aws, 'key'), fingerprint: hex(c.aws.seq * 7, 40).match(/../g)!.join(':'), region: c.region };
  c.aws.keyPairs.push(k);
  return { ...k, material: keyMaterial(k.id) };
}

export function keyMaterial(id: string): string {
  return `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA${id.replace(/-/g, '')}devquestSimulatedKeyMaterial\n-----END RSA PRIVATE KEY-----`;
}

export function deleteKeyPair(c: Caller, name: string) {
  authorize(c, 'ec2:DeleteKeyPair', 'DeleteKeyPair');
  c.aws.keyPairs = c.aws.keyPairs.filter((k) => !(k.name === name && k.region === c.region));
}

// ------------------------------------------------------------------ instances

function publicIp(aws: AwsState): string {
  aws.seq++;
  const n = aws.seq;
  return `54.${160 + (n % 60)}.${(n * 37) % 250 + 1}.${(n * 91) % 250 + 2}`;
}

function publicDns(ip: string): string {
  return `ec2-${ip.replace(/\./g, '-')}.compute-1.amazonaws.com`;
}

export function instanceHostname(privateIp: string): string {
  return `ip-${privateIp.replace(/\./g, '-')}`;
}

export interface RunOptions {
  ami: string;
  type: string;
  count?: number;
  keyName?: string;
  sgIds?: string[];
  subnetId?: string;
  publicIp?: boolean;
  userData?: string;
  tags?: Tags;
  volumeSize?: number;
}

function setDns(state: SimState, ip: string | undefined, add: boolean) {
  if (!ip || !state.net) return;
  const name = publicDns(ip);
  state.net.records = state.net.records.filter((r) => r.name !== name);
  if (add) state.net.records.push({ name, type: 'A', value: ip, ttl: 300 });
}

export function runInstances(c: Caller, o: RunOptions): Instance[] {
  const op = 'RunInstances';
  authorize(c, 'ec2:RunInstances', op);
  const ami = AMIS[o.ami];
  if (!ami) throw new AwsError('InvalidAMIID.NotFound', `The image id '[${o.ami}]' does not exist`, op);
  if (!INSTANCE_TYPES[o.type]) throw new AwsError('InvalidParameterValue', `Invalid value '${o.type}' for InstanceType.`, op);
  if (o.keyName && !c.aws.keyPairs.some((k) => k.name === o.keyName && k.region === c.region)) throw new AwsError('InvalidKeyPair.NotFound', `The key pair '${o.keyName}' does not exist`, op);
  const subnet = o.subnetId ? subnetOf(c, o.subnetId, op) : c.aws.subnets.find((s) => s.region === c.region && c.aws.vpcs.some((v) => v.id === s.vpcId && v.isDefault));
  if (!subnet) throw new AwsError('VPCIdNotSpecified', 'No default VPC for this user. GroupName is only supported for EC2-Classic and default VPC.', op);
  const sgs = (o.sgIds?.length ? o.sgIds : ['default']).map((id) => {
    const g = c.aws.securityGroups.find((x) => (x.id === id || (x.name === id && x.vpcId === subnet.vpcId)) && x.region === c.region);
    if (!g) throw new AwsError('InvalidGroup.NotFound', `The security group '${id}' does not exist in VPC '${subnet.vpcId}'`, op);
    if (g.vpcId !== subnet.vpcId) throw new AwsError('InvalidParameter', `Security group ${g.id} and subnet ${subnet.id} belong to different networks.`, op);
    return g.id;
  });
  const out: Instance[] = [];
  for (let n = 0; n < (o.count ?? 1); n++) {
    const used = new Set(c.aws.instances.filter((i) => i.subnetId === subnet.id && i.state !== 'terminated').map((i) => i.privateIp));
    const base = ipToNum(subnet.cidr.split('/')[0]);
    let k = 4 + ((c.aws.seq * 13) % 200);
    while (used.has(numToIp(base + k))) k++;
    const privateIp = numToIp(base + k);
    const id = newId(c.aws, 'i');
    const pub = (o.publicIp ?? subnet.mapPublicIp) ? publicIp(c.aws) : undefined;
    const volId = newId(c.aws, 'vol');
    c.aws.volumes.push({ id: volId, size: o.volumeSize ?? 8, type: 'gp3', az: subnet.az, state: 'in-use', attachedTo: id, device: '/dev/sda1', tags: {}, region: c.region, created: c.state.clock, deleteOnTermination: true });
    const host = instanceHostname(privateIp);
    const key = o.keyName ? c.aws.keyPairs.find((k) => k.name === o.keyName && k.region === c.region)! : undefined;
    const m = createMachine({ hostname: host, ip: privateIp, publicIp: pub, user: ami.user, keyFile: key ? key.id : '__no_key__', ec2: id }, c.state.clock);
    m.perf = { ...m.perf!, cpus: INSTANCE_TYPES[o.type].vcpu, memTotalKb: INSTANCE_TYPES[o.type].memMb * 1024 };
    (c.state.machines ??= {})[id] = m;
    const inst: Instance = { id, ami: o.ami, type: o.type, state: 'pending', launched: c.state.clock, subnetId: subnet.id, vpcId: subnet.vpcId, privateIp, publicIp: pub, keyName: o.keyName, sgIds: sgs, tags: { ...(o.tags ?? {}) }, region: c.region, az: subnet.az, machine: id, rootVolume: volId, userData: o.userData, since: c.state.clock };
    c.aws.instances.push(inst);
    setDns(c.state, pub, true);
    if (o.userData) runUserData(m, o.userData);
    out.push(inst);
  }
  return out;
}

/** cloud-init: run the user-data script as root on first boot (output in /var/log/cloud-init-output.log). */
function runUserData(m: SimState, script: string) {
  const prev = { user: m.user, cwd: m.cwd, vars: m.vars };
  m.user = 'root';
  m.cwd = '/';
  m.vars = { ...m.vars, USER: 'root', HOME: '/root' };
  const log: string[] = [];
  try {
    const sh = machineShell(m);
    for (const line of script.split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const r = sh.run(line);
      for (const o of r.output) log.push(o.text);
      if (r.exitCode !== 0 && /^\s*set -e/m.test(script)) break;
    }
  } finally {
    Object.assign(m, prev);
  }
  const v = new Vfs(m.fs, { name: 'root', groups: ['root'] }, () => m.clock);
  v.mkdir('/var/log', { parents: true });
  v.writeFile('/var/log/cloud-init-output.log', `Cloud-init v. 24.1.3 running 'modules:final'\n${log.join('')}Cloud-init v. 24.1.3 finished\n`);
}

/** Effective state: pending instances are running by the next call. */
export function settle(c: Caller) {
  for (const i of c.aws.instances) {
    if (i.state === 'pending' && c.state.clock > i.launched) {
      i.state = 'running';
      i.since = c.state.clock;
    }
    if (i.state === 'stopping') {
      i.state = 'stopped';
      i.since = c.state.clock;
    }
    if (i.state === 'shutting-down') i.state = 'terminated';
  }
}

export function setInstanceState(c: Caller, ids: string[], action: 'start' | 'stop' | 'terminate' | 'reboot') {
  const opName = { start: 'StartInstances', stop: 'StopInstances', terminate: 'TerminateInstances', reboot: 'RebootInstances' }[action];
  authorize(c, `ec2:${opName}`, opName);
  const changes: { id: string; prev: string; cur: string }[] = [];
  for (const id of ids) {
    const i = instanceOf(c, id, opName);
    const prev = i.state;
    const m = c.state.machines?.[i.machine];
    if (action === 'terminate') {
      if (i.state !== 'terminated') {
        i.state = 'shutting-down';
        if (m?.machine) m.machine.up = false;
        for (const v of c.aws.volumes.filter((x) => x.attachedTo === i.id)) {
          if (v.deleteOnTermination) c.aws.volumes = c.aws.volumes.filter((x) => x !== v);
          else Object.assign(v, { state: 'available', attachedTo: undefined, device: undefined });
        }
        for (const a of c.aws.addresses.filter((x) => x.instanceId === i.id)) Object.assign(a, { instanceId: undefined, associationId: undefined });
        setDns(c.state, i.publicIp, false);
        i.publicIp = undefined;
      }
    } else if (action === 'stop') {
      if (i.state === 'terminated') throw new AwsError('IncorrectInstanceState', `This instance '${id}' is not in a state from which it can be stopped.`, opName);
      if (i.state === 'running' || i.state === 'pending') {
        i.state = 'stopping';
        if (m?.machine) {
          m.machine.up = false;
          m.processes = m.processes.filter((p) => p.pid === 1 || !p.unit || !m.systemd?.units[p.unit]?.enabled);
        }
        if (!c.aws.addresses.some((a) => a.instanceId === i.id)) {
          setDns(c.state, i.publicIp, false);
          i.publicIp = undefined;
          if (m?.machine) m.machine.publicIp = undefined;
        }
      }
    } else if (action === 'start') {
      if (i.state === 'terminated') throw new AwsError('IncorrectInstanceState', `The instance '${id}' is not in a state from which it can be started.`, opName);
      if (i.state === 'stopped' || i.state === 'stopping') {
        i.state = 'pending';
        i.launched = c.state.clock;
        const subnet = c.aws.subnets.find((s) => s.id === i.subnetId);
        if (!i.publicIp && subnet?.mapPublicIp) {
          i.publicIp = publicIp(c.aws);
          setDns(c.state, i.publicIp, true);
        }
        if (m?.machine) {
          m.machine.up = true;
          m.machine.publicIp = i.publicIp;
          bootServices(m);
        }
      }
    }
    changes.push({ id, prev, cur: i.state });
  }
  return changes;
}

/** Enabled services come back after a reboot / start. */
function bootServices(m: SimState) {
  if (!m.systemd) return;
  // Lazy import to keep this module free of systemd's internals.
  for (const [name, rt] of Object.entries(m.systemd.units)) {
    if (rt.enabled && rt.active !== 'active') {
      try {
        machineShell(m).run(`systemctl start ${name}`);
      } catch {
        /* ignore */
      }
    }
  }
}

// ------------------------------------------------------------------ volumes & addresses

export function createVolume(c: Caller, size: number, az: string, type = 'gp3', tags: Tags = {}) {
  authorize(c, 'ec2:CreateVolume', 'CreateVolume');
  const v = { id: newId(c.aws, 'vol'), size, type, az, state: 'available' as const, tags, region: c.region, created: c.state.clock };
  c.aws.volumes.push(v);
  return v;
}

export function deleteVolume(c: Caller, id: string) {
  const op = 'DeleteVolume';
  authorize(c, 'ec2:DeleteVolume', op);
  const v = c.aws.volumes.find((x) => x.id === id && x.region === c.region);
  if (!v) throw new AwsError('InvalidVolume.NotFound', `The volume '${id}' does not exist.`, op);
  if (v.state === 'in-use') throw new AwsError('VolumeInUse', `Volume ${id} is currently attached to ${v.attachedTo}`, op);
  c.aws.volumes = c.aws.volumes.filter((x) => x !== v);
}

export function allocateAddress(c: Caller, tags: Tags = {}) {
  authorize(c, 'ec2:AllocateAddress', 'AllocateAddress');
  const a = { allocationId: newId(c.aws, 'eipalloc'), publicIp: publicIp(c.aws), tags, region: c.region } as { allocationId: string; publicIp: string; instanceId?: string; associationId?: string; tags: Tags; region: string };
  c.aws.addresses.push(a);
  return a;
}

export function associateAddress(c: Caller, allocationId: string, instanceId: string) {
  const op = 'AssociateAddress';
  authorize(c, 'ec2:AssociateAddress', op);
  const a = c.aws.addresses.find((x) => x.allocationId === allocationId);
  if (!a) throw new AwsError('InvalidAllocationID.NotFound', `The allocation ID '${allocationId}' does not exist`, op);
  const i = instanceOf(c, instanceId, op);
  setDns(c.state, i.publicIp, false);
  i.publicIp = a.publicIp;
  setDns(c.state, i.publicIp, true);
  const m = c.state.machines?.[i.machine];
  if (m?.machine) m.machine.publicIp = a.publicIp;
  a.instanceId = instanceId;
  a.associationId = newId(c.aws, 'eipassoc');
  return a.associationId;
}

export function releaseAddress(c: Caller, allocationId: string) {
  const op = 'ReleaseAddress';
  authorize(c, 'ec2:ReleaseAddress', op);
  const a = c.aws.addresses.find((x) => x.allocationId === allocationId);
  if (!a) throw new AwsError('InvalidAllocationID.NotFound', `The allocation ID '${allocationId}' does not exist`, op);
  if (a.instanceId) throw new AwsError('InvalidIPAddress.InUse', `Address ${a.publicIp} is in use.`, op);
  c.aws.addresses = c.aws.addresses.filter((x) => x !== a);
}

/** Monthly cost estimate of what's running (for cleanup missions). */
export function monthlyCost(aws: AwsState): number {
  let usd = 0;
  for (const i of aws.instances) if (i.state === 'running' || i.state === 'pending') usd += INSTANCE_TYPES[i.type].hourly * 730;
  for (const v of aws.volumes) usd += v.size * 0.08;
  usd += aws.addresses.length * 3.65;
  return Math.round(usd * 100) / 100;
}
