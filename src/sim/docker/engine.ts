import type { HttpResult, Request } from '../net';
import { LOCAL_HOSTS } from '../net';
import type { ShellLike } from '../shell/types';
import type { Process, SimState } from '../state';
import { normalize, splitPath } from '../vfs/path';
import type { DirNode, FsNode } from '../vfs/types';
import { cloneNode, makeDir, Vfs } from '../vfs/vfs';
import { catalogCreated, catalogFs, findCatalog, parseRef, shellsOf } from './catalog';
import { hexId, randomName, shortId } from './format';
import { Program, ProgramContext, resolveProgram } from './programs';
import type { Container, DockerState, Image, Mount, Network, PortBinding, RestartPolicy, Volume } from './types';

/** An error the daemon reports ("Error response from daemon: ..."). */
export class DockerError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

export interface EngineHooks {
  /** Create a shell over a container's state (for `sh -c` style main processes). */
  spawn?: (state: SimState) => ShellLike;
  /** Is there a simulated Linux command with this name? */
  hasCommand?: (name: string) => boolean;
  /** Observe only: programs don't log and request counters don't move. */
  silent?: boolean;
}

export interface CreateOptions {
  imageRef: string;
  name?: string;
  /** Arguments after the image name (override CMD). */
  cmd: string[];
  entrypoint?: string;
  env: string[];
  publish: string[];
  publishAll: boolean;
  volumes: string[];
  restart: RestartPolicy;
  network?: string;
  workdir?: string;
  autoRemove: boolean;
  labels?: Record<string, string>;
  /** Extra networks to join (compose), each with DNS aliases. */
  extraNetworks?: { name: string; aliases: string[] }[];
  /** DNS aliases on the primary network. */
  aliases?: string[];
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
const ROOT = { name: 'root', groups: ['root'] };

const SIGNALS: Record<string, number> = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, TERM: 15 };

export function parseSignal(spec: string): number | null {
  if (/^\d+$/.test(spec)) return Number(spec);
  return SIGNALS[spec.toUpperCase().replace(/^SIG/, '')] ?? null;
}

function envMap(env: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const e of env) {
    const i = e.indexOf('=');
    if (i > 0) m[e.slice(0, i)] = e.slice(i + 1);
  }
  return m;
}

/** Merge env lists, later entries overriding earlier ones with the same key. */
function mergeEnv(base: string[], extra: string[]): string[] {
  const out = [...base];
  for (const e of extra) {
    const key = e.split('=')[0];
    const i = out.findIndex((x) => x.split('=')[0] === key);
    if (i >= 0) out[i] = e;
    else out.push(e);
  }
  return out;
}

/** The simulated Docker daemon, operating on `host.docker`. */
export class DockerEngine {
  constructor(
    public readonly host: SimState,
    private readonly hooks: EngineHooks = {},
  ) {
    if (!host.docker) throw new Error('this machine has no Docker engine');
  }

  get d(): DockerState {
    return this.host.docker!;
  }

  get now(): number {
    return this.host.clock;
  }

  private nextSeq(): number {
    return ++this.d.seq;
  }

  // ------------------------------------------------------------ images

  findImage(ref: string): Image | undefined {
    const id = ref.replace(/^sha256:/, '');
    if (/^[0-9a-f]{4,64}$/.test(id)) {
      const byId = this.d.images.filter((i) => i.id.startsWith(id));
      if (byId.length === 1) return byId[0];
    }
    const { repository, tag } = parseRef(ref);
    return this.d.images.find((i) => i.repository === repository && i.tag === tag);
  }

