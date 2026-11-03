import type { CommandContext } from '../../shell/types';
import { BuildError, buildImage } from '../build';
import { ComposeError, composeDown, composeUp, containerNameFor, imageNameFor, LABEL_SERVICE, loadProject, Project, projectContainers } from '../compose';
import { DockerEngine, DockerError } from '../engine';
import { ellipsis, humanDuration, table } from '../format';
import { dockerExec, portsText, statusText } from './containers';
import { connect, parseFlags, UsageError } from './common';

interface Global {
  file?: string;
  project?: string;
  rest: string[];
}

/** Global compose flags come before the subcommand: `docker compose -f x.yaml -p name up`. */
function globals(args: string[]): Global {
  const g: Global = { rest: [] };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--file') g.file = args[++i];
    else if (a.startsWith('--file=')) g.file = a.slice(7);
    else if (a === '-p' || a === '--project-name') g.project = args[++i];
    else break;
  }
  g.rest = args.slice(i);
  return g;
}

function failure(ctx: CommandContext, e: unknown): number {
  if (e instanceof ComposeError) {
    ctx.err(e.message + '\n');
    return 1;
  }
  if (e instanceof BuildError) {
    if (e.detail.length) ctx.err(e.detail.join('\n') + '\n');
    ctx.err(`failed to solve: ${e.message}\n`);
    return 1;
  }
  if (e instanceof DockerError) {
    ctx.err(`Error response from daemon: ${e.message}\n`);
    return 1;
  }
  if (e instanceof UsageError) {
    ctx.err(`${e.message}\n`);
    return 1;
  }
  throw e;
}

function buildService(ctx: CommandContext, engine: DockerEngine, project: Project, name: string) {
  const s = project.services.find((x) => x.name === name)!;
  const { image, progress } = buildImage(
    { engine, host: ctx.state, spawn: (st) => ctx.shell.spawn(st) },
    { contextDir: s.build!.context, dockerfile: `${s.build!.context}/${s.build!.dockerfile}`, tag: imageNameFor(project, s) },
  );
  ctx.note(progress.join('\n') + '\n');
  return image;
}

function up(ctx: CommandContext, engine: DockerEngine, project: Project, args: string[]): number {
  const p = parseFlags(args, {
    flags: { '-d': { key: 'detach' }, '--detach': { key: 'detach' }, '--build': { key: 'build' }, '--force-recreate': { key: 'recreate' } },
  });
  const started = composeUp(
    engine,
    project,
    {
      build: (proj, s) => buildService(ctx, engine, proj, s.name),
      ensureImage: (ref) => {
        const local = engine.findImage(ref);
        if (local) return { image: local, pulled: false };
        return { image: engine.pull(ref).image, pulled: true };
      },
    },
    { forceBuild: !!p.opts.build, only: p.args },
    (line) => ctx.note(line + '\n'),
  );
  if (!p.opts.detach) {
    const width = Math.max(...started.map((c) => c.labels[LABEL_SERVICE].length)) + 4;
    for (const c of started) {
      for (const l of c.logs) ctx.out(`${(c.labels[LABEL_SERVICE] + '-1').padEnd(width)}| ${l.text}`);
    }
    ctx.note('devquest: `docker compose up` would stay attached to these logs (Ctrl+C stops the services); here the services keep running in the background. Use -d next time.\n');
  }
  return 0;
}

function ps(ctx: CommandContext, engine: DockerEngine, project: Project, args: string[]): number {
  const p = parseFlags(args, { flags: { '-a': { key: 'all' }, '--all': { key: 'all' }, '-q': { key: 'quiet' }, '--quiet': { key: 'quiet' } } });
  let list = projectContainers(engine, project.name);
  if (!p.opts.all) list = list.filter((c) => c.status === 'running' || c.status === 'restarting');
  if (p.args.length) list = list.filter((c) => p.args.includes(c.labels[LABEL_SERVICE]));
  if (p.opts.quiet) {
    for (const c of list) ctx.out(c.id.slice(0, 12) + '\n');
    return 0;
  }
  const rows = [['NAME', 'IMAGE', 'COMMAND', 'SERVICE', 'CREATED', 'STATUS', 'PORTS']];
  for (const c of list) {
    rows.push([c.name, c.image, `"${ellipsis(c.argv.join(' '), 20)}"`, c.labels[LABEL_SERVICE], `${humanDuration(engine.now - c.created)} ago`, statusText(c, engine.now), portsText(c)]);
  }
  ctx.out(table(rows));
  return 0;
}

function logs(ctx: CommandContext, engine: DockerEngine, project: Project, args: string[]): number {
  const p = parseFlags(args, { flags: { '-f': { key: 'follow' }, '--follow': { key: 'follow' }, '-n': { value: true, key: 'tail' }, '--tail': { value: true, key: 'tail' } } });
  const list = projectContainers(engine, project.name).filter((c) => !p.args.length || p.args.includes(c.labels[LABEL_SERVICE]));
  for (const svc of p.args) {
    if (!project.services.some((s) => s.name === svc)) {
      ctx.err(`no such service: ${svc}\n`);
      return 1;
    }
  }
  // compose aligns "web-1  | " prefixes: longest "service-1" + 2 spaces
  const width = Math.max(0, ...list.map((c) => c.labels[LABEL_SERVICE].length)) + 4;
  for (const c of list) {
    let lines = c.logs;
    if (p.opts.tail !== undefined) lines = lines.slice(-Number(p.opts.tail));
    for (const l of lines) (l.stream === 'stdout' ? ctx.out : ctx.err)(`${(c.labels[LABEL_SERVICE] + '-1').padEnd(width)}| ${l.text}`);
  }
  if (p.opts.follow) ctx.note('devquest: -f (follow) is not supported; showing the logs so far\n');
  return 0;
}

