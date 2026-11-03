import { joinPath, resolvePath } from '../vfs/path';

/** A string where each character remembers whether it may act as a glob metacharacter. */
export interface MaskedString {
  text: string;
  /** active[i] is true when text[i] came from an unquoted context. */
  active: boolean[];
}

export interface GlobFs {
  /** Entry names of a directory, or null if it can't be listed. */
  readdir(abs: string): string[] | null;
  exists(abs: string): boolean;
}

export function hasGlob(s: MaskedString): boolean {
  for (let i = 0; i < s.text.length; i++) {
    if (s.active[i] && '*?['.includes(s.text[i])) return true;
  }
  return false;
}

function escapeRe(c: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(c) ? '\\' + c : c;
}

/** Translate one path segment of a glob into an anchored RegExp. */
export function segmentToRegExp(seg: MaskedString): RegExp {
  let re = '';
  const { text, active } = seg;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!active[i]) {
      re += escapeRe(c);
    } else if (c === '*') {
      re += '.*';
    } else if (c === '?') {
      re += '.';
    } else if (c === '[') {
      const close = text.indexOf(']', i + 2);
      if (close < 0) {
        re += '\\[';
        continue;
      }
      let body = text.slice(i + 1, close);
      let neg = false;
      if (body[0] === '!' || body[0] === '^') {
        neg = true;
        body = body.slice(1);
      }
      re += '[' + (neg ? '^' : '') + body.replace(/[\\\]]/g, (m) => '\\' + m) + ']';
      i = close;
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp('^' + re + '$');
}

function splitMasked(s: MaskedString): MaskedString[] {
  const out: MaskedString[] = [];
  let cur: MaskedString = { text: '', active: [] };
  for (let i = 0; i < s.text.length; i++) {
    if (s.text[i] === '/') {
      out.push(cur);
      cur = { text: '', active: [] };
    } else {
      cur.text += s.text[i];
      cur.active.push(s.active[i]);
    }
  }
  out.push(cur);
  return out;
}

/**
 * Expand a glob pattern against the filesystem. Returns matches sorted, in the same
 * relative/absolute form the user typed, or an empty array when nothing matches
 * (bash then passes the pattern through unchanged — the caller handles that).
 */
export function expandGlob(pattern: MaskedString, cwd: string, fs: GlobFs): string[] {
  const segments = splitMasked(pattern);
  const absolute = pattern.text.startsWith('/');
  // Each candidate: what we show the user, and the absolute path behind it.
  let candidates: { shown: string; abs: string }[] = [
    { shown: absolute ? '/' : '', abs: absolute ? '/' : cwd },
  ];
  const segs = absolute ? segments.slice(1) : segments;

  segs.forEach((seg, idx) => {
    const isLast = idx === segs.length - 1;
    const join = (shown: string, name: string) =>
      shown === '' ? name : shown.endsWith('/') ? shown + name : shown + '/' + name;
    if (seg.text === '') {
      // Trailing slash: only directories survive.
      if (isLast) candidates = candidates.filter((c) => fs.readdir(c.abs) !== null).map((c) => ({ shown: c.shown + '/', abs: c.abs }));
      return;
    }
    if (!hasGlob(seg)) {
      candidates = candidates.map((c) => ({ shown: join(c.shown, seg.text), abs: resolvePath(c.abs, seg.text) }));
      return;
    }
    const re = segmentToRegExp(seg);
    const allowHidden = seg.text.startsWith('.');
    const next: { shown: string; abs: string }[] = [];
    for (const c of candidates) {
      const names = fs.readdir(c.abs);
      if (!names) continue;
      for (const name of names) {
        if (name.startsWith('.') && !allowHidden) continue;
        if (re.test(name)) next.push({ shown: join(c.shown, name), abs: joinPath(c.abs, name) });
      }
    }
    candidates = next;
  });

  return candidates
    .filter((c) => fs.exists(c.abs))
    .map((c) => c.shown)
    .sort();
}