  /** Pull an image from the offline registry. Returns the progress lines docker prints. */
  pull(ref: string): { image: Image; lines: string[]; fresh: boolean } {
    const { repository, tag } = parseRef(ref);
    const cat = findCatalog(repository);
    if (!cat) {
      throw new DockerError(
        `pull access denied for ${repository}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied`,
      );
    }
    const t = cat.tags.find((x) => x.name === tag);
    if (!t) throw new DockerError(`manifest for ${repository}:${tag} not found: manifest unknown: manifest unknown`);
    const digest = hexId(`digest-${repository}-${t.size}`);
    const existing = this.findImage(`${repository}:${tag}`);
    if (existing) {
      return {
        image: existing,
        fresh: false,
        lines: [`${tag}: Pulling from ${cat.namespace ? repository : 'library/' + repository}`, `Digest: sha256:${digest}`, `Status: Image is up to date for ${repository}:${tag}`],
      };
    }
    const id = hexId(`image-${repository}-${t.size}`);
    const sharedLayers = this.d.images.some((i) => i.id === id);
    const image: Image = {
      id,
      repository,
      tag,
      catalog: repository,
      created: catalogCreated(t),
      size: t.size,
      config: structuredClone(cat.config),
      shells: shellsOf(cat, t),
      digest,
      lacks: [...cat.lacks],
    };
    this.d.images.push(image);
    const layers = sharedLayers ? [] : [0, 1, 2].slice(0, t.size > 10_000_000 ? 3 : 1).map((n) => hexId(`layer-${repository}-${t.size}-${n}`).slice(0, 12));
    return {
      image,
      fresh: true,
      lines: [
        `${tag}: Pulling from ${cat.namespace ? repository : 'library/' + repository}`,
        ...layers.map((l) => `${l}: Pull complete`),
        `Digest: sha256:${digest}`,
        `Status: Downloaded newer image for ${repository}:${tag}`,
      ],
    };
  }

  /** A fresh copy of an image's root filesystem. */
  imageFsOf(image: Image): DirNode {
    if (image.fs) return cloneNode(image.fs);
    const cat = image.catalog ? findCatalog(image.catalog) : undefined;
    const tag = cat?.tags.find((t) => t.size === image.size) ?? cat?.tags[0];
    if (!cat || !tag) return makeDir('root', 'root', image.created);
    return catalogFs(cat, tag);
  }

  /** `docker rmi`. Returns the lines docker prints. */
  removeImage(ref: string, force: boolean): string[] {
    const image = this.findImage(ref);
    if (!image) throw new DockerError(`No such image: ${ref}`);
    const users = this.d.containers.filter((c) => c.imageId === image.id);
    const running = users.find((c) => c.status === 'running' || c.status === 'restarting');
    if (running && force) {
      throw new DockerError(`conflict: unable to delete ${shortId(image.id)} (cannot be forced) - image is being used by running container ${shortId(running.id)}`);
    }
    if (users.length && !force) {
      throw new DockerError(
        `conflict: unable to remove repository reference "${ref}" (must force) - container ${shortId(users[0].id)} is using its referenced image ${shortId(image.id)}`,
      );
    }
    this.d.images = this.d.images.filter((i) => i !== image);
    const lines = [`Untagged: ${image.repository}:${image.tag}`];
    // The underlying image is only deleted once no other tag points at it.
    if (!this.d.images.some((i) => i.id === image.id)) {
      lines.push(`Untagged: ${image.repository}@sha256:${image.digest}`, `Deleted: sha256:${image.id}`);
    }
    return lines;
  }

  // ------------------------------------------------------------ containers

