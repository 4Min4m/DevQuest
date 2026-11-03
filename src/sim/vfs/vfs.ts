import { basename, dirname, joinPath, splitPath } from './path';
import { DirNode, FileNode, FsNode, VfsError } from './types';

export interface Identity {
  name: string;
  /** All groups the user belongs to (primary group first). */
  groups: string[];
}

export const UMASK = 0o022;
export const DIR_SIZE = 4096;

const R = 4;
const W = 2;
const X = 1;

export function makeDir(owner: string, group: string, mtime: number, mode = 0o755): DirNode {
  return { type: 'dir', mode, owner, group, mtime, children: {} };
}

export function makeFile(
  content: string,
  owner: string,
  group: string,
  mtime: number,
  mode = 0o644,
): FileNode {
  return { type: 'file', mode, owner, group, mtime, content };
}

export function nodeSize(node: FsNode): number {
  return node.type === 'dir' ? DIR_SIZE : new TextEncoder().encode(node.content).length;
}

export function cloneNode<T extends FsNode>(node: T): T {
  return structuredClone(node);
}

/**
 * Operations over a filesystem tree on behalf of one user.
 * Paths passed in must be absolute and normalized (see `resolvePath`).
 * Every failure throws a `VfsError` carrying the errno-style code.
 */
export class Vfs {
  constructor(
    public readonly root: DirNode,
    public readonly user: Identity,
    private readonly now: () => number = Date.now,
  ) {}

  get isRoot(): boolean {
    return this.user.name === 'root';
  }

  /** Does the current user have the given permission bit (r=4, w=2, x=1) on `node`? */
  can(node: FsNode, bit: number): boolean {
    if (this.isRoot) {
      // root bypasses rwx, except it still needs at least one x bit to execute a file.
      return bit !== X || node.type === 'dir' || (node.mode & 0o111) !== 0;
    }
    let bits: number;
    if (node.owner === this.user.name) bits = (node.mode >> 6) & 7;
    else if (this.user.groups.includes(node.group)) bits = (node.mode >> 3) & 7;
    else bits = node.mode & 7;
    return (bits & bit) !== 0;
  }

  // ---------- lookup ----------

  /** Return the node at `path`, enforcing search (x) permission on every ancestor. */
  lookup(path: string): FsNode {
    let node: FsNode = this.root;
    for (const seg of splitPath(path)) {
      if (node.type !== 'dir') throw new VfsError('ENOTDIR', path);
      if (!this.can(node, X)) throw new VfsError('EACCES', path);
      const next: FsNode | undefined = node.children[seg];
      if (!next) throw new VfsError('ENOENT', path);
      node = next;
    }
    return node;
  }

  exists(path: string): boolean {
    try {
      this.lookup(path);
      return true;
    } catch {
      return false;
    }
  }

  stat(path: string): FsNode {
    return this.lookup(path);
  }

  isDir(path: string): boolean {
    try {
      return this.lookup(path).type === 'dir';
    } catch {
      return false;
    }
  }

  /** Look up the parent directory of `path`, for creating or removing entries. */
  private parentDir(path: string): DirNode {
    const parent = this.lookup(dirname(path));
    if (parent.type !== 'dir') throw new VfsError('ENOTDIR', path);
    return parent;
  }

  private requireWritableDir(dir: DirNode, path: string): void {
    if (!this.can(dir, W) || !this.can(dir, X)) throw new VfsError('EACCES', path);
  }

  // ---------- files ----------

  readFile(path: string): string {
    const node = this.lookup(path);
    if (node.type === 'dir') throw new VfsError('EISDIR', path);
    if (!this.can(node, R)) throw new VfsError('EACCES', path);
    return node.content;
  }

  writeFile(path: string, content: string, opts: { append?: boolean } = {}): void {
    const parent = this.parentDir(path);
    const name = basename(path);
    const existing = parent.children[name];
    if (existing) {
      if (existing.type === 'dir') throw new VfsError('EISDIR', path);
      if (!this.can(existing, W)) throw new VfsError('EACCES', path);
      existing.content = opts.append ? existing.content + content : content;
      existing.mtime = this.now();
      return;
    }
    this.requireWritableDir(parent, path);
    parent.children[name] = makeFile(
      content,
      this.user.name,
      this.user.groups[0],
      this.now(),
      0o666 & ~UMASK,
    );
    parent.mtime = this.now();
  }

  /** `touch`: create an empty file, or bump mtime of an existing node. */
  touch(path: string): void {
    const parent = this.parentDir(path);
    const existing = parent.children[basename(path)];
    if (existing) {
      if (!this.can(existing, W) && existing.owner !== this.user.name && !this.isRoot) {
        throw new VfsError('EACCES', path);
      }
      existing.mtime = this.now();
      return;
    }
    this.writeFile(path, '');
  }

  // ---------- directories ----------

