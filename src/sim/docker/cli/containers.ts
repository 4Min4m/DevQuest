import type { CommandContext } from '../../shell/types';
import { DockerEngine, DockerError } from '../engine';
import { ellipsis, goTemplate, humanDuration, isoTime, shortId, table } from '../format';
import type { Container } from '../types';
import { connect, daemonError, forEachRef, parseFlags, requireArgs, usage } from './common';

export function statusText(c: Container, now: number): string {
  switch (c.status) {
    case 'running':
      return `Up ${humanDuration(now - c.startedAt)}`;
    case 'exited':
      return c.startedAt ? `Exited (${c.exitCode}) ${humanDuration(now - c.finishedAt)} ago` : 'Created';
    case 'restarting':
      return `Restarting (${c.exitCode}) ${humanDuration(now - c.finishedAt)} ago`;
    case 'paused':
      return `Up ${humanDuration(now - c.startedAt)} (Paused)`;
    default:
      return 'Created';
  }
}

export function portsText(c: Container): string {
  if (c.status !== 'running' && c.status !== 'restarting') return '';
  const published = c.ports.map((p) => `${p.hostIp}:${p.hostPort}->${p.containerPort}/${p.proto}`);
  const exposedOnly = c.exposedPorts.filter((e) => !c.ports.some((p) => `${p.containerPort}/${p.proto}` === e));
  return [...published, ...exposedOnly].join(', ');
}

/** Values exposed to `docker ps --format`. */
function psFields(c: Container, now: number, noTrunc: boolean) {
  const command = c.argv.join(' ');
  return {
    ID: noTrunc ? c.id : shortId(c.id),
    Image: c.image,
    Command: `"${noTrunc ? command : ellipsis(command, 20)}"`,
    CreatedAt: isoTime(c.created),
    RunningFor: `${humanDuration(now - c.created)} ago`,
    Status: statusText(c, now),
    State: c.status,
    Ports: portsText(c),
    Names: c.name,
    Networks: Object.keys(c.networks).join(','),
    Mounts: c.mounts.map((m) => m.source).join(','),
  };
}