  /** Find by exact name or unique id prefix. */
  findContainer(ref: string): Container | undefined {
    const name = ref.replace(/^\//, '');
    const byName = this.d.containers.find((c) => c.name === name);
    if (byName) return byName;
    if (!/^[0-9a-f]+$/.test(ref)) return undefined;
    const matches = this.d.containers.filter((c) => c.id.startsWith(ref));
    if (matches.length > 1) throw new DockerError(`multiple IDs found with provided prefix: ${ref}`);
    return matches[0];
  }

  getContainer(ref: string): Container {
    const c = this.findContainer(ref);
    if (!c) throw new DockerError(`No such container: ${ref}`);
    return c;
  }

  isUp(c: Container): boolean {
    return c.status === 'running';
  }

  create(image: Image, opts: CreateOptions): Container {
    if (opts.name !== undefined) {
      if (!NAME_RE.test(opts.name)) {
        throw new DockerError(`Invalid container name (${opts.name}), only [a-zA-Z0-9][a-zA-Z0-9_.-] are allowed`, 125);
      }
      const clash = this.d.containers.find((c) => c.name === opts.name);
      if (clash) {
        throw new DockerError(
          `Conflict. The container name "/${opts.name}" is already in use by container "${clash.id}". You have to remove (or rename) that container to be able to reuse that name.`,
          125,
        );
      }
    }
    const seq = this.nextSeq();
    const id = hexId(`container-${seq}-${opts.name ?? ''}`);
    let name = opts.name;
    for (let n = seq; !name || this.d.containers.some((c) => c.name === name); n++) name = randomName(n);

    const argv =
      opts.entrypoint !== undefined
        ? [...(opts.entrypoint ? [opts.entrypoint] : []), ...opts.cmd]
        : [...image.config.entrypoint, ...(opts.cmd.length ? opts.cmd : image.config.cmd)];

    const ports = this.parsePorts(opts.publish, opts.publishAll ? image.config.exposedPorts : []);

    const netName = opts.network ?? 'bridge';
    const network = this.findNetwork(netName);
    if (!network) throw new DockerError(`network ${netName} not found`, 125);

    const fs = this.imageFsOf(image);
    const workdir = normalize(opts.workdir ?? image.config.workdir ?? '/');
    new Vfs(fs, ROOT).mkdir(workdir, { parents: true });

    const c: Container = {
      id,
      name,
      image: opts.imageRef,
      imageId: image.id,
      argv,
      env: mergeEnv(image.config.env, opts.env),
      workdir,
      created: this.now,
      status: 'created',
      exitCode: 0,
      startedAt: 0,
      finishedAt: 0,
      restartPolicy: opts.restart,
      restartCount: 0,
      ports: network.driver === 'bridge' ? ports : [],
      exposedPorts: [...new Set([...image.config.exposedPorts, ...ports.map((p) => `${p.containerPort}/${p.proto}`)])],
      mounts: [],
      networks: {},
      autoRemove: opts.autoRemove,
      logs: [],
      fs,
      listening: [],
      program: argv.join(' '),
      requests: 0,
      labels: { ...(opts.labels ?? {}) },
    };
    if (network.driver === 'bridge') c.networks[network.name] = { ip: this.allocateIp(network), ...(opts.aliases ? { aliases: opts.aliases } : {}) };
    else c.networks[network.name] = { ip: '' };
    for (const extra of opts.extraNetworks ?? []) {
      const n = this.findNetwork(extra.name);
      if (!n) throw new DockerError(`network ${extra.name} not found`, 125);
      c.networks[n.name] = { ip: this.allocateIp(n), aliases: extra.aliases };
    }
    for (const spec of opts.volumes) this.mount(c, spec);
    this.d.containers.push(c);
    return c;
  }

  private parsePorts(specs: string[], publishAll: string[]): PortBinding[] {
    const out: PortBinding[] = [];
    for (const spec of specs) {
      const [main, protoRaw] = spec.split('/');
      const proto = (protoRaw ?? 'tcp') as 'tcp' | 'udp';
      if (proto !== 'tcp' && proto !== 'udp') throw new DockerError(`invalid proto: ${protoRaw}`, 125);
      const parts = main.split(':');
      let hostIp = '0.0.0.0';
      let hostPort: string | undefined;
      let containerPort: string;
      if (parts.length === 1) [containerPort] = parts;
      else if (parts.length === 2) [hostPort, containerPort] = parts;
      else if (parts.length === 3) [hostIp, hostPort, containerPort] = parts;
      else throw new DockerError(`invalid port format: ${spec}`, 125);
      const cp = Number(containerPort);
      if (!/^\d+$/.test(containerPort) || cp < 1 || cp > 65535) throw new DockerError(`invalid containerPort: ${containerPort}`, 125);
      let hp: number;
      if (hostPort === undefined || hostPort === '') hp = this.randomPort(out);
      else {
        hp = Number(hostPort);
        if (!/^\d+$/.test(hostPort) || hp < 1 || hp > 65535) throw new DockerError(`invalid hostPort: ${hostPort}`, 125);
      }
      out.push({ hostIp: hostIp || '0.0.0.0', hostPort: hp, containerPort: cp, proto });
    }
    for (const exposed of publishAll) {
      const [p, proto] = exposed.split('/');
      if (out.some((b) => b.containerPort === Number(p))) continue;
      out.push({ hostIp: '0.0.0.0', hostPort: this.randomPort(out), containerPort: Number(p), proto: (proto ?? 'tcp') as 'tcp' });
    }
    return out;
  }

  private randomPort(pending: PortBinding[]): number {
    const used = new Set([...this.d.containers.flatMap((c) => c.ports.map((p) => p.hostPort)), ...pending.map((p) => p.hostPort)]);
    let p = 32768;
    while (used.has(p)) p++;
    return p;
  }

  private allocateIp(network: Network): string {
    const used = new Set(this.d.containers.map((c) => c.networks[network.name]?.ip).filter(Boolean));
    for (let n = 2; n < 255; n++) {
      const ip = `${network.subnet}.${n}`;
      if (!used.has(ip)) return ip;
    }
    throw new DockerError(`no available IPv4 addresses on network ${network.name}`);
  }

  /** Parse a `-v` spec and splice the mounted directory into the container's filesystem. */
  private mount(c: Container, spec: string): void {
    const parts = spec.split(':');
    if (parts.length > 3) throw new DockerError(`invalid volume specification: '${spec}'`, 125);
    if (parts[2] !== undefined) {
      throw new DockerError(`mount options ('${parts[2]}') are not supported in devquest yet — use '${parts[0]}:${parts[1]}'`, 125);
    }
    let source: string | undefined;
    let target: string;
    if (parts.length === 1) target = parts[0];
    else [source, target] = parts;
    if (!target.startsWith('/')) {
      throw new DockerError(`invalid mount config for type "${source && /^[./]/.test(source) ? 'bind' : 'volume'}": invalid mount path: '${target}' mount path must be absolute`, 125);
    }
    target = normalize(target);
    let mount: Mount;
    let node: DirNode;
    if (source === undefined || (!source.startsWith('/') && !source.startsWith('.'))) {
      // Named or anonymous volume.
      if (source !== undefined && !NAME_RE.test(source)) {
        throw new DockerError(
          `create ${source}: "${source}" includes invalid characters for a local volume name, only "[a-zA-Z0-9][a-zA-Z0-9_.-]" are allowed. If you intended to pass a host directory, use absolute path`,
          125,
        );
      }
      let vol = source ? this.findVolume(source) : undefined;
      if (!vol) {
        vol = this.createVolume(source, source === undefined);
        // An empty new volume is pre-filled with what the image has at that path.
        const existing = this.nodeAt(c.fs, target);
        if (existing?.type === 'dir') vol.data.children = cloneNode(existing).children;
      }
      mount = { type: 'volume', source: vol.name, target };
      node = vol.data;
    } else {
      const abs = source.startsWith('/') ? normalize(source) : normalize(`${this.host.cwd}/${source}`);
      const hostVfs = new Vfs(this.host.fs, ROOT, () => this.now);
      if (!hostVfs.exists(abs)) hostVfs.mkdir(abs, { parents: true });
      const hostNode = hostVfs.lookup(abs);
      if (hostNode.type !== 'dir') {
        throw new DockerError(`devquest: bind-mounting single files isn't supported yet (${abs}); mount its directory instead`, 125);
      }
      mount = { type: 'bind', source: abs, target };
      node = hostNode;
    }
    this.splice(c.fs, target, node);
    c.mounts.push(mount);
  }

  private nodeAt(root: DirNode, path: string): FsNode | undefined {
    try {
      return new Vfs(root, ROOT).lookup(path);
    } catch {
      return undefined;
    }
  }

  /** Make `path` inside `root` point at `node` (shared reference = live mount). */
  private splice(root: DirNode, path: string, node: DirNode): void {
    const segs = splitPath(path);
    let dir = root;
    for (const seg of segs.slice(0, -1)) {
      let next = dir.children[seg];
      if (!next || next.type !== 'dir') {
        next = makeDir('root', 'root', this.now);
        dir.children[seg] = next;
      }
      dir = next;
    }
    dir.children[segs[segs.length - 1]] = node;
  }

  private image(c: Container): Image | undefined {
    return this.d.images.find((i) => i.id === c.imageId);
  }

  private program(c: Container): Program | { oci: string } {
    const hasFile = (p: string) => this.nodeAt(c.fs, normalize(p)) !== undefined;
    const lacks = this.image(c)?.lacks ?? [];
    const hasCommand = (n: string) => !lacks.includes(n) && (this.hooks.hasCommand?.(n) ?? false);
    return resolveProgram(c.argv, hasCommand, hasFile, this.image(c)?.shells ?? ['sh']);
  }

  private programCtx(c: Container): ProgramContext {
    return {
      container: c,
      now: this.now,
      env: envMap(c.env),
      log: (stream, text) => {
        if (this.hooks.silent) return;
        for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) c.logs.push({ stream, text: line, time: this.now });
      },
      shell: () => (this.hooks.spawn ? this.hooks.spawn(this.containerState(c)) : null),
    };
  }

