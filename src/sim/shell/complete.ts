import { resolvePath } from '../vfs/path';
import type { Vfs } from '../vfs/vfs';

export interface Completion {
  /** The new input line. */
  line: string;
  cursor: number;
  /** When ambiguous, the possible completions (to show the user). */
  candidates: string[];
}

function commonPrefix(items: string[]): string {
  if (!items.length) return '';
  let prefix = items[0];
  for (const s of items) while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

/**
 * bash-like Tab completion: the first word completes command names, later
 * words complete paths (directories get a trailing `/`, files a space).
 */
export function complete(
  line: string,
  cursor: number,
  opts: { commands: string[]; vfs: Vfs; cwd: string; home: string },
): Completion {
  const before = line.slice(0, cursor);
  const after = line.slice(cursor);
  const wordStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('|'), before.lastIndexOf(';'), before.lastIndexOf('&')) + 1;
  const word = before.slice(wordStart);
  const head = before.slice(0, wordStart).trimEnd();
  const isCommand = head === '' || /[|;&]$/.test(head);

  let matches: { text: string; dir: boolean }[];
  const replaceFrom = wordStart;
  if (isCommand && !word.includes('/')) {
    matches = opts.commands.filter((c) => c.startsWith(word)).map((c) => ({ text: c, dir: false }));
  } else {
    const slash = word.lastIndexOf('/');
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
    const namePart = word.slice(slash + 1);
    const expandedDir = dirPart.startsWith('~') ? opts.home + dirPart.slice(1) : dirPart;
    const abs = resolvePath(opts.cwd, expandedDir || '.');
    let names: string[] = [];
    try {
      names = opts.vfs.readdir(abs);
    } catch {
      names = [];
    }
    matches = names
      .filter((n) => n.startsWith(namePart) && (namePart.startsWith('.') || !n.startsWith('.')))
      .map((n) => ({ text: dirPart + n, dir: opts.vfs.isDir(resolvePath(abs, n)) }));
  }

  if (!matches.length) return { line, cursor, candidates: [] };
  if (matches.length === 1) {
    const m = matches[0];
    const insert = m.text + (m.dir ? '/' : ' ');
    const newBefore = before.slice(0, replaceFrom) + insert;
    return { line: newBefore + after, cursor: newBefore.length, candidates: [] };
  }
  const prefix = commonPrefix(matches.map((m) => m.text));
  const newBefore = before.slice(0, replaceFrom) + prefix;
  const display = matches.map((m) => {
    const base = m.text.slice(m.text.lastIndexOf('/', m.text.length - 1) + 1);
    return base + (m.dir ? '/' : '');
  });
  return {
    line: newBefore + after,
    cursor: newBefore.length,
    candidates: prefix.length > word.length ? [] : display,
  };
}
