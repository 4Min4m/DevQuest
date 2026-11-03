/**
 * Simulated Docker engine state. Plain serializable data (plus shared object
 * references for mounted directories, which `structuredClone` preserves), so a
 * mission can start from any pre-built — even broken — Docker setup.
 */
import type { DirNode } from '../vfs/types';

export interface ImageConfig {
  entrypoint: string[];
  cmd: string[];
  env: string[];
  workdir: string;
  /** e.g. ["80/tcp"] */
  exposedPorts: string[];
}

export interface Image {
  /** sha256 hex (64 chars), without the "sha256:" prefix. */
  id: string;
  repository: string;
  tag: string;
  /** Catalog entry this image was pulled from (filesystem + behaviour template). */
  catalog?: string;
  /** Filesystem for built images; catalog images generate theirs. */
  fs?: DirNode;
  created: number;
  /** Bytes. */
  size: number;
  config: ImageConfig;
  /** Shells installed in the image (alpine: sh/ash, debian: sh/bash/dash, scratch: none). */
  shells: string[];
  /** Registry digest (hex). */
  digest: string;
  /** Commands missing from this image (see catalog). */
  lacks: string[];
}

export type ContainerStatus = 'created' | 'running' | 'paused' | 'restarting' | 'exited';

export interface PortBinding {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  proto: 'tcp' | 'udp';
}

export interface Mount {
  type: 'volume' | 'bind';
  /** Volume name or absolute host path. */
  source: string;
  target: string;
}

export interface LogLine {
  stream: 'stdout' | 'stderr';
  text: string;
  time: number;
}

export type RestartPolicy = 'no' | 'always' | 'unless-stopped' | 'on-failure';

export interface Container {
  id: string;
  name: string;
  /** Image reference as the user typed it (shown in `docker ps`). */
  image: string;
  imageId: string;
  /** Full argv of the main process (entrypoint + cmd). */
  argv: string[];
  env: string[];
  workdir: string;
  created: number;
  status: ContainerStatus;
  exitCode: number;
  startedAt: number;
  finishedAt: number;
  restartPolicy: RestartPolicy;
  restartCount: number;
  ports: PortBinding[];
  exposedPorts: string[];
  mounts: Mount[];
  /** Networks the container is attached to, with its IP (and DNS aliases) on each. */
  networks: Record<string, { ip: string; aliases?: string[] }>;
  /** e.g. com.docker.compose.project / .service */
  labels: Record<string, string>;
  autoRemove: boolean;
  logs: LogLine[];
  /** The container's own filesystem (mounted directories are spliced in by reference). */
  fs: DirNode;
  /** Ports the main process listens on inside the container. */
  listening: number[];
  /** Behaviour of the main process (see programs.ts). */
  program: string;
  /** Requests served (nginx access log uses this). */
  requests: number;
}

export interface Volume {
  name: string;
  created: number;
  data: DirNode;
  /** Anonymous volumes are removed with `docker rm -v`. */
  anonymous: boolean;
}

export interface Network {
  id: string;
  name: string;
  driver: 'bridge' | 'host' | 'null';
  /** e.g. "172.18.0" — containers get .2, .3, ... */
  subnet: string;
  created: number;
  builtin: boolean;
}

export interface DockerState {
  daemonRunning: boolean;
  images: Image[];
  containers: Container[];
  volumes: Volume[];
  networks: Network[];
  /** Counter feeding deterministic ids and names. */
  seq: number;
}
