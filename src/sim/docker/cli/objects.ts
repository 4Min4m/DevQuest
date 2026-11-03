import type { CommandContext } from '../../shell/types';
import type { DockerEngine } from '../engine';
import { goTemplate, isoTime, shortId, table } from '../format';
import type { Container, Image, Network, Volume } from '../types';
import { connect, daemonError, forEachRef, parseFlags, requireArgs, usage, UsageError } from './common';

// ------------------------------------------------------------------ inspect JSON

function portMap(c: Container, published: boolean): Record<string, { HostIp: string; HostPort: string }[] | null> {
  const out: Record<string, { HostIp: string; HostPort: string }[] | null> = {};
  for (const e of c.exposedPorts) out[e] = null;
  for (const b of c.ports) {
    const k = `${b.containerPort}/${b.proto}`;
    (out[k] ??= []).push({ HostIp: published ? b.hostIp : '', HostPort: String(b.hostPort) });
  }
  return out;
}

export function containerJson(engine: DockerEngine, c: Container): Record<string, unknown> {
  const running = c.status === 'running';
  const bridgeIp = c.networks.bridge?.ip ?? '';
  return {
    Id: c.id,
    Created: isoTime(c.created),
    Path: c.argv[0] ?? '',
    Args: c.argv.slice(1),
    State: {
      Status: c.status,
      Running: running,
      Paused: c.status === 'paused',
      Restarting: c.status === 'restarting',
      OOMKilled: false,
      Dead: false,
      Pid: running ? 4242 + engine.d.containers.indexOf(c) : 0,
      ExitCode: c.exitCode,
      Error: '',
      StartedAt: c.startedAt ? isoTime(c.startedAt) : '0001-01-01T00:00:00Z',
      FinishedAt: c.finishedAt ? isoTime(c.finishedAt) : '0001-01-01T00:00:00Z',
    },
    Image: `sha256:${c.imageId}`,
    Name: `/${c.name}`,
    RestartCount: c.restartCount,
    HostConfig: {
      Binds: c.mounts.map((m) => `${m.source}:${m.target}`),
      NetworkMode: Object.keys(c.networks)[0] ?? 'bridge',
      PortBindings: Object.fromEntries(
        Object.entries(portMap(c, true))
          .filter(([, v]) => v)
          .map(([k, v]) => [k, v]),
      ),
      RestartPolicy: { Name: c.restartPolicy, MaximumRetryCount: 0 },
      AutoRemove: c.autoRemove,
    },
    Mounts: c.mounts.map((m) =>
      m.type === 'volume'
        ? { Type: 'volume', Name: m.source, Source: `/var/lib/docker/volumes/${m.source}/_data`, Destination: m.target, Driver: 'local', Mode: 'z', RW: true, Propagation: '' }
        : { Type: 'bind', Source: m.source, Destination: m.target, Mode: '', RW: true, Propagation: 'rprivate' },
    ),
    Config: {
      Hostname: shortId(c.id),
      Env: c.env,
      Cmd: c.argv,
      Image: c.image,
      WorkingDir: c.workdir,
      ExposedPorts: Object.fromEntries(c.exposedPorts.map((p) => [p, {}])),
    },
    NetworkSettings: {
      Ports: running ? portMap(c, true) : {},
      IPAddress: running ? bridgeIp : '',
      Networks: Object.fromEntries(
        Object.entries(c.networks).map(([name, { ip }]) => {
          const n = engine.findNetwork(name);
          return [name, { NetworkID: n?.id ?? '', IPAddress: running ? ip : '', Gateway: running && n?.subnet ? `${n.subnet}.1` : '', Aliases: null }];
        }),
      ),
    },
  };
}

export function imageJson(i: Image): Record<string, unknown> {
  return {
    Id: `sha256:${i.id}`,
    RepoTags: [`${i.repository}:${i.tag}`],
    RepoDigests: [`${i.repository}@sha256:${i.digest}`],
    Created: isoTime(i.created),
    Config: {
      Env: i.config.env,
      Cmd: i.config.cmd,
      Entrypoint: i.config.entrypoint.length ? i.config.entrypoint : null,
      WorkingDir: i.config.workdir === '/' ? '' : i.config.workdir,
      ExposedPorts: i.config.exposedPorts.length ? Object.fromEntries(i.config.exposedPorts.map((p) => [p, {}])) : null,
    },
    Architecture: 'amd64',
    Os: 'linux',
    Size: i.size,
  };
}

