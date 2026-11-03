/**
 * Virtual filesystem node types. Everything here is plain, JSON-serializable data
 * so a mission can ship a pre-built filesystem as part of its `initialState`.
 */

export interface NodeMeta {
  /** Permission bits only, e.g. 0o644. */
  mode: number;
  owner: string;
  group: string;
  /** Modification time, ms since epoch. */
  mtime: number;
}

export interface FileNode extends NodeMeta {
  type: 'file';
  content: string;
}

export interface DirNode extends NodeMeta {
  type: 'dir';
  children: Record<string, FsNode>;
}

export type FsNode = FileNode | DirNode;

export type VfsErrorCode =
  | 'ENOENT'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EEXIST'
  | 'EACCES'
  | 'EPERM'
  | 'ENOTEMPTY'
  | 'EINVAL';

/** Human messages exactly as libc's strerror() prints them. */
export const ERROR_MESSAGES: Record<VfsErrorCode, string> = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EEXIST: 'File exists',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  ENOTEMPTY: 'Directory not empty',
  EINVAL: 'Invalid argument',
};

export class VfsError extends Error {
  constructor(
    public readonly code: VfsErrorCode,
    public readonly path: string,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'VfsError';
  }
}

export function isVfsError(e: unknown): e is VfsError {
  return e instanceof VfsError;
}