export function dockerPs(ctx: CommandContext, cmd = 'ps'): number {
  let p;
  try {
    p = parseFlags(ctx.args, {
      flags: {
        '-a': { key: 'all' },
        '--all': { key: 'all' },
        '-q': { key: 'quiet' },
        '--quiet': { key: 'quiet' },
        '--no-trunc': { key: 'noTrunc' },
        '-f': { value: true, multi: true, key: 'filter' },
        '--filter': { value: true, multi: true, key: 'filter' },
        '--format': { value: true, key: 'format' },
      },
    });
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  const now = engine.now;
  let list = [...engine.d.containers].reverse();
  if (!p.opts.all) list = list.filter((c) => c.status === 'running' || c.status === 'restarting' || c.status === 'paused');
  for (const f of p.multi.filter ?? []) {
    const [k, v = ''] = f.split('=');
    if (k === 'status') list = (p.opts.all ? list : [...engine.d.containers].reverse()).filter((c) => c.status === v);
    else if (k === 'name') list = list.filter((c) => c.name.includes(v));
    else if (k === 'ancestor') list = list.filter((c) => c.image === v || c.image.split(':')[0] === v);
    else {
      ctx.err(`devquest: filter '${k}' is not supported (supported: status, name, ancestor)\n`);
      return 1;
    }
  }
  const noTrunc = !!p.opts.noTrunc;
  if (p.opts.quiet) {
    for (const c of list) ctx.out((noTrunc ? c.id : shortId(c.id)) + '\n');
    return 0;
  }
  if (typeof p.opts.format === 'string') {
    try {
      for (const c of list) ctx.out(goTemplate(p.opts.format, psFields(c, now, noTrunc)) + '\n');
    } catch (e) {
      ctx.err((e as Error).message + '\n');
      return 1;
    }
    return 0;
  }
  const rows = [['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES']];
  for (const c of list) {
    const f = psFields(c, now, noTrunc);
    rows.push([f.ID, f.Image, f.Command, f.RunningFor, f.Status, f.Ports, f.Names]);
  }
  ctx.out(table(rows));
  return 0;
}

function simple(
  ctx: CommandContext,
  cmd: string,
  flags: Parameters<typeof parseFlags>[1]['flags'],
  usageLine: string,
  act: (engine: DockerEngine, c: Container, opts: Record<string, string | boolean>) => void,
): number {
  let p;
  try {
    p = parseFlags(ctx.args, { flags });
    requireArgs(cmd, p.args, 1, usageLine);
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  const opts = p.opts;
  return forEachRef(ctx, p.args, (ref) => act(engine, engine.getContainer(ref), opts));
}

export const dockerStop = (ctx: CommandContext, cmd = 'stop') =>
  simple(ctx, cmd, { '-t': { value: true, key: 'time' }, '--time': { value: true, key: 'time' } }, '[OPTIONS] CONTAINER [CONTAINER...]', (e, c, o) =>
    e.stop(c, o.time !== undefined ? Number(o.time) : 10),
  );

export const dockerRestart = (ctx: CommandContext, cmd = 'restart') =>
  simple(ctx, cmd, { '-t': { value: true, key: 'time' }, '--time': { value: true, key: 'time' } }, '[OPTIONS] CONTAINER [CONTAINER...]', (e, c) => e.restart(c));

export const dockerKill = (ctx: CommandContext, cmd = 'kill') =>
  simple(ctx, cmd, { '-s': { value: true, key: 'signal' }, '--signal': { value: true, key: 'signal' } }, '[OPTIONS] CONTAINER [CONTAINER...]', (e, c, o) =>
    e.kill(c, (o.signal as string) ?? 'KILL'),
  );

export const dockerRm = (ctx: CommandContext, cmd = 'rm') =>
  simple(
    ctx,
    cmd,
    { '-f': { key: 'force' }, '--force': { key: 'force' }, '-v': { key: 'volumes' }, '--volumes': { key: 'volumes' } },
    '[OPTIONS] CONTAINER [CONTAINER...]',
    (e, c, o) => e.remove(c, { force: !!o.force, volumes: !!o.volumes }),
  );

export function dockerStart(ctx: CommandContext, cmd = 'start'): number {
  let p;
  try {
    p = parseFlags(ctx.args, { flags: { '-a': { key: 'attach' }, '--attach': { key: 'attach' }, '-i': { key: 'interactive' } } });
    requireArgs(cmd, p.args, 1, '[OPTIONS] CONTAINER [CONTAINER...]');
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  const failed: string[] = [];
  for (const ref of p.args) {
    try {
      const c = engine.getContainer(ref);
      const before = c.logs.length;
      engine.start(c);
      if (p.opts.attach) for (const l of c.logs.slice(before)) (l.stream === 'stdout' ? ctx.out : ctx.err)(l.text);
      else ctx.out(ref + '\n');
    } catch (e) {
      daemonError(ctx, e);
      failed.push(ref);
    }
  }
  if (failed.length) {
    ctx.err(`Error: failed to start containers: ${failed.join(', ')}\n`);
    return 1;
  }
  return 0;
}

export function dockerLogs(ctx: CommandContext, cmd = 'logs'): number {
  let p;
  try {
    p = parseFlags(ctx.args, {
      flags: {
        '-f': { key: 'follow' },
        '--follow': { key: 'follow' },
        '-t': { key: 'timestamps' },
        '--timestamps': { key: 'timestamps' },
        '-n': { value: true, key: 'tail' },
        '--tail': { value: true, key: 'tail' },
      },
    });
    requireArgs(cmd, p.args, 1, '[OPTIONS] CONTAINER');
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  try {
    const c = engine.getContainer(p.args[0]);
    let lines = c.logs;
    const tail = p.opts.tail;
    if (tail !== undefined && tail !== 'all') {
      const n = Number(tail);
      if (!Number.isInteger(n) || n < 0) {
        ctx.err(`invalid value for --tail: ${tail}\n`);
        return 1;
      }
      lines = n === 0 ? [] : lines.slice(-n);
    }
    for (const l of lines) (l.stream === 'stdout' ? ctx.out : ctx.err)((p.opts.timestamps ? isoTime(l.time) + ' ' : '') + l.text);
    if (p.opts.follow) ctx.err('devquest: -f (follow) is not supported; showing the logs so far\n');
    return 0;
  } catch (e) {
    return daemonError(ctx, e);
  }
}

export function dockerPort(ctx: CommandContext, cmd = 'port'): number {
  let p;
  try {
    p = parseFlags(ctx.args, { flags: {} });
    requireArgs(cmd, p.args, 1, 'CONTAINER [PRIVATE_PORT[/PROTO]]');
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  try {
    const c = engine.getContainer(p.args[0]);
    const want = p.args[1];
    const bindings = c.status === 'running' ? c.ports : [];
    const selected = want ? bindings.filter((b) => `${b.containerPort}/${b.proto}` === (want.includes('/') ? want : `${want}/tcp`)) : bindings;
    if (want && !selected.length) {
      ctx.err(`Error: No public port '${want.includes('/') ? want : want + '/tcp'}' published for ${p.args[0]}\n`);
      return 1;
    }
    for (const b of selected) ctx.out(want ? `${b.hostIp}:${b.hostPort}\n` : `${b.containerPort}/${b.proto} -> ${b.hostIp}:${b.hostPort}\n`);
    return 0;
  } catch (e) {
    return daemonError(ctx, e);
  }
}

const SHELLS = new Set(['sh', 'bash', 'ash', 'dash']);

function quote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export function dockerExec(ctx: CommandContext, cmd = 'exec'): number {
  let p;
  try {
    p = parseFlags(ctx.args, {
      stopAtPositional: true,
      flags: {
        '-i': { key: 'interactive' },
        '--interactive': { key: 'interactive' },
        '-t': { key: 'tty' },
        '--tty': { key: 'tty' },
        '-d': { key: 'detach' },
        '-e': { value: true, multi: true, key: 'env' },
        '--env': { value: true, multi: true, key: 'env' },
        '-w': { value: true, key: 'workdir' },
        '--workdir': { value: true, key: 'workdir' },
        '-u': { value: true, key: 'user' },
        '--user': { value: true, key: 'user' },
      },
    });
    requireArgs(cmd, p.args, 2, '[OPTIONS] CONTAINER COMMAND [ARG...]');
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  if (p.opts.user !== undefined && p.opts.user !== 'root' && p.opts.user !== '0') {
    ctx.err('devquest: running exec as another user (-u) is not supported yet\n');
    return 1;
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  const [ref, ...argv] = p.args;
  let c: Container;
  try {
    c = engine.getContainer(ref);
    if (c.status !== 'running') throw new DockerError(`container ${c.id} is not running`);
  } catch (e) {
    return daemonError(ctx, e);
  }
  const exe = argv[0].split('/').pop() ?? argv[0];
  const shells = engine.findImage(c.imageId)?.shells ?? [];
  const names = new Set(ctx.shell.listCommands().map((d) => d.name));
  const lacks = engine.findImage(c.imageId)?.lacks ?? [];
  const known = SHELLS.has(exe) ? shells.includes(exe) : names.has(exe) && exe !== 'docker' && !lacks.includes(exe);
  if (!known) {
    ctx.err(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${argv[0]}": executable file not found in $PATH: unknown\n`);
    return 126;
  }
  const state = engine.containerState(c, exe);
  for (const e of p.multi.env ?? []) {
    const [k, ...v] = e.split('=');
    state.vars[k] = v.join('=');
    state.exported.push(k);
  }
  if (typeof p.opts.workdir === 'string') state.cwd = p.opts.workdir;

  if (SHELLS.has(exe) && !argv.includes('-c')) {
    // An interactive shell takes over the terminal; without -it it just reads EOF and exits.
    if (p.opts.interactive && p.opts.tty) ctx.shell.attach(state, () => undefined);
    return 0;
  }
  const line = SHELLS.has(exe) ? argv[argv.indexOf('-c') + 1] ?? '' : argv.map(quote).join(' ');
  const r = ctx.shell.spawn(state).run(line);
  for (const chunk of r.output) (chunk.stream === 'stdout' ? ctx.out : ctx.err)(chunk.text);
  return r.exitCode;
}