  /** Start a created or stopped container. Throws on port conflicts and missing executables. */
  start(c: Container): void {
    if (c.status === 'running') return;
    for (const b of c.ports) {
      const clash = this.d.containers.find(
        (o) => o !== c && (o.status === 'running' || o.status === 'restarting') && o.ports.some((p) => p.hostPort === b.hostPort && p.proto === b.proto),
      );
      if (clash) {
        throw new DockerError(
          `driver failed programming external connectivity on endpoint ${c.name} (${hexId('endpoint-' + c.id)}): Bind for ${b.hostIp}:${b.hostPort} failed: port is already allocated`,
        );
      }
    }
    const prog = this.program(c);
    if ('oci' in prog) {
      c.exitCode = 127;
      throw new DockerError(
        `failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: exec: "${prog.oci}": executable file not found in $PATH: unknown`,
        127,
      );
    }
    let result = prog.start(this.programCtx(c));
    c.startedAt = this.now;
    if (result.kind === 'running') {
      c.status = 'running';
      c.exitCode = 0;
      c.listening = result.listen;
      return;
    }
    if (result.kind === 'oci') throw new DockerError(`exec: "${result.exe}": executable file not found in $PATH`, 127);
    // The process exited. A restart policy makes Docker try again (and again...).
    const shouldRestart = (code: number) =>
      c.restartPolicy === 'always' || c.restartPolicy === 'unless-stopped' || (c.restartPolicy === 'on-failure' && code !== 0);
    let attempts = 0;
    while (result.kind === 'exited' && shouldRestart(result.code) && attempts < 2) {
      attempts++;
      c.restartCount++;
      result = prog.start(this.programCtx(c));
    }
    if (result.kind === 'running') {
      c.status = 'running';
      c.listening = result.listen;
      return;
    }
    c.exitCode = result.kind === 'exited' ? result.code : 127;
    c.finishedAt = this.now;
    c.listening = [];
    c.status = shouldRestart(c.exitCode) ? 'restarting' : 'exited';
    if (c.status === 'exited' && c.autoRemove) this.remove(c, { force: true, volumes: true });
  }

