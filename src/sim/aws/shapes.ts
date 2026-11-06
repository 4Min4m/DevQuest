/** API response shapes (what describe-* calls return), shared by the CLI and Terraform. */
import type { AwsState, Instance, SgRule, Tags } from './types';
import { ACCOUNT, AMIS, routeTableFor } from './api';

export const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');

export function tagList(t: Tags): { Key: string; Value: string }[] | undefined {
  const e = Object.entries(t);
  return e.length ? e.map(([Key, Value]) => ({ Key, Value })) : undefined;
}

const STATE_CODES: Record<string, number> = { pending: 0, running: 16, 'shutting-down': 32, terminated: 48, stopping: 64, stopped: 80 };
export const stateOf = (name: string) => ({ Code: STATE_CODES[name], Name: name });

export function instanceShape(aws: AwsState, i: Instance) {
  const sgs = i.sgIds.map((id) => aws.securityGroups.find((g) => g.id === id)).filter(Boolean);
  return clean({
    AmiLaunchIndex: 0,
    ImageId: i.ami,
    InstanceId: i.id,
    InstanceType: i.type,
    KeyName: i.keyName,
    LaunchTime: iso(i.launched),
    Placement: { AvailabilityZone: i.az, Tenancy: 'default' },
    PrivateDnsName: i.state === 'terminated' ? '' : `ip-${i.privateIp.replace(/\./g, '-')}.ec2.internal`,
    PrivateIpAddress: i.state === 'terminated' ? undefined : i.privateIp,
    PublicDnsName: i.publicIp ? `ec2-${i.publicIp.replace(/\./g, '-')}.compute-1.amazonaws.com` : '',
    PublicIpAddress: i.publicIp,
    State: stateOf(i.state),
    SubnetId: i.state === 'terminated' ? undefined : i.subnetId,
    VpcId: i.state === 'terminated' ? undefined : i.vpcId,
    Architecture: 'x86_64',
    BlockDeviceMappings: i.state === 'terminated' ? [] : [{ DeviceName: '/dev/sda1', Ebs: { Status: 'attached', VolumeId: i.rootVolume, DeleteOnTermination: true } }],
    SecurityGroups: i.state === 'terminated' ? [] : sgs.map((g) => ({ GroupId: g!.id, GroupName: g!.name })),
    Tags: tagList(i.tags),
  });
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function perm(r: SgRule) {
  return clean({
    IpProtocol: r.protocol,
    FromPort: r.protocol === '-1' ? undefined : r.from,
    ToPort: r.protocol === '-1' ? undefined : r.to,
    IpRanges: r.cidrs.map((c) => ({ CidrIp: c })),
    Ipv6Ranges: [],
    PrefixListIds: [],
    UserIdGroupPairs: r.groups.map((g) => ({ GroupId: g, UserId: ACCOUNT })),
  });
}

export const shapes = {
  vpc: (v: AwsState['vpcs'][number]) => clean({ CidrBlock: v.cidr, DhcpOptionsId: 'dopt-0a1b2c3d4e5f60789', State: 'available', VpcId: v.id, OwnerId: ACCOUNT, InstanceTenancy: 'default', IsDefault: v.isDefault, Tags: tagList(v.tags) }),
  subnet: (aws: AwsState, s: AwsState['subnets'][number]) => {
    const size = 2 ** (32 - Number(s.cidr.split('/')[1]));
    const used = aws.instances.filter((i) => i.subnetId === s.id && i.state !== 'terminated').length;
    return clean({ AvailabilityZone: s.az, AvailableIpAddressCount: size - 5 - used, CidrBlock: s.cidr, DefaultForAz: aws.vpcs.find((v) => v.id === s.vpcId)?.isDefault ?? false, MapPublicIpOnLaunch: s.mapPublicIp, State: 'available', SubnetId: s.id, VpcId: s.vpcId, OwnerId: ACCOUNT, Tags: tagList(s.tags) });
  },
  igw: (g: AwsState['igws'][number]) => clean({ Attachments: g.vpcId ? [{ State: 'available', VpcId: g.vpcId }] : [], InternetGatewayId: g.id, OwnerId: ACCOUNT, Tags: tagList(g.tags) ?? [] }),
  routeTable: (aws: AwsState, r: AwsState['routeTables'][number]) =>
    clean({
      Associations: [...(r.main ? [{ Main: true, RouteTableAssociationId: 'rtbassoc-' + r.id.slice(4), RouteTableId: r.id, AssociationState: { State: 'associated' } }] : []), ...r.subnets.map((s) => ({ Main: false, RouteTableAssociationId: 'rtbassoc-' + s.slice(7), RouteTableId: r.id, SubnetId: s, AssociationState: { State: 'associated' } }))],
      PropagatingVgws: [],
      RouteTableId: r.id,
      Routes: r.routes.map((x) => {
        const blackhole = x.target.startsWith('igw-') && !aws.igws.some((g) => g.id === x.target && g.vpcId === r.vpcId);
        return { DestinationCidrBlock: x.dest, GatewayId: x.target, Origin: x.target === 'local' || (r.main && x.dest === '0.0.0.0/0' && aws.vpcs.find((v) => v.id === r.vpcId)?.isDefault) ? 'CreateRouteTable' : 'CreateRoute', State: blackhole ? 'blackhole' : 'active' };
      }),
      Tags: tagList(r.tags) ?? [],
      VpcId: r.vpcId,
      OwnerId: ACCOUNT,
    }),
  sg: (g: AwsState['securityGroups'][number]) => clean({ Description: g.description, GroupName: g.name, IpPermissions: g.ingress.map(perm), OwnerId: ACCOUNT, GroupId: g.id, IpPermissionsEgress: g.egress.map(perm), VpcId: g.vpcId, Tags: tagList(g.tags) }),
  volume: (v: AwsState['volumes'][number]) =>
    clean({ Attachments: v.attachedTo ? [{ AttachTime: iso(v.created), Device: v.device, InstanceId: v.attachedTo, State: 'attached', VolumeId: v.id, DeleteOnTermination: !!v.deleteOnTermination }] : [], AvailabilityZone: v.az, CreateTime: iso(v.created), Encrypted: false, Size: v.size, SnapshotId: '', State: v.state, VolumeId: v.id, Iops: 3000, VolumeType: v.type, Tags: tagList(v.tags) }),
  address: (a: AwsState['addresses'][number]) => clean({ AllocationId: a.allocationId, AssociationId: a.associationId, Domain: 'vpc', InstanceId: a.instanceId, PublicIp: a.publicIp, PublicIpv4Pool: 'amazon', NetworkBorderGroup: a.region, Tags: tagList(a.tags) }),
  keyPair: (k: AwsState['keyPairs'][number]) => ({ KeyPairId: k.id, KeyFingerprint: k.fingerprint, KeyName: k.name, KeyType: 'rsa', Tags: [], CreateTime: '2026-11-06T09:00:00.000000+00:00' }),
  image: (id: string) => ({ Architecture: 'x86_64', CreationDate: AMIS[id].created, ImageId: id, ImageLocation: `amazon/${AMIS[id].name}`, ImageType: 'machine', Public: true, OwnerId: '099720109477', PlatformDetails: 'Linux/UNIX', State: 'available', Description: AMIS[id].description, Name: AMIS[id].name, RootDeviceName: '/dev/sda1', RootDeviceType: 'ebs', VirtualizationType: 'hvm' }),
};

/** Is `port` on `inst` reachable from the internet (the workstation)? Explains why not. */
export function internetPath(aws: AwsState, inst: Instance, port: number, from: string): string | null {
  if (inst.state !== 'running' && inst.state !== 'pending') return `instance is ${inst.state}`;
  if (!inst.publicIp) return 'instance has no public IP';
  const rt = routeTableFor(aws, inst.subnetId);
  const def = rt?.routes.find((r) => r.dest === '0.0.0.0/0');
  if (!def || !def.target.startsWith('igw-')) return 'subnet has no route to an internet gateway';
  if (!aws.igws.some((g) => g.id === def.target && g.vpcId === inst.vpcId)) return 'route points to an internet gateway that is not attached';
  const allowed = inst.sgIds.some((id) => {
    const g = aws.securityGroups.find((x) => x.id === id);
    return g?.ingress.some((r) => (r.protocol === '-1' || ((r.protocol === 'tcp' || r.protocol === '6') && port >= r.from && port <= r.to)) && r.cidrs.some((c) => inCidrSafe(from, c)));
  });
  if (!allowed) return `no security group rule allows tcp/${port}`;
  return null;
}

function inCidrSafe(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const n = (x: string) => x.split('.').reduce((a, o) => a * 256 + Number(o), 0);
  const size = 2 ** (32 - Number(bits));
  return Math.floor(n(ip) / size) === Math.floor(n(base) / size);
}
