/**
 * Docker Compose (v2) on top of the simulated engine: project loading and
 * validation, plus up/down orchestration.
 */
import { parse, YAMLParseError } from 'yaml';
import type { SimState } from '../state';
import { basename, joinPath, resolvePath } from '../vfs/path';
import { Vfs } from '../vfs/vfs';
import { DockerEngine } from './engine';
import { hexId } from './format';
import type { Container, Image, RestartPolicy } from './types';

export class ComposeError extends Error {}

export interface ServiceSpec {
  name: string;
  image?: string;
  build?: { context: string; dockerfile: string };
  ports: string[];
  environment: string[];
  volumes: string[];
  dependsOn: string[];
  restart: RestartPolicy;
  command?: string[];
  entrypoint?: string[];
  networks: string[];
  containerName?: string;
  workingDir?: string;
}

export interface Project {
  name: string;
  dir: string;
  file: string;
  services: ServiceSpec[];
  volumes: string[];
  networks: string[];
  warnings: string[];
}

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

const SERVICE_KEYS = new Set([
  'image', 'build', 'ports', 'environment', 'volumes', 'depends_on', 'restart', 'command', 'entrypoint',
  'networks', 'container_name', 'working_dir', 'expose', 'healthcheck', 'labels', 'env_file', 'stdin_open', 'tty',
]);
const TOP_KEYS = new Set(['version', 'name', 'services', 'volumes', 'networks']);