function lifecycle(ctx: CommandContext, engine: DockerEngine, project: Project, sub: 'start' | 'stop' | 'restart', args: string[]): number {
  const list = projectContainers(engine, project.name).filter((c) => !args.length || args.includes(c.labels[LABEL_SERVICE]));
  const width = Math.max(10, ...list.map((c) => `Container ${c.name}`.length)) + 1;
  const done = { start: 'Started', stop: 'Stopped', restart: 'Started' }[sub];
  const out = [`[+] ${sub === 'stop' ? 'Stopping' : sub === 'start' ? 'Running' : 'Restarting'} ${list.length}/${list.length}`];
  for (const c of list) {
    if (sub === 'start') engine.start(c);
    else if (sub === 'stop') engine.stop(c);
    else engine.restart(c);
    out.push(` ✔ ${`Container ${c.name}`.padEnd(width)}  ${done}`);
  }
  ctx.note(out.join('\n') + '\n');
  return 0;
}

function exec(ctx: CommandContext, engine: DockerEngine, project: Project, args: string[]): number {
  const flags: string[] = [];
  let i = 0;
  let tty = true;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (args[i] === '-T' || args[i] === '--no-TTY') tty = false;
    else if (args[i] === '-e' || args[i] === '-w') flags.push(args[i], args[++i]);
    else flags.push(args[i]);
  }
  const [svc, ...cmd] = args.slice(i);
  if (!svc || !cmd.length) {
    ctx.err('"docker compose exec" requires at least 2 arguments.\n');
    return 1;
  }
  if (!project.services.some((s) => s.name === svc)) {
    ctx.err(`service "${svc}" is not defined in this project\n`);
    return 1;
  }
  const c = projectContainers(engine, project.name, svc).find((x) => x.status === 'running');
  if (!c) {
    ctx.err(`service "${svc}" is not running\n`);
    return 1;
  }
  return dockerExec({ ...ctx, args: [...(tty ? ['-it'] : []), ...flags, c.name, ...cmd] });
}

const HELP = `
Usage:  docker compose [OPTIONS] COMMAND

Define and run multi-container applications with Docker (simulated)

Commands:
  build       Build or rebuild services
  config      Parse, resolve and render compose file in canonical format
  down        Stop and remove containers, networks
  exec        Execute a command in a running container
  logs        View output from containers
  ps          List containers
  restart     Restart service containers
  start       Start services
  stop        Stop services
  up          Create and start containers
`;

export function dockerCompose(ctx: CommandContext): number {
  const g = globals(ctx.args);
  const [sub, ...args] = g.rest;
  if (!sub || sub === '--help') {
    ctx.out(HELP);
    return 0;
  }
  if (sub === 'version') {
    ctx.out('Docker Compose version v2.29.7\n');
    return 0;
  }
  const known = ['up', 'down', 'ps', 'logs', 'build', 'start', 'stop', 'restart', 'exec', 'config'];
  if (!known.includes(sub)) {
    ctx.err(`unknown docker command: "compose ${sub}"\n`);
    return 1;
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  try {
    const project = loadProject(ctx.state, ctx.state.cwd, g.file, g.project);
    for (const w of project.warnings) ctx.note(w + '\n');
    switch (sub) {
      case 'up':
        return up(ctx, engine, project, args);
      case 'down': {
        const p = parseFlags(args, { flags: { '-v': { key: 'volumes' }, '--volumes': { key: 'volumes' } } });
        const lines = composeDown(engine, project, { volumes: !!p.opts.volumes });
        if (lines.length) ctx.note(lines.join('\n') + '\n');
        return 0;
      }
      case 'ps':
        return ps(ctx, engine, project, args);
      case 'logs':
        return logs(ctx, engine, project, args);
      case 'build': {
        const targets = project.services.filter((s) => s.build && (!args.length || args.includes(s.name)));
        for (const s of targets) buildService(ctx, engine, project, s.name);
        if (!targets.length) ctx.note('devquest: no services with a "build:" section\n');
        return 0;
      }
      case 'start':
      case 'stop':
      case 'restart':
        return lifecycle(ctx, engine, project, sub, args);
      case 'exec':
        return exec(ctx, engine, project, args);
      case 'config': {
        ctx.out(`name: ${project.name}\nservices:\n`);
        for (const s of project.services) {
          ctx.out(`  ${s.name}:\n    container_name: ${containerNameFor(project, s)}\n    image: ${imageNameFor(project, s)}\n`);
          if (s.ports.length) ctx.out(`    ports:\n${s.ports.map((x) => `      - ${x}\n`).join('')}`);
          if (s.environment.length) ctx.out(`    environment:\n${s.environment.map((x) => `      ${x.replace('=', ': ')}\n`).join('')}`);
          if (s.volumes.length) ctx.out(`    volumes:\n${s.volumes.map((x) => `      - ${x}\n`).join('')}`);
        }
        return 0;
      }
    }
  } catch (e) {
    return failure(ctx, e);
  }
  return 0;
}
