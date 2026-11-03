/** Kubernetes resource quantities ("250m", "1.5", "128Mi", "1G") and duration formatting. */

/** CPU in millicores. */
export function cpuMilli(q: string | number | undefined): number {
  if (q === undefined || q === null || q === '') return 0;
  const s = String(q);
  if (s.endsWith('m')) return Number(s.slice(0, -1));
  return Math.round(Number(s) * 1000);
}

const BIN: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
const DEC: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };

/** Memory in bytes. */
export function memBytes(q: string | number | undefined): number {
  if (q === undefined || q === null || q === '') return 0;
  const s = String(q);
  const m = /^([0-9.]+)([A-Za-z]*)$/.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]);
  if (!m[2]) return n;
  if (BIN[m[2]]) return n * BIN[m[2]];
  if (DEC[m[2]]) return n * DEC[m[2]];
  return NaN;
}

export function validQuantity(q: unknown): boolean {
  return /^[0-9.]+(m|k|K|M|G|T|Ki|Mi|Gi|Ti)?$/.test(String(q));
}

/** kubectl's HumanDuration ("45s", "3m12s", "2d4h", "10d"). */
export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 0) return '0s';
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 === 0 ? `${m}m` : `${m}m${s % 60}s`;
  if (m < 180) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 8) return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
  if (h < 48) return `${h}h`;
  if (h < 24 * 8) return h % 24 === 0 ? `${Math.floor(h / 24)}d` : `${Math.floor(h / 24)}d${h % 24}h`;
  if (h < 24 * 365 * 2) return `${Math.floor(h / 24)}d`;
  return `${Math.floor(h / 24 / 365)}y`;
}

/** maxSurge / maxUnavailable: an int or a percentage of `total`. */
export function intOrPercent(v: unknown, total: number, roundUp: boolean, dflt: string): number {
  const s = String(v ?? dflt);
  if (s.endsWith('%')) {
    const x = (Number(s.slice(0, -1)) / 100) * total;
    return roundUp ? Math.ceil(x) : Math.floor(x);
  }
  return Number(s);
}
