import type { CommandContext } from '../../shell/types';
import { parseRef } from '../catalog';
import { humanDuration, humanSize, shortId, table } from '../format';
import { connect, daemonError, parseFlags, requireArgs, usage } from './common';

export function dockerImages(ctx: CommandContext, cmd = 'images'): number {
  let p;
  try {
    p = parseFlags(ctx.args, {
      flags: { '-q': { key: 'quiet' }, '--quiet': { key: 'quiet' }, '-a': { key: 'all' }, '--all': { key: 'all' }, '--no-trunc': { key: 'noTrunc' } },
    });
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  let list = [...engine.d.images].sort((a, b) => b.created - a.created || (a.repository < b.repository ? -1 : 1));
  if (p.args[0]) {
    const { repository, tag } = parseRef(p.args[0]);
    list = list.filter((i) => i.repository === repository && (!p.args[0].includes(':') || i.tag === tag));
  }
  const id = (h: string) => (p.opts.noTrunc ? `sha256:${h}` : shortId(h));
  if (p.opts.quiet) {
    for (const i of [...new Map(list.map((i) => [i.id, i])).values()]) ctx.out(id(i.id) + '\n');
    return 0;
  }
  const rows = [['REPOSITORY', 'TAG', 'IMAGE ID', 'CREATED', 'SIZE']];
  for (const i of list) rows.push([i.repository, i.tag, id(i.id), `${humanDuration(engine.now - i.created)} ago`, humanSize(i.size)]);
  ctx.out(table(rows));
  return 0;
}

export function dockerPull(ctx: CommandContext, cmd = 'pull'): number {
  let p;
  try {
    p = parseFlags(ctx.args, { flags: { '-q': { key: 'quiet' }, '--quiet': { key: 'quiet' } } });
    requireArgs(cmd, p.args, 1, '[OPTIONS] NAME[:TAG|@DIGEST]');
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  const ref = p.args[0];
  const { repository, tag } = parseRef(ref);
  if (!p.opts.quiet && !/:[^/]+$/.test(ref)) ctx.out('Using default tag: latest\n');
  try {
    const { lines } = engine.pull(ref);
    if (!p.opts.quiet) ctx.out(lines.join('\n') + '\n');
    ctx.out(`docker.io/library/${repository}:${tag}\n`);
    return 0;
  } catch (e) {
    return daemonError(ctx, e);
  }
}

export function dockerRmi(ctx: CommandContext, cmd = 'rmi'): number {
  let p;
  try {
    p = parseFlags(ctx.args, { flags: { '-f': { key: 'force' }, '--force': { key: 'force' } } });
    requireArgs(cmd, p.args, 1, '[OPTIONS] IMAGE [IMAGE...]');
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  let code = 0;
  for (const ref of p.args) {
    try {
      ctx.out(engine.removeImage(ref, !!p.opts.force).join('\n') + '\n');
    } catch (e) {
      code = daemonError(ctx, e) && 1;
    }
  }
  return code;
}
