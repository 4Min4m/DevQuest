/** The mock AWS account: plain serializable data, shared by the aws CLI and Terraform's aws provider. */

export type Tags = Record<string, string>;

export interface S3Object {
  body: string;
  modified: number;
  etag: string;
  versionId?: string;
  contentType?: string;
}

export interface Bucket {
  name: string;
  region: string;
  created: number;
  versioning?: 'Enabled' | 'Suspended';
  /** All four Block Public Access settings (new buckets block everything). */
  blockPublic: boolean;
  policy?: string;
  website?: { index: string; error?: string };
  objects: Record<string, S3Object>;
  /** Older versions when versioning is on: key → newest first. */
  versions?: Record<string, S3Object[]>;
  tags?: Tags;
}

export interface Vpc { id: string; cidr: string; isDefault: boolean; tags: Tags; region: string; dnsHostnames?: boolean }
export interface Subnet { id: string; vpcId: string; cidr: string; az: string; mapPublicIp: boolean; tags: Tags; region: string }
export interface Igw { id: string; vpcId?: string; tags: Tags; region: string }
export interface Route { dest: string; target: string }
export interface RouteTable { id: string; vpcId: string; main: boolean; routes: Route[]; subnets: string[]; tags: Tags; region: string }
export interface SgRule { protocol: string; from: number; to: number; cidrs: string[]; groups: string[]; description?: string }
export interface SecurityGroup { id: string; name: string; description: string; vpcId: string; ingress: SgRule[]; egress: SgRule[]; tags: Tags; region: string }
export interface KeyPair { name: string; id: string; fingerprint: string; region: string }

export interface Instance {
  id: string;
  ami: string;
  type: string;
  state: 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated';
  launched: number;
  subnetId: string;
  vpcId: string;
  privateIp: string;
  publicIp?: string;
  keyName?: string;
  sgIds: string[];
  tags: Tags;
  region: string;
  az: string;
  /** Hostname key of the machine in state.machines. */
  machine: string;
  rootVolume: string;
  userData?: string;
  /** Last time it moved to running / stopped (cost reports). */
  since: number;
}

export interface Volume { id: string; size: number; type: string; az: string; state: 'available' | 'in-use'; attachedTo?: string; device?: string; tags: Tags; region: string; created: number; deleteOnTermination?: boolean }
export interface Address { allocationId: string; publicIp: string; instanceId?: string; associationId?: string; tags: Tags; region: string }

export interface IamUser { name: string; id: string; arn: string; created: number; /** Allowed actions, e.g. "s3:*", "ec2:Describe*", "*". */ allow: string[]; policies: string[] }

export interface AwsState {
  account: string;
  /** Access keys the account knows: key id → secret and user. */
  keys: Record<string, { secret: string; user: string }>;
  users: Record<string, IamUser>;
  buckets: Record<string, Bucket>;
  vpcs: Vpc[];
  subnets: Subnet[];
  igws: Igw[];
  routeTables: RouteTable[];
  securityGroups: SecurityGroup[];
  keyPairs: KeyPair[];
  instances: Instance[];
  volumes: Volume[];
  addresses: Address[];
  /** Counter for deterministic ids. */
  seq: number;
  /** API calls made (service:Operation), for validators. */
  calls: string[];
}