const ROOT = { name: 'root', groups: ['root'] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Split a command string like a shell would (quotes, no expansion). */
export function shellSplit(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function toList(v: unknown, what: string, file: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ComposeError(`validating ${file}: ${what} must be a array`);
  return v.map((x) => {
    if (typeof x === 'object') throw new ComposeError(`devquest: the long syntax for ${what} is not supported yet — use the short "a:b" form`);
    return String(x);
  });
}

function sanitizeName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/** Find, parse and validate the compose file in `cwd` (or `-f file`). */
export function loadProject(host: SimState, cwd: string, fileOpt?: string, nameOpt?: string): Project {
  const vfs = new Vfs(host.fs, ROOT);
  let file: string | undefined;
  if (fileOpt) {
    file = resolvePath(cwd, fileOpt);
    if (!vfs.exists(file)) throw new ComposeError(`open ${file}: no such file or directory`);
  } else {
    file = COMPOSE_FILES.map((f) => joinPath(cwd, f)).find((f) => vfs.exists(f));
    if (!file) throw new ComposeError('no configuration file provided: not found');
  }
  let data: unknown;
  try {
    data = parse(vfs.readFile(file));
  } catch (e) {
    if (e instanceof YAMLParseError) {
      throw new ComposeError(`yaml: line ${e.linePos?.[0]?.line ?? 1}: ${e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')}`);
    }
    throw e;
  }
  if (!isObj(data)) throw new ComposeError(`validating ${file}: (root) must be a mapping`);
  const warnings: string[] = [];
  for (const k of Object.keys(data)) {
    if (!TOP_KEYS.has(k)) throw new ComposeError(`validating ${file}: additional properties '${k}' not allowed`);
  }
  if ('version' in data) {
    warnings.push(`WARN[0000] ${file}: the attribute \`version\` is obsolete, it will be ignored, please remove it to avoid potential confusion`);
  }
  if (!isObj(data.services)) throw new ComposeError(`validating ${file}: services must be a mapping`);
  const dir = file.replace(/\/[^/]+$/, '') || '/';
  const name = sanitizeName(nameOpt ?? (typeof data.name === 'string' ? data.name : basename(dir)));
  const topVolumes = isObj(data.volumes) ? Object.keys(data.volumes) : [];
  const topNetworks = isObj(data.networks) ? Object.keys(data.networks) : [];

  const services: ServiceSpec[] = Object.entries(data.services).map(([svc, raw]) => {
    if (!isObj(raw)) throw new ComposeError(`validating ${file}: services.${svc} must be a mapping`);
    for (const k of Object.keys(raw)) {
      if (!SERVICE_KEYS.has(k)) throw new ComposeError(`validating ${file}: services.${svc} additional properties '${k}' not allowed`);
    }
    if (raw.env_file !== undefined) throw new ComposeError(`devquest: env_file is not supported yet — list variables under "environment:" instead`);
    let build: ServiceSpec['build'];
    if (typeof raw.build === 'string') build = { context: resolvePath(dir, raw.build), dockerfile: 'Dockerfile' };
    else if (isObj(raw.build)) {
      build = { context: resolvePath(dir, String(raw.build.context ?? '.')), dockerfile: String(raw.build.dockerfile ?? 'Dockerfile') };
    }
    if (!raw.image && !build) {
      throw new ComposeError(`service "${svc}" has neither an image nor a build context specified: invalid compose project`);
    }
    let environment: string[] = [];
    if (Array.isArray(raw.environment)) environment = raw.environment.map(String);
    else if (isObj(raw.environment)) {
      environment = Object.entries(raw.environment).map(([k, v]) => (v === null || v === undefined ? k : `${k}=${String(v)}`));
    }
    environment = environment.flatMap((e) => (e.includes('=') ? [e] : host.vars[e] !== undefined ? [`${e}=${host.vars[e]}`] : []));
    const volumes = toList(raw.volumes, `services.${svc}.volumes`, file).map((v) => {
      const [src, target, ...rest] = v.split(':');
      if (target === undefined) return v; // anonymous volume
      if (src.startsWith('.') || src.startsWith('/') || src.startsWith('~')) {
        const abs = src.startsWith('~') ? host.vars.HOME + src.slice(1) : resolvePath(dir, src);
        return [abs, target, ...rest].join(':');
      }
      if (!topVolumes.includes(src)) throw new ComposeError(`service "${svc}" refers to undefined volume ${src}: invalid compose project`);
      return [`${name}_${src}`, target, ...rest].join(':');
    });
    const dependsOn = Array.isArray(raw.depends_on) ? raw.depends_on.map(String) : isObj(raw.depends_on) ? Object.keys(raw.depends_on) : [];
    const networks = Array.isArray(raw.networks) ? raw.networks.map(String) : isObj(raw.networks) ? Object.keys(raw.networks) : [];
    for (const n of networks) {
      if (!topNetworks.includes(n) && n !== 'default') throw new ComposeError(`service "${svc}" refers to undefined network ${n}: invalid compose project`);
    }
    const restart = String(raw.restart ?? 'no').split(':')[0];
    if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(restart)) {
      throw new ComposeError(`validating ${file}: services.${svc}.restart invalid restart policy: ${restart}`);
    }
    const cmd = raw.command === undefined ? undefined : Array.isArray(raw.command) ? raw.command.map(String) : shellSplit(String(raw.command));
    const entrypoint = raw.entrypoint === undefined ? undefined : Array.isArray(raw.entrypoint) ? raw.entrypoint.map(String) : shellSplit(String(raw.entrypoint));
    return {
      name: svc,
      image: raw.image === undefined ? undefined : String(raw.image),
      build,
      ports: toList(raw.ports, `services.${svc}.ports`, file),
      environment,
      volumes,
      dependsOn,
      restart: restart as RestartPolicy,
      command: cmd,
      entrypoint,
      networks,
      containerName: raw.container_name === undefined ? undefined : String(raw.container_name),
      workingDir: raw.working_dir === undefined ? undefined : String(raw.working_dir),
    };
  });

  for (const s of services) {
    for (const d of s.dependsOn) {
      if (!services.some((x) => x.name === d)) throw new ComposeError(`service "${s.name}" depends on undefined service "${d}": invalid compose project`);
    }
  }
  return { name, dir, file, services: orderServices(services), volumes: topVolumes, networks: topNetworks, warnings };
}

/** depends_on first (topological order); cycles are reported like compose does. */
function orderServices(services: ServiceSpec[]): ServiceSpec[] {
  const out: ServiceSpec[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: ServiceSpec, path: string[]) => {
    if (state.get(s.name) === 'done') return;
    if (state.get(s.name) === 'visiting') throw new ComposeError(`dependency cycle detected: ${[...path, s.name].join(' -> ')}`);
    state.set(s.name, 'visiting');
    for (const d of s.dependsOn) visit(services.find((x) => x.name === d)!, [...path, s.name]);
    state.set(s.name, 'done');
    out.push(s);
  };
  for (const s of services) visit(s, []);
  return out;
}

export const LABEL_PROJECT = 'com.docker.compose.project';
export const LABEL_SERVICE = 'com.docker.compose.service';
export const LABEL_HASH = 'com.docker.compose.config-hash';

export function projectContainers(engine: DockerEngine, project: string, service?: string): Container[] {
  return engine.d.containers.filter((c) => c.labels[LABEL_PROJECT] === project && (!service || c.labels[LABEL_SERVICE] === service));
}

export function containerNameFor(project: Project, s: ServiceSpec): string {
  return s.containerName ?? `${project.name}-${s.name}-1`;
}

export function imageNameFor(project: Project, s: ServiceSpec): string {
  return s.image ?? `${project.name}-${s.name}`;
}

/** Status line in compose's progress style. */
export function progressLine(kind: string, name: string, status: string, width: number): string {
  return ` ✔ ${`${kind} ${name}`.padEnd(width)}  ${status}`;
}

export interface UpHooks {
  build(project: Project, s: ServiceSpec): Image;
  ensureImage(ref: string): { image: Image; pulled: boolean };
}

/** `docker compose up`: create networks/volumes and (re)create containers as needed. */
export function composeUp(
  engine: DockerEngine,
  project: Project,
  hooks: UpHooks,
  opts: { forceBuild: boolean; only?: string[] },
  emit: (line: string) => void,
): Container[] {
  // Progress lines are printed as they happen, so a failure still shows what was done.
  const lines = { push: emit };
  const width = Math.max(...project.services.map((s) => `Container ${containerNameFor(project, s)}`.length), `Network ${project.name}_default`.length) + 1;
  const defaultNet = `${project.name}_default`;
  emit(`[+] Running ${project.services.length + (engine.findNetwork(defaultNet) ? 0 : 1)}/${project.services.length + (engine.findNetwork(defaultNet) ? 0 : 1)}`);
  const neededNetworks = [defaultNet, ...project.networks.map((n) => `${project.name}_${n}`)];
  for (const n of neededNetworks) {
    if (!engine.findNetwork(n)) {
      engine.createNetwork(n);
      lines.push(progressLine('Network', n, 'Created', width));
    }
  }
  for (const v of project.volumes) {
    const full = `${project.name}_${v}`;
    if (!engine.findVolume(full)) {
      engine.createVolume(full);
      lines.push(progressLine('Volume', `"${full}"`, 'Created', width));
    }
  }
  const started: Container[] = [];
  const services = opts.only?.length ? project.services.filter((s) => opts.only!.includes(s.name) || opts.only!.some((o) => dependsTransitively(project, o, s.name))) : project.services;
  for (const s of services) {
    let image: Image;
    if (s.build && (opts.forceBuild || !engine.findImage(imageNameFor(project, s)))) {
      image = hooks.build(project, s);
      lines.push(progressLine('Service', s.name, 'Built', width));
    } else {
      const r = hooks.ensureImage(imageNameFor(project, s));
      image = r.image;
      if (r.pulled) lines.push(` ✔ ${s.name} Pulled`);
    }
    const name = containerNameFor(project, s);
    const hash = hexId(JSON.stringify(s) + image.id);
    const existing = engine.findContainer(name);
    if (existing && existing.labels[LABEL_HASH] === hash) {
      if (existing.status === 'running') {
        lines.push(progressLine('Container', name, 'Running', width));
      } else {
        engine.start(existing);
        lines.push(progressLine('Container', name, 'Started', width));
      }
      started.push(existing);
      continue;
    }
    const recreate = !!existing;
    if (existing) engine.remove(existing, { force: true });
    const networks = s.networks.length ? s.networks.map((n) => (n === 'default' ? defaultNet : `${project.name}_${n}`)) : [defaultNet];
    const entry = s.entrypoint;
    const c = engine.create(image, {
      imageRef: imageNameFor(project, s),
      name,
      cmd: entry ? [...entry.slice(1), ...(s.command ?? [])] : (s.command ?? []),
      entrypoint: entry ? entry[0] : undefined,
      env: s.environment,
      publish: s.ports,
      publishAll: false,
      volumes: s.volumes,
      restart: s.restart,
      network: networks[0],
      aliases: [s.name],
      extraNetworks: networks.slice(1).map((n) => ({ name: n, aliases: [s.name] })),
      workdir: s.workingDir,
      autoRemove: false,
      labels: { [LABEL_PROJECT]: project.name, [LABEL_SERVICE]: s.name, [LABEL_HASH]: hash, 'com.docker.compose.project.working_dir': project.dir },
    });
    if (recreate) lines.push(progressLine('Container', name, 'Recreated', width));
    engine.start(c);
    lines.push(progressLine('Container', name, 'Started', width));
    started.push(c);
  }
  return started;
}

function dependsTransitively(project: Project, from: string, target: string): boolean {
  const s = project.services.find((x) => x.name === from);
  if (!s) return false;
  return s.dependsOn.includes(target) || s.dependsOn.some((d) => dependsTransitively(project, d, target));
}

/** `docker compose down`: remove the project's containers and networks (and volumes with -v). */
export function composeDown(engine: DockerEngine, project: Project, opts: { volumes: boolean }): string[] {
  const lines: string[] = [];
  const containers = projectContainers(engine, project.name);
  const width = Math.max(10, ...containers.map((c) => `Container ${c.name}`.length), `Network ${project.name}_default`.length) + 1;
  for (const c of [...containers].reverse()) {
    engine.stop(c);
    engine.remove(c, { force: true });
    lines.push(progressLine('Container', c.name, 'Removed', width));
  }
  if (opts.volumes) {
    for (const v of project.volumes) {
      const full = `${project.name}_${v}`;
      if (engine.findVolume(full)) {
        engine.removeVolume(full);
        lines.push(progressLine('Volume', full, 'Removed', width));
      }
    }
  }
  for (const n of [`${project.name}_default`, ...project.networks.map((x) => `${project.name}_${x}`)]) {
    if (engine.findNetwork(n)) {
      engine.removeNetwork(n);
      lines.push(progressLine('Network', n, 'Removed', width));
    }
  }
  return lines.length ? [`[+] Running ${lines.length}/${lines.length}`, ...lines] : [];
}
