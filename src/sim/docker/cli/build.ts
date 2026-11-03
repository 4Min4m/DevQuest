import type { CommandContext } from '../../shell/types';
import { BuildError, buildImage } from '../build';
import { DockerError } from '../engine';
import { connect, parseFlags, UsageError, usage } from './common';

/** `docker build [-t name:tag] [-f Dockerfile] PATH` */
export function dockerBuild(ctx: CommandContext, cmd = 'build'): number {
  let p;
  try {
    p = parseFlags(ctx.args, {
      flags: {
        '-t': { value: true, key: 'tag' },
        '--tag': { value: true, key: 'tag' },
        '-f': { value: true, key: 'file' },
        '--file': { value: true, key: 'file' },
        '-q': { key: 'quiet' },
        '--quiet': { key: 'quiet' },
        '--no-cache': { key: 'noCache' },
        '--progress': { value: true, key: 'progress' },
        '--pull': { key: 'pull' },
      },
    });
    if (p.args.length !== 1) {
      throw new UsageError(`ERROR: "docker buildx build" requires exactly 1 argument.`, '[OPTIONS] PATH | URL | -', 1);
    }
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  const contextDir = ctx.resolve(p.args[0]);
  const dockerfile = typeof p.opts.file === 'string' ? ctx.resolve(p.opts.file) : `${contextDir === '/' ? '' : contextDir}/Dockerfile`;
  try {
    const { image, progress } = buildImage(
      { engine, host: ctx.state, spawn: (s) => ctx.shell.spawn(s) },
      { contextDir, dockerfile, tag: typeof p.opts.tag === 'string' ? p.opts.tag : undefined },
    );
    if (p.opts.quiet) ctx.out(`sha256:${image.id}\n`);
    else ctx.note(progress.join('\n') + '\n');
    return 0;
  } catch (e) {
    if (e instanceof BuildError) {
      if (e.detail.length) ctx.err(e.detail.join('\n') + '\n');
      ctx.err(`ERROR: failed to solve: ${e.message}\n`);
      return 1;
    }
    if (e instanceof DockerError) {
      ctx.err(`ERROR: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
