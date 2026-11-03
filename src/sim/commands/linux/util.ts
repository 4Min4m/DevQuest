import type { CommandContext } from '../../shell/types';
import type { FsNode } from '../../vfs/types';
import { isVfsError } from '../../vfs/types';

/** The strerror() text for an error thrown by the VFS (or a generic fallback). */
export function errText(e: unknown): string {
  return isVfsError(e) ? e.message : String((e as Error)?.message ?? e);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `ls -l` timestamp: `Nov  3 09:00`, or `Jan  1  2020` for files older than ~6 months. */
export function formatLsDate(mtime: number, now: number): string {
  const d = new Date(mtime);
  const month = MONTHS[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, ' ');
  const sixMonths = 182 * 24 * 3600 * 1000;
  if (Math.abs(now - mtime) > sixMonths) return `${month} ${day}  ${d.getUTCFullYear()}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day} ${hh}:${mm}`;
}

/** `drwxr-xr-x` style mode string, including setuid/setgid/sticky bits. */
export function formatMode(node: FsNode): string {
  const m = node.mode;
  const triplet = (bits: number, special: boolean, specialChar: string) => {
    const r = bits & 4 ? 'r' : '-';
    const w = bits & 2 ? 'w' : '-';
    let x = bits & 1 ? 'x' : '-';
    if (special) x = bits & 1 ? specialChar : specialChar.toUpperCase();
    return r + w + x;
  };
  return (
    (node.type === 'dir' ? 'd' : '-') +
    triplet((m >> 6) & 7, (m & 0o4000) !== 0, 's') +
    triplet((m >> 3) & 7, (m & 0o2000) !== 0, 's') +
    triplet(m & 7, (m & 0o1000) !== 0, 't')
  );
}

/** Human-readable size like GNU `-h`: 512, 4.0K, 1.5M, 20G. */
export function humanSize(bytes: number): string {
  const units = ['K', 'M', 'G', 'T', 'P'];
  if (bytes < 1024) return String(bytes);
  let v = bytes;
  let i = -1;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // GNU rounds up, and shows one decimal below 10.
  if (v < 10) {
    const r = Math.ceil(v * 10) / 10;
    return (r >= 10 ? String(Math.ceil(v)) : r.toFixed(1)) + units[i];
  }
  return String(Math.ceil(v)) + units[i];
}

/** Split text into lines, dropping the empty string after a final newline. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function joinLines(lines: string[]): string {
  return lines.length ? lines.join('\n') + '\n' : '';
}

/**
 * Read each operand as a file (or stdin for none / `-`), the way cat/wc/sort do.
 * Errors are reported through `onError`; returns true if every input was read.
 */
export function readInputs(
  ctx: CommandContext,
  operands: string[],
  onInput: (name: string, content: string) => void,
  onError: (name: string, message: string) => void,
): boolean {
  let ok = true;
  const names = operands.length ? operands : ['-'];
  for (const name of names) {
    if (name === '-') {
      onInput('-', ctx.stdin);
      continue;
    }
    try {
      onInput(name, ctx.vfs.readFile(ctx.resolve(name)));
    } catch (e) {
      ok = false;
      onError(name, errText(e));
    }
  }
  return ok;
}

/** Right-align columns of cells (used by ls -l, df, ps). */
export function alignRows(rows: string[][], leftAligned: number[] = []): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((row) =>
    row
      .map((c, i) => {
        if (i === row.length - 1) return leftAligned.includes(i) ? c : c.padStart(widths[i]);
        return leftAligned.includes(i) ? c.padEnd(widths[i]) : c.padStart(widths[i]);
      })
      .join(' '),
  );
}