  /** `docker stop`: SIGTERM, then SIGKILL after the grace period. */
  stop(c: Container, timeoutSec = 10): void {
    if (c.status !== 'running' && c.status !== 'restarting') return;
    if (c.status === 'restarting') {
      c.status = 'exited';
      return;
    }
    const prog = this.program(c);
    const termExit = 'oci' in prog ? 137 : prog.termExit;
    if (!('oci' in prog)) prog.onStop?.(this.programCtx(c));
    if (termExit === null) {
      // PID 1 ignored SIGTERM: Docker waits for the timeout, then kills it.
      this.host.clock += timeoutSec * 1000;
      c.exitCode = 137;
    } else c.exitCode = termExit;
    this.halt(c);
  }

  /** `docker kill` (default SIGKILL). */
  kill(c: Container, signal = 'KILL'): void {
    const sig = parseSignal(signal);
    if (sig === null) throw new DockerError(`Invalid signal: ${signal}`);
    if (c.status !== 'running' && c.status !== 'restarting') {
      throw new DockerError(`cannot kill container: ${c.name}: container ${c.id} is not running`);
    }
    if (sig === 9) {
      c.exitCode = 137;
    } else if (sig === 15 || sig === 2 || sig === 3) {
      const prog = this.program(c);
      const termExit = 'oci' in prog ? null : prog.termExit;
      if (termExit === null) return; // PID 1 without a handler ignores it
      c.exitCode = termExit;
    } else {
      return; // other signals (HUP, USR1...) don't stop the process
    }
    this.halt(c);
  }

