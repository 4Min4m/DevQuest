/** Disk accounting: usage per mount (blocks and inodes) derived from the simulated files. */
import type { Disk, SimState } from './state';
import { isWithin, joinPath } from './vfs/path';
import type { FsNode } from './vfs/types';
import { nodeSize, SpaceGuard } from './vfs/vfs';

export function mountFor(disks: Disk[], abs: string): Disk | undefined {
  return [...disks].sort((a, b) => b.mount.length - a.mount.length).find((d) => isWithin(abs, d.mount));
}

function nodeAt(state: SimState, path: string): FsNode | undefined {
  let node: FsNode = state.fs;
  for (const seg of path.split('/').filter(Boolean)) {
    if (node.type !== 'dir') return undefined;
    node = node.children[seg];
    if (!node) return undefined;
  }
  return node;
}

export interface DiskUsage {
  sizeKb: number;
  usedKb: number;
  availKb: number;
  inodes: number;
  inodesUsed: number;
}

/** Usage of one disk: its base figures plus everything stored under its mount point. */
export function diskUsage(state: SimState, disk: Disk): DiskUsage {
  const otherMounts = state.disks.map((d) => d.mount).filter((m) => m !== disk.mount && isWithin(m, disk.mount));
  let bytes = 0;
  let nodes = 0;
  const walk = (path: string, node: FsNode) => {
    if (path !== disk.mount && otherMounts.includes(path)) return;
    nodes++;
    if (node.type === 'file') bytes += Math.ceil(nodeSize(node) / 4096) * 4096;
    else for (const [name, child] of Object.entries(node.children)) walk(joinPath(path, name), child);
  };
  const root = nodeAt(state, disk.mount);
  if (root) walk(disk.mount, root);
  const usedKb = Math.min(disk.size, disk.used + Math.ceil(bytes / 1024));
  const inodes = disk.inodes ?? 0;
  return {
    sizeKb: disk.size,
    usedKb,
    availKb: Math.max(0, disk.size - usedKb),
    inodes,
    inodesUsed: Math.min(inodes, (disk.inodesUsed ?? 0) + nodes),
  };
}

/** VFS hook: refuse new inodes or bytes when the target disk is full. */
export function spaceGuard(state: SimState): SpaceGuard {
  return (path, need) => {
    const disk = mountFor(state.disks, path);
    if (!disk) return true;
    const u = diskUsage(state, disk);
    if (need.inodes > 0 && disk.inodes !== undefined && u.inodesUsed + need.inodes > u.inodes) return false;
    if (need.bytes > 0 && u.availKb * 1024 < need.bytes) return false;
    return true;
  };
}
