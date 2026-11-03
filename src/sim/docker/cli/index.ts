import type { CommandContext, CommandDef } from '../../shell/types';
import { dockerExec, dockerKill, dockerLogs, dockerPort, dockerPs, dockerRestart, dockerRm, dockerStart, dockerStop } from './containers';
import { dockerBuild } from './build';
import { dockerCompose } from './compose';
import { dockerImages, dockerPull, dockerRmi } from './images';
import { dockerInspect, dockerNetwork, dockerVolume } from './objects';
import { dockerCreate, dockerRun } from './run';

type Handler = (ctx: CommandContext, cmd?: string) => number;

const TOP: Record<string, Handler> = {
  run: dockerRun,
  create: dockerCreate,
  ps: dockerPs,
  start: dockerStart,
  stop: dockerStop,
  restart: dockerRestart,
  kill: dockerKill,
  rm: dockerRm,
  logs: dockerLogs,
  exec: dockerExec,
  port: dockerPort,
  inspect: dockerInspect,
  images: dockerImages,
  pull: dockerPull,
  rmi: dockerRmi,
  volume: dockerVolume,
  network: dockerNetwork,
  build: dockerBuild,
  compose: dockerCompose,
};

/** `docker container ...` / `docker image ...` management commands map onto the classic ones. */
const CONTAINER: Record<string, Handler> = {
  ls: dockerPs,
  list: dockerPs,
  ps: dockerPs,
  run: dockerRun,
  create: dockerCreate,
  start: dockerStart,
  stop: dockerStop,
  restart: dockerRestart,
  kill: dockerKill,
  rm: dockerRm,
  remove: dockerRm,
  logs: dockerLogs,
  exec: dockerExec,
  port: dockerPort,
  inspect: (ctx, cmd) => dockerInspect(ctx, cmd, 'container'),
};

const IMAGE: Record<string, Handler> = {
  ls: dockerImages,
  list: dockerImages,
  pull: dockerPull,
  rm: dockerRmi,
  remove: dockerRmi,
  build: dockerBuild,
  inspect: (ctx, cmd) => dockerInspect(ctx, cmd, 'image'),
};

/** Real docker commands not simulated (yet). */
const COMING_LATER: Record<string, string> = {
  push: 'a registry (DevOps Quest works offline)',
  login: 'a registry (DevOps Quest works offline)',
  swarm: 'Swarm mode',
};

const USAGE = `
Usage:  docker [OPTIONS] COMMAND

A self-sufficient runtime for containers (simulated by DevOps Quest)

Common Commands:
  run         Create and run a new container from an image
  build       Build an image from a Dockerfile
  exec        Execute a command in a running container
  ps          List containers
  images      List images
  pull        Download an image from a registry

Management Commands:
  compose     Docker Compose
  container   Manage containers
  image       Manage images
  network     Manage networks
  volume      Manage volumes

Commands:
  create      Create a new container
  inspect     Return low-level information on Docker objects
  kill        Kill one or more running containers
  logs        Fetch the logs of a container
  port        List port mappings or a specific mapping for the container
  restart     Restart one or more containers
  rm          Remove one or more containers
  rmi         Remove one or more images
  start       Start one or more stopped containers
  stop        Stop one or more running containers

Run 'docker COMMAND --help' for more information on a command.
`;

function dispatch(ctx: CommandContext, table: Record<string, Handler>, prefix: string): number {
  const [sub, ...rest] = ctx.args;
  if (!sub || sub === '--help') {
    ctx.out(prefix ? `\nUsage:  docker ${prefix} COMMAND\n\nCommands: ${Object.keys(table).join(', ')}\n` : USAGE);
    return 0;
  }
  if (rest.includes('--help')) {
    ctx.out(`Usage:  docker ${prefix ? prefix + ' ' : ''}${sub} [OPTIONS]\n\n(devquest supports the most common options of this command)\n`);
    return 0;
  }
  if (!prefix && (sub === 'container' || sub === 'image')) {
    return dispatch({ ...ctx, args: rest }, sub === 'container' ? CONTAINER : IMAGE, sub);
  }
  if (!prefix && (sub === '--version' || sub === '-v' || sub === 'version')) {
    ctx.out(sub === 'version' ? 'Client:\n Version:           27.3.1\n\nServer: Docker Engine - Community (simulated)\n Version:          27.3.1\n' : 'Docker version 27.3.1, build ce12230\n');
    return 0;
  }
  const h = table[sub];
  if (h) return h({ ...ctx, args: rest }, prefix ? `${prefix} ${sub}` : sub);
  if (!prefix && COMING_LATER[sub]) {
    ctx.err(`devquest: 'docker ${sub}' is a real command, but it needs ${COMING_LATER[sub]} and is not simulated\n`);
    return 1;
  }
  ctx.err(`docker: '${prefix ? prefix + ' ' : ''}${sub}' is not a docker command.\nSee 'docker --help'\n`);
  return 1;
}

export const docker: CommandDef = {
  name: 'docker',
  summary: 'manage containers, images, volumes and networks (simulated engine)',
  run: (ctx) => dispatch(ctx, TOP, ''),
};
