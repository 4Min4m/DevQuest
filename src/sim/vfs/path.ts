/** POSIX-style path helpers. All returned absolute paths are normalized. */

export function splitPath(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

/** Collapse `.`, `..` and duplicate slashes in an absolute path. */
export function normalize(abs: string): string {
  const out: string[] = [];
  for (const seg of splitPath(abs)) {
    if (seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

/** Resolve `p` against `cwd`. Does not expand `~` (the shell does that). */
export function resolvePath(cwd: string, p: string): string {
  if (p.startsWith('/')) return normalize(p);
  return normalize(cwd + '/' + p);
}

export function dirname(abs: string): string {
  const parts = splitPath(abs);
  parts.pop();
  return '/' + parts.join('/');
}

export function basename(p: string): string {
  const parts = splitPath(p);
  return parts.length ? parts[parts.length - 1] : '/';
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir + '/' + name;
}

/** Display a path relative to home as `~/...` (used by the prompt). */
export function tildify(abs: string, home: string): string {
  if (abs === home) return '~';
  if (home !== '/' && abs.startsWith(home + '/')) return '~' + abs.slice(home.length);
  return abs;
}

/** True when `child` is `parent` or lives somewhere below it. */
export function isWithin(child: string, parent: string): boolean {
  return child === parent || (parent === '/' ? true : child.startsWith(parent + '/'));
}