  private halt(c: Container): void {
    c.status = 'exited';
    c.finishedAt = this.now;
    c.listening = [];
    if (c.autoRemove) this.remove(c, { force: true, volumes: true });
  }

  restart(c: Container): void {
    this.stop(c);
    if (this.d.containers.includes(c)) this.start(c);
  }

  remove(c: Container, opts: { force?: boolean; volumes?: boolean } = {}): void {
    if ((c.status === 'running' || c.status === 'restarting') && !opts.force) {
      throw new DockerError(`cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`);
    }
    this.d.containers = this.d.containers.filter((x) => x !== c);
    if (opts.volumes) {
      for (const m of c.mounts) {
        const v = this.findVolume(m.source);
        if (v?.anonymous && !this.volumeUsers(v).length) this.d.volumes = this.d.volumes.filter((x) => x !== v);
      }
    }
  }

  /** Processes visible inside the container (`docker exec ... ps`, `docker top`). */
  processes(c: Container): Process[] {
    if (c.status !== 'running') return [];
    const base = { ppid: 0, user: 'root', tty: '?', stat: 'Ss', cpu: 0, mem: 0.1, vsz: 11_000, rss: 7_000, start: '09:00', time: '0:00' };
    const cmd = c.argv.filter((a) => !/docker-entrypoint\.sh$/.test(a)).join(' ');
    const procs: Process[] = [{ ...base, pid: 1, command: cmd.startsWith('nginx') ? `nginx: master process ${cmd}` : cmd }];
    if (cmd.startsWith('nginx')) procs.push({ ...base, pid: 29, ppid: 1, user: 'nginx', stat: 'S', command: 'nginx: worker process' });
    return procs;
  }

