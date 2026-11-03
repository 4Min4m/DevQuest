/** systemd state: runtime info per unit, the journal, and what the binaries do. */

export type ActiveState = 'active' | 'inactive' | 'failed' | 'activating';

export interface UnitRuntime {
  /** e.g. "myapp.service" */
  name: string;
  active: ActiveState;
  /** running, dead, exited, auto-restart */
  sub: string;
  enabled: boolean;
  mainPid: number | null;
  /** When the current state began (ms). */
  since: number;
  /** Result of the last run: success, exit-code, ... */
  result: string;
  /** Exit status of the last failed main process (e.g. 1, 203). */
  exitStatus?: number;
  /** Unit file content as of the last daemon-reload (to detect edits). */
  loadedSource: string | null;
  restarts: number;
}

export interface JournalEntry {
  time: number;
  /** syslog identifier, e.g. "systemd" or "myapp" */
  ident: string;
  pid: number;
  unit: string;
  message: string;
  /** 3 = error, 4 = warning, 6 = info */
  priority: number;
}

/**
 * What a simulated program does when systemd runs it. Mission authors attach these
 * to executable paths; the learner only sees the program's behaviour and logs.
 */
export interface BinarySpec {
  /** Process name shown in ps/ss (defaults to the file name). */
  name?: string;
  /** Port it listens on (overridden by the env var named in `portEnv`). */
  listen?: number;
  portEnv?: string;
  /** Environment variables that must be set, or it exits 1. */
  requireEnv?: string[];
  /** Files that must exist, or it exits 1. */
  requireFiles?: string[];
  /** Needs at least this many open files (LimitNOFILE), or it fails "too many open files". */
  minNofile?: number;
  /** Connects to `${env[hostEnv]}:port` at startup; fails if the name doesn't resolve or the port is closed. */
  connect?: { hostEnv: string; port: number };
  /** Writes to this directory at startup; fails with ENOSPC if the disk is full. */
  writesTo?: string;
  /** Lines it logs when it starts successfully. */
  startLog?: string[];
  /** HTTP responses by path (default "/") when it listens. */
  http?: Record<string, { status?: number; body: string }>;
  memKb?: number;
}

export interface SystemdState {
  units: Record<string, UnitRuntime>;
  journal: JournalEntry[];
  binaries: Record<string, BinarySpec>;
}
