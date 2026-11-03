/** Git objects with real ids: the same content gets the same SHA as in real Git. */
import { concatBytes, hexToBytes, sha1, utf8 } from './sha1';
import type { AnnotatedTag, Commit, FileMode, FlatTree, ObjectStore, Person, TreeEntry } from './types';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function emptyStore(): ObjectStore {
  return { blobs: {}, trees: { [EMPTY_TREE]: [] }, commits: {}, tags: {} };
}

function hashObject(type: string, body: Uint8Array): string {
  return sha1(concatBytes([utf8(`${type} ${body.length}\0`), body]));
}

export function blobSha(content: string): string {
  return hashObject('blob', utf8(content));
}

export function writeBlob(store: ObjectStore, content: string): string {
  const sha = blobSha(content);
  store.blobs[sha] = content;
  return sha;
}

/** Git sorts tree entries by name, comparing directories as if they ended in "/". */
function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry) => (e.mode === '040000' ? e.name + '/' : e.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function writeTree(store: ObjectStore, entries: TreeEntry[]): string {
  const sorted = sortEntries(entries);
  const body = concatBytes(
    sorted.flatMap((e) => [utf8(`${e.mode === '040000' ? '40000' : e.mode} ${e.name}\0`), hexToBytes(e.sha)]),
  );
  const sha = hashObject('tree', body);
  store.trees[sha] = sorted;
  return sha;
}

/** Build (and store) the nested trees for a flat path → blob map. Returns the root tree id. */
export function treeFromFlat(store: ObjectStore, flat: FlatTree): string {
  interface Dir {
    files: TreeEntry[];
    dirs: Record<string, Dir>;
  }
  const root: Dir = { files: [], dirs: {} };
  for (const [path, { sha, mode }] of Object.entries(flat)) {
    const parts = path.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) d = d.dirs[p] ??= { files: [], dirs: {} };
    d.files.push({ name: parts[parts.length - 1], mode, sha });
  }
  const write = (d: Dir): string =>
    writeTree(store, [...d.files, ...Object.entries(d.dirs).map(([name, sub]) => ({ name, mode: '040000' as const, sha: write(sub) }))]);
  return write(root);
}

export function flatten(store: ObjectStore, treeSha: string, prefix = '', out: FlatTree = {}): FlatTree {
  for (const e of store.trees[treeSha] ?? []) {
    const path = prefix + e.name;
    if (e.mode === '040000') flatten(store, e.sha, path + '/', out);
    else out[path] = { sha: e.sha, mode: e.mode };
  }
  return out;
}

const personLine = (p: Person) => `${p.name} <${p.email}> ${p.time} +0000`;

export function commitBody(c: Commit): string {
  const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${personLine(c.author)}`, `committer ${personLine(c.committer)}`];
  return lines.join('\n') + '\n\n' + c.message;
}

export function writeCommit(store: ObjectStore, c: Commit): string {
  const commit = { ...c, message: c.message.endsWith('\n') ? c.message : c.message + '\n' };
  const sha = hashObject('commit', utf8(commitBody(commit)));
  store.commits[sha] = commit;
  return sha;
}

export function tagBody(t: AnnotatedTag): string {
  return `object ${t.object}\ntype commit\ntag ${t.tag}\ntagger ${personLine(t.tagger)}\n\n${t.message}`;
}

export function writeTag(store: ObjectStore, t: AnnotatedTag): string {
  const tag = { ...t, message: t.message.endsWith('\n') ? t.message : t.message + '\n' };
  const sha = hashObject('tag', utf8(tagBody(tag)));
  store.tags[sha] = tag;
  return sha;
}

/** Copy a commit and everything it references (history, trees, blobs) into another store. */
export function copyReachable(from: ObjectStore, to: ObjectStore, sha: string): void {
  const stack = [sha];
  const copyTree = (t: string) => {
    if (to.trees[t] && t !== EMPTY_TREE) return;
    const entries = from.trees[t];
    if (!entries) return;
    to.trees[t] = entries;
    for (const e of entries) {
      if (e.mode === '040000') copyTree(e.sha);
      else if (from.blobs[e.sha] !== undefined) to.blobs[e.sha] = from.blobs[e.sha];
    }
  };
  while (stack.length) {
    const s = stack.pop()!;
    if (from.tags[s]) {
      to.tags[s] = from.tags[s];
      stack.push(from.tags[s].object);
      continue;
    }
    if (to.commits[s]) continue;
    const c = from.commits[s];
    if (!c) continue;
    to.commits[s] = c;
    copyTree(c.tree);
    stack.push(...c.parents);
  }
}

export const shortSha = (sha: string) => sha.slice(0, 7);

export function subject(message: string): string {
  return message.split('\n')[0];
}

export function modeOf(executable: boolean): FileMode {
  return executable ? '100755' : '100644';
}
