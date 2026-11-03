import type { CommandContext } from '../../shell/types';
import { parseRef } from '../catalog';
import { DockerEngine, DockerError } from '../engine';
import type { Container, Image, RestartPolicy } from '../types';
import { connect, FlagSpec, parseFlags, UsageError, usage } from './common';

export const RUN_FLAGS: FlagSpec = {
  stopAtPositional: true,
  flags: {
    '-d': { key: 'detach' },
    '--detach': { key: 'detach' },
    '-i': { key: 'interactive' },
    '--interactive': { key: 'interactive' },
    '-t': { key: 'tty' },
    '--tty': { key: 'tty' },
    '--rm': { key: 'rm' },
    '--name': { value: true, key: 'name' },
    '-p': { value: true, multi: true, key: 'publish' },
    '--publish': { value: true, multi: true, key: 'publish' },
    '-P': { key: 'publishAll' },
    '--publish-all': { key: 'publishAll' },
    '-e': { value: true, multi: true, key: 'env' },
    '--env': { value: true, multi: true, key: 'env' },
    '-v': { value: true, multi: true, key: 'volume' },
    '--volume': { value: true, multi: true, key: 'volume' },
    '--restart': { value: true, key: 'restart' },
    '--network': { value: true, key: 'network' },
    '--net': { value: true, key: 'network' },
    '-w': { value: true, key: 'workdir' },
    '--workdir': { value: true, key: 'workdir' },
    '--entrypoint': { value: true, key: 'entrypoint' },
    '--env-file': { value: true, key: 'envFile' },
    '--mount': { value: true, key: 'mount' },
  },
};

const SHELLS = new Set(['sh', 'bash', 'ash', 'dash']);

/** Get an image locally or pull it, printing what `docker run` prints. */
export function ensureImage(ctx: CommandContext, engine: DockerEngine, ref: string): Image {
  const local = engine.findImage(ref);
  if (local) return local;
  const { repository, tag } = parseRef(ref);
  ctx.note(`Unable to find image '${repository}:${tag}' locally\n`);
  const { image, lines } = engine.pull(ref);
  ctx.note(lines.join('\n') + '\n');
  return image;
}

function restartPolicy(v: string | undefined): RestartPolicy {
  if (v === undefined) return 'no';
  const name = v.split(':')[0];
  if (name === 'no' || name === 'always' || name === 'unless-stopped' || name === 'on-failure') return name;
  throw new DockerError(`invalid restart policy: ${v}`, 125);
}

/** Shared by `docker run` and `docker create`. */
function createFromArgs(ctx: CommandContext, engine: DockerEngine, cmd: 'run' | 'create'): { container: Container; tty: boolean; detach: boolean } | number {
  let p;
  try {
    p = parseFlags(ctx.args, RUN_FLAGS);
    if (!p.args.length) {
      throw new UsageError(`"docker ${cmd}" requires at least 1 argument.`, `${cmd} [OPTIONS] IMAGE [COMMAND] [ARG...]`, 1);
    }
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const o = p.opts;
  if (o.envFile !== undefined || o.mount !== undefined) {
    ctx.err(`devquest: ${o.envFile !== undefined ? '--env-file' : '--mount'} is not supported yet — use ${o.envFile !== undefined ? '-e KEY=value' : '-v source:/target'}\n`);
    return 125;
  }
  if (o.rm && o.restart !== undefined && o.restart !== 'no') {
    ctx.err('docker: Conflicting options: --restart and --rm.\nSee \'docker run --help\'.\n');
    return 125;
  }
  const [imageRef, ...command] = p.args;
  // `-e KEY` copies the value from the client's environment (if set).
  const env = (p.multi.env ?? []).flatMap((e) => (e.includes('=') ? [e] : ctx.env[e] !== undefined ? [`${e}=${ctx.env[e]}`] : []));
  if (o.network === 'host' && p.multi.publish?.length) ctx.note('WARNING: Published ports are discarded when using host network mode\n');
  const image = ensureImage(ctx, engine, imageRef);
  const container = engine.create(image, {
    imageRef,
    name: o.name as string | undefined,
    cmd: command,
    entrypoint: o.entrypoint as string | undefined,
    env,
    publish: p.multi.publish ?? [],
    publishAll: !!o.publishAll,
    volumes: p.multi.volume ?? [],
    restart: restartPolicy(o.restart as string | undefined),
    network: o.network as string | undefined,
    workdir: o.workdir as string | undefined,
    autoRemove: !!o.rm,
  });
  return { container, tty: !!o.tty && !!o.interactive, detach: !!o.detach };
}

function runError(ctx: CommandContext, e: unknown): number {
  if (e instanceof DockerError) {
    const msg = /[.!]$/.test(e.message) ? e.message : e.message + '.';
    ctx.err(`docker: Error response from daemon: ${msg}\n`);
    if (e.exitCode === 125) ctx.err("\nRun 'docker run --help' for more information\n");
    return e.exitCode === 1 ? 125 : e.exitCode;
  }
  throw e;
}

export function dockerCreate(ctx: CommandContext): number {
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  try {
    const r = createFromArgs(ctx, engine, 'create');
    if (typeof r === 'number') return r;
    ctx.out(r.container.id + '\n');
    return 0;
  } catch (e) {
    return runError(ctx, e);
  }
}

export function dockerRun(ctx: CommandContext): number {
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  let created;
  try {
    created = createFromArgs(ctx, engine, 'run');
  } catch (e) {
    return runError(ctx, e);
  }
  if (typeof created === 'number') return created;
  const { container: c, tty, detach } = created;
  const exe = (c.argv[0] ?? '').split('/').pop() ?? '';

  // Interactive shell: hand the terminal to a shell inside the container.
  if (tty && !detach && SHELLS.has(exe) && !c.argv.includes('-c')) {
    const shells = engine.findImage(c.imageId)?.shells ?? [];
    if (!shells.includes(exe)) {
      ctx.err(
        `docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: exec: "${c.argv[0]}": executable file not found in $PATH: unknown.\n`,
      );
      c.exitCode = 127;
      return 127;
    }
    c.status = 'running';
    c.startedAt = engine.now;
    ctx.shell.attach(engine.containerState(c, exe), (code) => {
      c.status = 'exited';
      c.exitCode = code;
      c.finishedAt = ctx.state.clock;
      if (c.autoRemove) engine.remove(c, { force: true, volumes: true });
    });
    return 0;
  }

  const before = c.logs.length;
  try {
    engine.start(c);
  } catch (e) {
    return runError(ctx, e);
  }
  if (detach) {
    ctx.out(c.id + '\n');
    return 0;
  }
  for (const line of c.logs.slice(before)) (line.stream === 'stdout' ? ctx.out : ctx.err)(line.text);
  if (c.status === 'running') {
    ctx.note(
      `devquest: '${c.name}' keeps running in the foreground on a real system (your terminal would stay attached until Ctrl+C).\n` +
        "devquest: here it continues in the background — next time use -d to run it detached.\n",
    );
    return 0;
  }
  return c.exitCode;
}