  readdir(path: string): string[] {
    const node = this.lookup(path);
    if (node.type !== 'dir') throw new VfsError('ENOTDIR', path);
    if (!this.can(node, R)) throw new VfsError('EACCES', path);
    return Object.keys(node.children).sort();
  }

  mkdir(path: string, opts: { parents?: boolean } = {}): void {
    if (opts.parents) {
      let cur = '/';
      const segs = splitPath(path);
      for (const [i, seg] of segs.entries()) {
        cur = joinPath(cur, seg);
        const parent = this.parentDir(cur);
        const existing = parent.children[seg];
        if (existing) {
          if (existing.type !== 'dir') throw new VfsError(i === segs.length - 1 ? 'EEXIST' : 'ENOTDIR', path);
          continue;
        }
        this.requireWritableDir(parent, cur);
        parent.children[seg] = makeDir(this.user.name, this.user.groups[0], this.now(), 0o777 & ~UMASK);
        parent.mtime = this.now();
      }
      return;
    }
    const parent = this.parentDir(path);
    const name = basename(path);
    if (parent.children[name]) throw new VfsError('EEXIST', path);
    this.requireWritableDir(parent, path);
    parent.children[name] = makeDir(this.user.name, this.user.groups[0], this.now(), 0o777 & ~UMASK);
    parent.mtime = this.now();
  }

  // ---------- structural changes ----------

  /** Remove a node. Directories need `recursive` unless empty-dir removal is requested. */
  remove(path: string, opts: { recursive?: boolean; dirOnlyIfEmpty?: boolean } = {}): void {
    if (path === '/') throw new VfsError('EPERM', path);
    const parent = this.parentDir(path);
    const name = basename(path);
    const node = parent.children[name];
    if (!node) throw new VfsError('ENOENT', path);
    if (node.type === 'dir') {
      if (opts.dirOnlyIfEmpty) {
        if (Object.keys(node.children).length > 0) throw new VfsError('ENOTEMPTY', path);
      } else if (!opts.recursive) {
        throw new VfsError('EISDIR', path);
      } else {
        // Removing a tree requires permission to empty every directory in it.
        for (const child of Object.keys(node.children)) {
          if (!this.can(node, W) || !this.can(node, X) || !this.can(node, R)) {
            throw new VfsError('EACCES', joinPath(path, child));
          }
          this.remove(joinPath(path, child), { recursive: true });
        }
      }
    }
    this.requireWritableDir(parent, path);
    delete parent.children[name];
    parent.mtime = this.now();
  }

  /** Place `node` at `path` (parent must exist; replaces an existing file). */
  insert(path: string, node: FsNode): void {
    const parent = this.parentDir(path);
    const name = basename(path);
    const existing = parent.children[name];
    if (existing && existing.type === 'dir' && node.type !== 'dir') throw new VfsError('EISDIR', path);
    if (existing && existing.type !== 'dir' && node.type === 'dir') throw new VfsError('ENOTDIR', path);
    this.requireWritableDir(parent, path);
    parent.children[name] = node;
    parent.mtime = this.now();
  }

  /** Rename/move. Caller is responsible for the "into a directory" decision. */
  move(src: string, dst: string): void {
    const srcParent = this.parentDir(src);
    const name = basename(src);
    const node = srcParent.children[name];
    if (!node) throw new VfsError('ENOENT', src);
    this.requireWritableDir(srcParent, src);
    this.insert(dst, node);
    if (srcParent.children[name] === node && src !== dst) delete srcParent.children[name];
    srcParent.mtime = this.now();
  }

  // ---------- metadata ----------

  chmod(path: string, mode: number): void {
    const node = this.lookup(path);
    if (!this.isRoot && node.owner !== this.user.name) throw new VfsError('EPERM', path);
    node.mode = mode & 0o7777;
  }

  chown(path: string, owner: string | undefined, group: string | undefined): void {
    const node = this.lookup(path);
    if (!this.isRoot) {
      // Non-root may only change the group of their own file to a group they belong to.
      const ownerChange = owner !== undefined && owner !== node.owner;
      const groupOk = group === undefined || this.user.groups.includes(group);
      if (ownerChange || node.owner !== this.user.name || !groupOk) {
        throw new VfsError('EPERM', path);
      }
    }
    if (owner !== undefined) node.owner = owner;
    if (group !== undefined) node.group = group;
  }

  /** Visit every node below (and including) `path`, depth-first, sorted. */
  walk(path: string, visit: (path: string, node: FsNode, depth: number) => void, depth = 0): void {
    const node = this.lookup(path);
    visit(path, node, depth);
    if (node.type === 'dir' && this.can(node, R) && this.can(node, X)) {
      for (const name of Object.keys(node.children).sort()) {
        this.walk(joinPath(path, name), visit, depth + 1);
      }
    }
  }
}
