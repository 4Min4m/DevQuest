/** Observability data for a mission: metric series and log streams are *models* (computed on demand). */

/** Something about the live system a series can depend on (so metrics react to fixes). */
export type Pred =
  | { unitActive: string }
  | { deploymentImage: { name: string; image: string; namespace?: string } }
  | { fileContains: { path: string; text: string } }
  | { not: Pred };

export interface Phase {
  /** Seconds relative to the mission start (negative = in the past). Default: since forever. */
  from?: number;
  /** Phase applies only while this holds (transitions are recorded when observed). */
  when?: Pred;
  rate?: number;
  value?: number;
  latency?: { p50: number; p99: number };
}

export interface SeriesSpec {
  name: string;
  labels?: Record<string, string>;
  type: 'counter' | 'gauge' | 'histogram';
  /** counter: per-second increase; histogram: requests per second. */
  rate?: number;
  /** gauge value. */
  value?: number;
  /** histogram latency distribution (seconds). */
  latency?: { p50: number; p99: number };
  /** Later phases override earlier ones. */
  phases?: Phase[];
  /** Relative jitter for gauges (default 0.03). */
  noise?: number;
}

export interface LogStreamSpec {
  labels: Record<string, string>;
  /** Fixed lines at relative times. */
  lines?: { at: number; line: string }[];
  /** Lines cycled every `every` seconds between `from` and `to` (relative). `{n}` = counter. */
  repeat?: { every: number; from: number; to?: number; lines: string[]; when?: Pred };
}

export interface RuleSpec {
  alert?: string;
  record?: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface ObsState {
  /** Clock (ms) when the mission started: relative times are measured from here. */
  epoch: number;
  series: SeriesSpec[];
  logs: LogStreamSpec[];
  /** Observed truth values of predicates: key → transitions (ms). */
  predLog: Record<string, { at: number; v: boolean }[]>;
  /** Rules Prometheus loaded at its last (re)start. */
  loaded?: { pid: number; groups: { name: string; rules: RuleSpec[] }[]; error?: string };
  silences: { id: string; matchers: Record<string, string>; comment: string; createdBy: string; endsAt: number; expired?: boolean }[];
}
