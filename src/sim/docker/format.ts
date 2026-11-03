/** Formatting helpers that reproduce the docker CLI's output conventions. */

/** Deterministic pseudo-random 64-char hex id (FNV-1a based), so tests and missions are stable. */
export function hexId(seed: string): string {
  let out = '';
  let h = 0x811c9dc5;
  for (let round = 0; out.length < 64; round++) {
    const s = `${seed}#${round}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

export const shortId = (id: string) => id.slice(0, 12);

const ADJECTIVES = ['admiring', 'brave', 'clever', 'eager', 'festive', 'gallant', 'happy', 'jolly', 'keen', 'lucid', 'nifty', 'quirky', 'serene', 'vibrant', 'wizardly', 'zealous'];
const SCIENTISTS = ['babbage', 'curie', 'dijkstra', 'euclid', 'hopper', 'lamport', 'lovelace', 'noether', 'ritchie', 'shannon', 'thompson', 'torvalds', 'turing', 'wozniak'];

/** Docker-style random container name, e.g. "eager_turing". */
export function randomName(seed: number): string {
  return `${ADJECTIVES[(seed * 7) % ADJECTIVES.length]}_${SCIENTISTS[(seed * 11 + 3) % SCIENTISTS.length]}`;
}

/** go-units HumanDuration, as used by `docker ps` ("5 seconds", "About a minute", ...). */
export function humanDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return 'Less than a second';
  if (seconds === 1) return '1 second';
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return 'About a minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(seconds / 3600 + 0.5);
  if (hours === 1) return 'About an hour';
  if (hours < 48) return `${hours} hours`;
  if (hours < 24 * 7 * 2) return `${Math.floor(hours / 24)} days`;
  if (hours < 24 * 30 * 2) return `${Math.floor(hours / 24 / 7)} weeks`;
  if (hours < 24 * 365 * 2) return `${Math.floor(hours / 24 / 30)} months`;
  return `${Math.floor(seconds / 3600 / 24 / 365)} years`;
}

/** go-units HumanSizeWithPrecision(size, 3): decimal units, "192MB", "7.8MB", "13.3kB". */
export function humanSize(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${parseFloat(v.toPrecision(3))}${units[i]}`;
}

/** text/tabwriter as configured by the docker CLI: minwidth 10, padding 3. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, [...c].length + 3, 10)));
  return rows
    .map((r) =>
      r
        .map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i] - [...c].length)))
        .join('')
        .trimEnd(),
    )
    .map((l) => l + '\n')
    .join('');
}

/** Shorten like docker's stringutils.Ellipsis. */
export function ellipsis(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
}

/** RFC3339Nano-ish timestamp as docker inspect prints it. */
export function isoTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
}

/**
 * A tiny subset of Go templates for `--format`: `{{.A.B}}`, `{{json .A}}`,
 * `{{index .A "key"}}`, `{{range ...}}` is rejected clearly.
 */
export function goTemplate(template: string, data: unknown): string {
  const unescaped = template.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  return unescaped.replace(/\{\{\s*(.*?)\s*\}\}/g, (_m, expr: string) => {
    let m: RegExpExecArray | null;
    if ((m = /^json\s+(\.[\w.]*)$/.exec(expr))) return JSON.stringify(lookup(data, m[1]) ?? null);
    if ((m = /^index\s+(\.[\w.]*)\s+"([^"]+)"$/.exec(expr))) return show(lookupKey(lookup(data, m[1]), m[2]));
    if ((m = /^(\.[\w.]*)$/.exec(expr))) return show(lookup(data, m[1]));
    throw new Error(`template: unsupported in devquest: "{{${expr}}}" (supported: {{.Field}}, {{json .Field}}, {{index .Field "key"}})`);
  });
}

function lookupKey(v: unknown, key: string): unknown {
  return v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
}

function lookup(data: unknown, path: string): unknown {
  if (path === '.') return data;
  let cur: unknown = data;
  for (const k of path.slice(1).split('.')) {
    if (cur === null || typeof cur !== 'object' || !(k in (cur as object))) {
      throw new Error(`template: :1:${path.length}: executing "" at <${path}>: map has no entry for key "${k}"`);
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Go's default formatting of values in templates. */
function show(v: unknown): string {
  if (v === null || v === undefined) return '<no value>';
  if (Array.isArray(v)) return `[${v.map(show).join(' ')}]`;
  if (typeof v === 'object') {
    return `map[${Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${k}:${show(x)}`)
      .join(' ')}]`;
  }
  return String(v);
}