  /** The container's view of the machine, for `docker exec`. Shares fs and command log. */
  containerState(c: Container, shell = 'bash'): SimState {
    const vars: Record<string, string> = {
      ...envMap(c.env),
      HOSTNAME: shortId(c.id),
      HOME: '/root',
      PWD: c.workdir,
      TERM: 'xterm',
    };
    const alpine = !(this.image(c)?.shells ?? []).includes('bash');
    return {
      hostname: shortId(c.id),
      user: 'root',
      cwd: c.workdir,
      fs: c.fs,
      vars,
      exported: Object.keys(vars),
      users: [{ name: 'root', uid: 0, gid: 0, home: '/root', shell: alpine ? '/bin/sh' : '/bin/bash' }],
      groups: [{ name: 'root', gid: 0, members: [] }],
      processes: this.processes(c),
      nextPid: 40,
      disks: [{ filesystem: 'overlay', mount: '/', size: 61_202_244, used: 18_400_312 }],
      network: {},
      lastExit: 0,
      history: [],
      commandLog: this.host.commandLog,
      clock: this.now,
      context: {
        containerId: c.id,
        containerName: c.name,
        promptStyle: shell === 'bash' ? 'bash' : alpine ? 'sh' : 'bash',
        host: this.host,
        lacks: this.image(c)?.lacks ?? [],
      },
    };
  }

  // ------------------------------------------------------------ volumes

  findVolume(name: string): Volume | undefined {
    return this.d.volumes.find((v) => v.name === name);
  }

  createVolume(name?: string, anonymous = false): Volume {
    if (name !== undefined) {
      if (!NAME_RE.test(name)) {
        throw new DockerError(`create ${name}: "${name}" includes invalid characters for a local volume name, only "[a-zA-Z0-9][a-zA-Z0-9_.-]" are allowed. If you intended to pass a host directory, use absolute path`);
      }
      const existing = this.findVolume(name);
      if (existing) return existing;
    }
    const vol: Volume = {
      name: name ?? hexId(`volume-${this.nextSeq()}`),
      created: this.now,
      data: makeDir('root', 'root', this.now),
      anonymous,
    };
    this.d.volumes.push(vol);
    return vol;
  }

  volumeUsers(v: Volume): Container[] {
    return this.d.containers.filter((c) => c.mounts.some((m) => m.type === 'volume' && m.source === v.name));
  }

  removeVolume(name: string, force = false): void {
    const v = this.findVolume(name);
    if (!v) {
      if (force) return;
      throw new DockerError(`get ${name}: no such volume`);
    }
    const users = this.volumeUsers(v);
    if (users.length) throw new DockerError(`remove ${name}: volume is in use - [${users.map((c) => c.id).join(', ')}]`);
    this.d.volumes = this.d.volumes.filter((x) => x !== v);
  }

  // ------------------------------------------------------------ networks

  findNetwork(ref: string): Network | undefined {
    return this.d.networks.find((n) => n.name === ref) ?? (/^[0-9a-f]{3,}$/.test(ref) ? this.d.networks.find((n) => n.id.startsWith(ref)) : undefined);
  }

  createNetwork(name: string, driver = 'bridge'): Network {
    if (this.findNetwork(name)) throw new DockerError(`network with name ${name} already exists`);
    if (driver !== 'bridge') throw new DockerError(`devquest: only the bridge driver is supported for new networks (got "${driver}")`);
    const used = new Set(this.d.networks.map((n) => n.subnet));
    let k = 18;
    while (used.has(`172.${k}.0`)) k++;
    const net: Network = { id: hexId(`network-${name}-${this.nextSeq()}`), name, driver: 'bridge', subnet: `172.${k}.0`, created: this.now, builtin: false };
    this.d.networks.push(net);
    return net;
  }

  removeNetwork(ref: string): void {
    const n = this.findNetwork(ref);
    if (!n) throw new DockerError(`network ${ref} not found`);
    if (n.builtin) throw new DockerError(`${n.name} is a pre-defined network and cannot be removed`);
    const active = this.d.containers.find((c) => c.status === 'running' && n.name in c.networks);
    if (active) {
      throw new DockerError(`error while removing network: network ${n.name} id ${n.id} has active endpoints (name:"${active.name}" id:"${shortId(active.id)}")`);
    }
    for (const c of this.d.containers) delete c.networks[n.name];
    this.d.networks = this.d.networks.filter((x) => x !== n);
  }