function volumeJson(v: Volume): Record<string, unknown> {
  return {
    CreatedAt: isoTime(v.created).replace(/\.\d+Z$/, 'Z'),
    Driver: 'local',
    Labels: v.anonymous ? { 'com.docker.volume.anonymous': '' } : null,
    Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`,
    Name: v.name,
    Options: null,
    Scope: 'local',
  };
}

function networkJson(engine: DockerEngine, n: Network): Record<string, unknown> {
  const members = engine.d.containers.filter((c) => n.name in c.networks && c.status === 'running');
  return {
    Name: n.name,
    Id: n.id,
    Created: isoTime(n.created),
    Scope: 'local',
    Driver: n.driver,
    IPAM: { Driver: 'default', Config: n.subnet ? [{ Subnet: `${n.subnet}.0/16`.replace('.0.0/16', '.0.0/16'), Gateway: `${n.subnet}.1` }] : [] },
    Containers: Object.fromEntries(members.map((c) => [c.id, { Name: c.name, IPv4Address: `${c.networks[n.name].ip}/16` }])),
  };
}

/** docker CLI prints JSON with 4-space indentation. */
const pretty = (v: unknown) => JSON.stringify(v, null, 4);

export function dockerInspect(ctx: CommandContext, cmd = 'inspect', forceType?: string): number {
  let p;
  try {
    p = parseFlags(ctx.args, {
      flags: { '-f': { value: true, key: 'format' }, '--format': { value: true, key: 'format' }, '--type': { value: true, key: 'type' } },
    });
    requireArgs(cmd, p.args, 1, '[OPTIONS] NAME|ID [NAME|ID...]');
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  const type = forceType ?? (p.opts.type as string | undefined);
  const found: Record<string, unknown>[] = [];
  const missing: string[] = [];
  for (const ref of p.args) {
    let obj: Record<string, unknown> | undefined;
    try {
      if (!type || type === 'container') {
        const c = engine.findContainer(ref);
        if (c) obj = containerJson(engine, c);
      }
    } catch {
      /* ambiguous prefix: fall through to other object types */
    }
    if (!obj && (!type || type === 'image')) {
      const i = engine.findImage(ref);
      if (i) obj = imageJson(i);
    }
    if (!obj && (!type || type === 'volume')) {
      const v = engine.findVolume(ref);
      if (v) obj = volumeJson(v);
    }
    if (!obj && (!type || type === 'network')) {
      const n = engine.findNetwork(ref);
      if (n) obj = networkJson(engine, n);
    }
    if (obj) found.push(obj);
    else missing.push(ref);
  }
  if (typeof p.opts.format === 'string') {
    try {
      for (const o of found) ctx.out(goTemplate(p.opts.format, o) + '\n');
    } catch (e) {
      ctx.err(`${(e as Error).message}\n`);
      return 1;
    }
  } else {
    ctx.out(pretty(found) + '\n');
  }
  const noun = forceType ? `such ${forceType}` : 'such object';
  for (const m of missing) ctx.err(`Error: No ${noun}: ${m}\n`);
  return missing.length ? 1 : 0;
}

// ------------------------------------------------------------------ volumes

export function dockerVolume(ctx: CommandContext): number {
  const [sub, ...rest] = ctx.args;
  const sctx = { ...ctx, args: rest };
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  try {
    switch (sub) {
      case 'create': {
        const p = parseFlags(rest, { flags: { '-d': { value: true, key: 'driver' }, '--driver': { value: true, key: 'driver' } } });
        if (p.opts.driver && p.opts.driver !== 'local') {
          ctx.err(`Error response from daemon: create ${p.args[0] ?? ''}: error looking up volume plugin ${p.opts.driver}: plugin "${p.opts.driver}" not found\n`);
          return 1;
        }
        ctx.out(engine.createVolume(p.args[0]).name + '\n');
        return 0;
      }
      case 'ls':
      case 'list': {
        const p = parseFlags(rest, { flags: { '-q': { key: 'quiet' }, '--quiet': { key: 'quiet' } } });
        const vols = [...engine.d.volumes].sort((a, b) => (a.name < b.name ? -1 : 1));
        if (p.opts.quiet) vols.forEach((v) => ctx.out(v.name + '\n'));
        else ctx.out(table([['DRIVER', 'VOLUME NAME'], ...vols.map((v) => ['local', v.name])]));
        return 0;
      }
      case 'rm':
      case 'remove': {
        const p = parseFlags(rest, { flags: { '-f': { key: 'force' }, '--force': { key: 'force' } } });
        requireArgs('volume rm', p.args, 1, '[OPTIONS] VOLUME [VOLUME...]');
        return forEachRef(ctx, p.args, (name) => engine.removeVolume(name, !!p.opts.force));
      }
      case 'inspect':
        return dockerInspect(sctx, 'volume inspect', 'volume');
      case 'prune': {
        const unused = engine.d.volumes.filter((v) => v.anonymous && !engine.volumeUsers(v).length);
        for (const v of unused) engine.removeVolume(v.name);
        ctx.out(unused.length ? `Deleted Volumes:\n${unused.map((v) => v.name).join('\n')}\n\nTotal reclaimed space: 0B\n` : 'Total reclaimed space: 0B\n');
        return 0;
      }
      default:
        ctx.err(sub ? `docker: 'volume ${sub}' is not a docker command.\nSee 'docker volume --help'\n` : 'Usage:  docker volume COMMAND\n\nCommands: create, inspect, ls, prune, rm\n');
        return sub ? 1 : 0;
    }
  } catch (e) {
    if (e instanceof UsageError) return usage(ctx, `volume ${sub}`, e);
    return daemonError(ctx, e);
  }
}

// ------------------------------------------------------------------ networks

export function dockerNetwork(ctx: CommandContext): number {
  const [sub, ...rest] = ctx.args;
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  try {
    switch (sub) {
      case 'create': {
        const p = parseFlags(rest, { flags: { '-d': { value: true, key: 'driver' }, '--driver': { value: true, key: 'driver' } } });
        requireArgs('network create', p.args, 1, '[OPTIONS] NETWORK');
        ctx.out(engine.createNetwork(p.args[0], (p.opts.driver as string) ?? 'bridge').id + '\n');
        return 0;
      }
      case 'ls':
      case 'list': {
        const p = parseFlags(rest, { flags: { '-q': { key: 'quiet' }, '--quiet': { key: 'quiet' } } });
        const nets = [...engine.d.networks].sort((a, b) => (a.name < b.name ? -1 : 1));
        if (p.opts.quiet) nets.forEach((n) => ctx.out(shortId(n.id) + '\n'));
        else ctx.out(table([['NETWORK ID', 'NAME', 'DRIVER', 'SCOPE'], ...nets.map((n) => [shortId(n.id), n.name, n.driver, 'local'])]));
        return 0;
      }
      case 'rm':
      case 'remove': {
        requireArgs('network rm', rest, 1, 'NETWORK [NETWORK...]');
        return forEachRef(ctx, rest, (n) => engine.removeNetwork(n));
      }
      case 'inspect':
        return dockerInspect({ ...ctx, args: rest }, 'network inspect', 'network');
      case 'connect':
      case 'disconnect': {
        requireArgs(`network ${sub}`, rest, 2, `NETWORK CONTAINER`);
        const c = engine.getContainer(rest[1]);
        if (sub === 'connect') engine.connect(rest[0], c);
        else engine.disconnect(rest[0], c);
        return 0;
      }
      default:
        ctx.err(sub ? `docker: 'network ${sub}' is not a docker command.\nSee 'docker network --help'\n` : 'Usage:  docker network COMMAND\n\nCommands: connect, create, disconnect, inspect, ls, rm\n');
        return sub ? 1 : 0;
    }
  } catch (e) {
    if (e instanceof UsageError) return usage(ctx, `network ${sub}`, e);
    return daemonError(ctx, e);
  }
}
