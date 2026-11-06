/** Terraform state (terraform.tfstate v4), backends (local / s3) and state locks. */
import type { SimState } from '../state';
import { Vfs } from '../vfs/vfs';
import type { Attrs } from './providers';

export const TF_VERSION = '1.9.8';

export interface StateInstance {
  index_key?: number | string;
  schema_version: number;
  attributes: Attrs;
  sensitive_attributes: unknown[];
  dependencies?: string[];
}

export interface StateResource {
  module?: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  provider: string;
  instances: StateInstance[];
}

export interface StateFile {
  version: 4;
  terraform_version: string;
  serial: number;
  lineage: string;
  outputs: Record<string, { value: unknown; type: unknown; sensitive?: boolean }>;
  resources: StateResource[];
  check_results: null;
}

export function emptyState(lineage = 'b7c1d2e3-f4a5-4b6c-8d7e-9f0a1b2c3d4e'): StateFile {
  return { version: 4, terraform_version: TF_VERSION, serial: 0, lineage, outputs: {}, resources: [], check_results: null };
}

export interface Backend {
  kind: 'local' | 's3';
  describe: string;
  read(): StateFile | null;
  write(s: StateFile): void;
  lockInfo(): LockInfo | null;
  lock(info: LockInfo): void;
  unlock(): void;
}

export interface LockInfo {
  ID: string;
  Operation: string;
  Info: string;
  Who: string;
  Version: string;
  Created: string;
  Path: string;
}

export function localBackend(state: SimState, dir: string, file = 'terraform.tfstate'): Backend {
  const vfs = () => new Vfs(state.fs, { name: state.user, groups: [] }, () => state.clock);
  const path = `${dir}/${file}`;
  const lockPath = `${dir}/.terraform.tfstate.lock.info`;
  return {
    kind: 'local',
    describe: path,
    read() {
      try {
        const t = vfs().readFile(path);
        return t.trim() ? (JSON.parse(t) as StateFile) : null;
      } catch {
        return null;
      }
    },
    write(s) {
      const v = vfs();
      if (v.exists(path)) v.writeFile(`${dir}/${file}.backup`, v.readFile(path));
      v.writeFile(path, JSON.stringify(s, null, 2) + '\n');
    },
    lockInfo() {
      try {
        return JSON.parse(vfs().readFile(lockPath)) as LockInfo;
      } catch {
        return null;
      }
    },
    lock(info) {
      vfs().writeFile(lockPath, JSON.stringify(info));
    },
    unlock() {
      try {
        vfs().remove(lockPath);
      } catch {
        /* none */
      }
    },
  };
}

export class BackendError extends Error {
  constructor(public summary: string, public detail = '') {
    super(summary);
  }
}

/** The s3 backend with S3-native locking (use_lockfile): state and lock are objects in the bucket. */
export function s3Backend(state: SimState, cfg: { bucket: string; key: string; region?: string }): Backend {
  const bucket = () => {
    const b = state.aws?.buckets[cfg.bucket];
    if (!b) throw new BackendError('Failed to get existing workspaces: S3 bucket "' + cfg.bucket + '" does not exist.', `The referenced S3 bucket must have been previously created. If the S3 bucket\nwas created within the last minute, please wait for a minute or two and try\nagain.\n\nError: operation error S3: ListObjectsV2, https response error StatusCode: 404, RequestID: 4C1F, api error NoSuchBucket: The specified bucket does not exist`);
    return b;
  };
  return {
    kind: 's3',
    describe: `s3://${cfg.bucket}/${cfg.key}`,
    read() {
      const o = bucket().objects[cfg.key];
      return o ? (JSON.parse(o.body) as StateFile) : null;
    },
    write(s) {
      const b = bucket();
      const body = JSON.stringify(s, null, 2) + '\n';
      if (b.objects[cfg.key] && b.versioning === 'Enabled') ((b.versions ??= {})[cfg.key] ??= []).unshift(b.objects[cfg.key]);
      b.objects[cfg.key] = { body, modified: state.clock, etag: String(s.serial).padStart(32, '0'), contentType: 'application/json' };
    },
    lockInfo() {
      const o = bucket().objects[cfg.key + '.tflock'];
      return o ? (JSON.parse(o.body) as LockInfo) : null;
    },
    lock(info) {
      bucket().objects[cfg.key + '.tflock'] = { body: JSON.stringify(info), modified: state.clock, etag: '0'.repeat(32) };
    },
    unlock() {
      delete bucket().objects[cfg.key + '.tflock'];
    },
  };
}

export function lockDetail(info: LockInfo, s3: boolean): string {
  return `Error message: ${s3 ? 'operation error S3: PutObject, https response error StatusCode: 412, RequestID: 7A2B, api error PreconditionFailed: At least one of the pre-conditions you specified did not hold' : 'resource temporarily unavailable'}
Lock Info:
  ID:        ${info.ID}
  Path:      ${info.Path}
  Operation: ${info.Operation}
  Who:       ${info.Who}
  Version:   ${info.Version}
  Created:   ${info.Created}
  Info:      ${info.Info}


Terraform acquires a state lock to protect the state from being written
by multiple users at the same time. Please resolve the issue above and try
again. For most commands, you can disable locking with the "-lock=false"
flag, but this is not recommended.`;
}

