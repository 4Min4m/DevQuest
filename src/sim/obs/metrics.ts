/** Metric time series computed from their models: counters integrate rates, histograms follow a log-normal latency. */
import { clusterOf, getObj } from '../kube/cluster';
import type { SimState } from '../state';
import { Vfs } from '../vfs/vfs';
import type { ObsState, Phase, Pred, SeriesSpec } from './types';

export type Labels = Record<string, string>;
export interface Sample {
  labels: Labels;
  value: number;
}

export const SCRAPE = 15;
export const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** How far back series exist (seconds before the mission start). */
const HISTORY = 6 * 3600;

function evalPred(state: SimState, p: Pred): boolean {
  if ('not' in p) return !evalPred(state, p.not);
  if ('unitActive' in p) {
    const n = p.unitActive.includes('.') ? p.unitActive : `${p.unitActive}.service`;
    return state.systemd?.units[n]?.active === 'active';
  }
  if ('deploymentImage' in p) {
    try {
      const d = getObj(clusterOf(state), 'Deployment', p.deploymentImage.namespace ?? 'default', p.deploymentImage.name) as { spec?: { template?: { spec?: { containers?: { image: string }[] } } } } | undefined;
      return !!d?.spec?.template?.spec?.containers?.some((c) => c.image === p.deploymentImage.image);
    } catch {
      return false;
    }
  }
  try {
    return new Vfs(state.fs, { name: 'root', groups: ['root'] }).readFile(p.fileContains.path).includes(p.fileContains.text);
  } catch {
    return false;
  }
}

const predKey = (p: Pred) => JSON.stringify(p);

/** Record predicate truth now (call before evaluating queries). */
export function observe(state: SimState): void {
  const obs = state.obs;
  if (!obs) return;
  const preds: Pred[] = [];
  for (const s of obs.series) for (const ph of s.phases ?? []) if (ph.when) preds.push(ph.when);
  for (const l of obs.logs) if (l.repeat?.when) preds.push(l.repeat.when);
  for (const p of preds) {
    const k = predKey(p);
    const log = (obs.predLog[k] ??= []);
    const v = evalPred(state, p);
    if (!log.length) log.push({ at: obs.epoch - HISTORY * 1000, v });
    else if (log[log.length - 1].v !== v) log.push({ at: Math.max(state.clock, log[log.length - 1].at + 1), v });
  }
}

/** Truth of a predicate at time t (ms). */
export function predAt(obs: ObsState, p: Pred, t: number): boolean {
  const log = obs.predLog[predKey(p)] ?? [];
  let v = log[0]?.v ?? false;
  for (const e of log) if (e.at <= t) v = e.v;
  return v;
}

/** Breakpoints (ms) where the effective phase may change. */
function breaks(obs: ObsState, s: SeriesSpec): number[] {
  const out: number[] = [];
  for (const ph of s.phases ?? []) {
    if (ph.from !== undefined) out.push(obs.epoch + ph.from * 1000);
    if (ph.when) for (const e of obs.predLog[predKey(ph.when)] ?? []) out.push(e.at);
  }
  return out;
}

/** The parameters in force at time t. */
function paramsAt(obs: ObsState, s: SeriesSpec, t: number): Phase {
  let cur: Phase = { rate: s.rate, value: s.value, latency: s.latency };
  for (const ph of s.phases ?? []) {
    if (ph.from !== undefined && obs.epoch + ph.from * 1000 > t) continue;
    if (ph.when && !predAt(obs, ph.when, t)) continue;
    cur = { ...cur, ...Object.fromEntries(Object.entries(ph).filter(([k]) => !['from', 'when'].includes(k))) };
  }
  return cur;
}

/** ∫ f(params(t)) dt from the start of history to t (seconds). */
function integrate(obs: ObsState, s: SeriesSpec, t: number, f: (p: Phase) => number): number {
  const start = obs.epoch - HISTORY * 1000;
  if (t <= start) return 0;
  const pts = [start, ...breaks(obs, s).filter((b) => b > start && b < t).sort((a, b) => a - b), t];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += (f(paramsAt(obs, s, pts[i])) * (pts[i + 1] - pts[i])) / 1000;
  return total;
}

function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

/** Fraction of requests faster than x for a log-normal through p50/p99. */
export function cdf(lat: { p50: number; p99: number }, x: number): number {
  const mu = Math.log(lat.p50);
  const sigma = Math.max(1e-6, (Math.log(lat.p99) - mu) / 2.3263);
  return 0.5 * (1 + erf((Math.log(x) - mu) / (sigma * Math.SQRT2)));
}

function jitter(seed: string, t: number, amount: number): number {
  let h = 2166136261;
  for (const c of seed + Math.floor(t / 15000)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return 1 + ((h % 2000) / 1000 - 1) * amount;
}

/** Every concrete series (histograms expand to _bucket/_sum/_count) with its value at time t (ms). */
export function samplesAt(state: SimState, t: number): Sample[] {
  const obs = state.obs;
  if (!obs) return [];
  const out: Sample[] = [];
  if (t < obs.epoch - HISTORY * 1000) return out;
  for (const s of obs.series) {
    const base = { ...(s.labels ?? {}) };
    if (s.type === 'gauge') {
      const p = paramsAt(obs, s, t);
      if (p.value === undefined || Number.isNaN(p.value)) continue;
      const v = p.value * jitter(s.name + JSON.stringify(base), t, s.noise ?? (Number.isInteger(p.value) && p.value <= 1 ? 0 : 0.03));
      out.push({ labels: { __name__: s.name, ...base }, value: Number.isInteger(p.value) && p.value <= 1 ? p.value : Math.round(v * 1000) / 1000 });
    } else if (s.type === 'counter') {
      out.push({ labels: { __name__: s.name, ...base }, value: Math.round(integrate(obs, s, t, (p) => p.rate ?? 0)) });
    } else {
      const lat = (p: Phase) => p.latency ?? { p50: 0.1, p99: 0.5 };
      for (const le of [...BUCKETS, Infinity]) {
        const v = integrate(obs, s, t, (p) => (p.rate ?? 0) * (le === Infinity ? 1 : cdf(lat(p), le)));
        out.push({ labels: { __name__: `${s.name}_bucket`, ...base, le: le === Infinity ? '+Inf' : String(le) }, value: Math.round(v) });
      }
      out.push({ labels: { __name__: `${s.name}_count`, ...base }, value: Math.round(integrate(obs, s, t, (p) => p.rate ?? 0)) });
      out.push({ labels: { __name__: `${s.name}_sum`, ...base }, value: Math.round(integrate(obs, s, t, (p) => { const l = lat(p); const mu = Math.log(l.p50); const sg = (Math.log(l.p99) - mu) / 2.3263; return (p.rate ?? 0) * Math.exp(mu + (sg * sg) / 2); }) * 1000) / 1000 });
    }
  }
  return out;
}
