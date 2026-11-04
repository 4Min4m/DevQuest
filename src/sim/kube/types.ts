/**
 * Simulated Kubernetes cluster. API objects are kept as plain JSON (exactly what
 * `kubectl get -o yaml` shows); kubelet bookkeeping lives next to them in `runtime`.
 */
import type { DirNode } from '../vfs/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A manifest-shaped value (the API is schemaless JSON from kubectl's point of view). */
export type J = any;

export interface Meta {
  name: string;
  namespace?: string;
  uid: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp: string;
  resourceVersion: string;
  generation?: number;
  ownerReferences?: { apiVersion: string; kind: string; name: string; uid: string; controller: boolean; blockOwnerDeletion: boolean }[];
  deletionTimestamp?: string;
  generateName?: string;
  finalizers?: string[];
}

export interface KObj {
  apiVersion: string;
  kind: string;
  metadata: Meta;
  spec?: J;
  status?: J;
  data?: Record<string, string>;
  type?: string;
  [k: string]: J;
}

/** What a container image does when it runs (catalog images map onto these too). */
export interface AppSpec {
  /** Ports the process listens on. */
  listen?: number[];
  /** Env var that overrides the (first) listen port. */
  portEnv?: string;
  /** Env vars that must be set (non-empty), or the process exits 1. */
  requireEnv?: string[];
  /** Custom message for a missing env var (default "Error: environment variable X is required"). */
  requireEnvMessage?: string;
  /** Files that must exist in the container (e.g. a mounted ConfigMap), or it exits 1. */
  requireFiles?: string[];
  /** Lines logged at startup; ${VAR} expands env, {port} the listen port. */
  logs?: string[];
  /** The process exits with this code right after logging (a crashing app). */
  exitCode?: number;
  /** Seconds after start before it exits with `exitCode` (default: immediately). */
  exitAfter?: number;
  /** Working set in MiB; above the memory limit the container is OOMKilled. */
  memMi?: number;
  /** CPU use in millicores (for kubectl top). */
  cpuM?: number;
  /** Seconds after start before the HTTP endpoints answer (slow starters). */
  warmupSec?: number;
  /** HTTP routes; bodies expand ${VAR} and {pod}. Missing route → 404. */
  http?: Record<string, { status?: number; body: string }>;
  /** Serve files from this directory (nginx / httpd style). */
  staticRoot?: string;
  /** Image defaults. */
  env?: Record<string, string>;
  /** Image ENTRYPOINT (replaced by the pod's `command`). */
  entrypoint?: string[];
  /** Image CMD (replaced by the pod's `args`). */
  cmd?: string[];
  /** A shell-like image: the command decides what happens. */
  shellImage?: boolean;
  /** Static web server log line per request (nginx access log). */
  accessLog?: boolean;
}

export interface LogLine {
  time: number;
  text: string;
}

export interface ContainerRun {
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  reason?: string;
  logs: LogLine[];
}

export interface ContainerRuntime {
  /** waiting / running / terminated */
  state: 'waiting' | 'running' | 'terminated';
  reason: string;
  message?: string;
  restartCount: number;
  runs: ContainerRun[];
  imagePulled: boolean;
  pullStartedAt?: number;
  pullFailures: number;
  /** Earliest time the next (re)start or pull may happen. */
  nextAttemptAt: number;
  ready: boolean;
  started: boolean;
  /** Probe bookkeeping. */
  liveFails: number;
  readyFails: number;
  startupOk: boolean;
  startupFails: number;
  nextProbeAt: Record<string, number>;
  /** Ports listening in the current run, and when they start answering. */
  listen: number[];
  answersFrom: number;
  /** Env the current run started with. */
  env: Record<string, string>;
}

export interface PodRuntime {
  containers: Record<string, ContainerRuntime>;
  /** Root filesystem of the pod's (first) container, for exec and static servers. */
  fs?: DirNode;
  lastMountWarn?: number;
  lastConfigWarn?: number;
}

export interface KEvent {
  namespace: string;
  /** e.g. "Pod/web-7c9f8d6b5d-x2k9p" */
  involved: { kind: string; name: string; uid: string };
  type: 'Normal' | 'Warning';
  reason: string;
  message: string;
  source: string;
  first: number;
  last: number;
  count: number;
}

export interface PortForward {
  localPort: number;
  namespace: string;
  /** pod/NAME or svc/NAME */
  target: string;
  remotePort: number;
}

export interface KubeState {
  /** All API objects by kind, keyed "namespace/name" (or "name" when cluster-scoped). */
  objects: Record<string, Record<string, KObj>>;
  runtime: Record<string, PodRuntime>;
  events: KEvent[];
  /** Image references each node already has. */
  nodeImages: Record<string, string[]>;
  /** Mission-defined images in the registry (beyond the Docker catalog). */
  images: Record<string, AppSpec>;
  currentContext: string;
  /** Namespace of the current context. */
  namespace: string;
  /** Simulation time the controllers have caught up to. */
  lastTick: number;
  seq: number;
  forwards: PortForward[];
  /** Data of PersistentVolumes, by PV name (mounted into pods by reference). */
  volumes?: Record<string, DirNode>;
  /** Extra CPU demand in millicores on workloads ("ns/name"), e.g. traffic for the HPA. */
  load?: Record<string, number>;
}