  connect(networkRef: string, c: Container): void {
    const n = this.findNetwork(networkRef);
    if (!n) throw new DockerError(`network ${networkRef} not found`);
    if (n.name in c.networks) throw new DockerError(`endpoint with name ${c.name} already exists in network ${n.name}`, 1);
    if (n.driver !== 'bridge') throw new DockerError(`container cannot be disconnected from host network or connected to host network`);
    c.networks[n.name] = { ip: this.allocateIp(n) };
  }

  disconnect(networkRef: string, c: Container): void {
    const n = this.findNetwork(networkRef);
    if (!n) throw new DockerError(`network ${networkRef} not found`);
    if (!(n.name in c.networks)) throw new DockerError(`container ${c.id} is not connected to network ${n.name}`);
    delete c.networks[n.name];
  }

  // ------------------------------------------------------------ networking (curl)

  private serve(c: Container, port: number, path: string): HttpResult {
    if (c.status !== 'running' || !c.listening.includes(port)) {
      return { kind: 'error', code: 56, message: 'Recv failure: Connection reset by peer' };
    }
    const prog = this.program(c);
    if ('oci' in prog || !prog.http) return { kind: 'error', code: 52, message: 'Empty reply from server' };
    const res = prog.http(this.programCtx(c), path || '/', port);
    if (!this.hooks.silent) c.requests++;
    return res;
  }

  /** Answer a curl request made on the host or inside a container. */
  http(from: SimState, req: Request): HttpResult | undefined {
    const running = this.d.containers.filter((c) => c.status === 'running');
    const ctx = from.context;
    if (ctx) {
      const self = this.d.containers.find((c) => c.id === ctx.containerId);
      if (!self) return undefined;
      if (LOCAL_HOSTS.has(req.host)) {
        return self.listening.includes(req.port) ? this.serve(self, req.port, req.path) : { kind: 'error', code: 7, message: `Failed to connect to ${req.host} port ${req.port} after 0 ms: Couldn't connect to server` };
      }
      const shared = Object.keys(self.networks);
      // Name-based discovery only works on user-defined networks (not the default bridge).
      const target = running.find(
        (c) =>
          c !== self &&
          Object.entries(c.networks).some(
            ([net, { ip, aliases }]) =>
              shared.includes(net) && (ip === req.host || ((c.name === req.host || aliases?.includes(req.host)) && !this.findNetwork(net)?.builtin)),
          ),
      );
      if (!target) return undefined;
      return target.listening.includes(req.port)
        ? this.serve(target, req.port, req.path)
        : { kind: 'error', code: 7, message: `Failed to connect to ${req.host} port ${req.port} after 0 ms: Couldn't connect to server` };
    }
    if (LOCAL_HOSTS.has(req.host)) {
      const bound = this.d.containers.find((c) => (c.status === 'running' || c.status === 'restarting') && c.ports.some((p) => p.hostPort === req.port && p.proto === 'tcp'));
      if (bound) {
        const b = bound.ports.find((p) => p.hostPort === req.port)!;
        // Docker's proxy accepts the connection even if nothing listens inside.
        return this.serve(bound, b.containerPort, req.path);
      }
      const hostNet = running.find((c) => 'host' in c.networks && c.listening.includes(req.port));
      if (hostNet) return this.serve(hostNet, req.port, req.path);
      return undefined;
    }
    // On Linux the host can reach container IPs directly.
    const byIp = running.find((c) => Object.values(c.networks).some((n) => n.ip === req.host));
    if (byIp) {
      return byIp.listening.includes(req.port)
        ? this.serve(byIp, req.port, req.path)
        : { kind: 'error', code: 7, message: `Failed to connect to ${req.host} port ${req.port} after 0 ms: Couldn't connect to server` };
    }
    return undefined;
  }
}
