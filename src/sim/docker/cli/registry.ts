/** docker tag / login / logout / push — against the simulated registry (ghcr.io, docker.io, registry.gitlab.com). */
import { fullImageRef, registryHost, registryPush } from '../../forge';
import type { CommandContext } from '../../shell/types';
import { parseRef } from '../catalog';
import { hexId } from '../format';
import { connect, parseFlags, requireArgs, usage } from './common';

export const KNOWN_REGISTRIES = ['docker.io', 'ghcr.io', 'registry.gitlab.com', 'quay.io', 'localhost:5000'];

const host = (ctx: CommandContext) => ctx.state.runner?.host ?? ctx.state;

export function dockerTag(ctx: CommandContext, cmd = 'tag'): number {
  let p;
  try {
    p = parseFlags(ctx.args, { flags: {} });
    if (p.args.length !== 2) throw Object.assign(new Error(), { name: 'x' });
  } catch (e) {
    if (e instanceof Error && e.name === 'x') {
      ctx.err(`"docker ${cmd}" requires exactly 2 arguments.\nSee 'docker ${cmd} --help'.\n\nUsage:  docker ${cmd} SOURCE_IMAGE[:TAG] TARGET_IMAGE[:TAG]\n\nCreate a tag TARGET_IMAGE that refers to SOURCE_IMAGE\n`);
      return 1;
    }
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  const [src, dst] = p.args;
  const image = engine.findImage(src);
  if (!image) {
    const { repository, tag } = parseRef(src);
    ctx.err(`Error response from daemon: No such image: ${repository}:${tag}\n`);
    return 1;
  }
  if (!/^[a-z0-9]+([._/:-][a-z0-9]+)*$/.test(dst.replace(/:[\w][\w.-]*$/, '')) || /[A-Z]/.test(dst)) {
    ctx.err(`Error parsing reference: "${dst}" is not a valid repository/tag: invalid reference format${/[A-Z]/.test(dst) ? ': repository name must be lowercase' : ''}\n`);
    return 1;
  }
  const { repository, tag } = parseRef(dst);
  engine.d.images = engine.d.images.filter((i) => !(i.repository === repository && i.tag === tag));
  engine.d.images.push({ ...structuredClone(image), repository, tag, fs: image.fs });
  return 0;
}

export function dockerLogin(ctx: CommandContext, cmd = 'login'): number {
  let p;
  try {
    p = parseFlags(ctx.args, {
      flags: { '-u': { key: 'user', value: true }, '--username': { key: 'user', value: true }, '-p': { key: 'pass', value: true }, '--password': { key: 'pass', value: true }, '--password-stdin': { key: 'stdin' } },
    });
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const server = p.args[0] ?? 'docker.io';
  const shown = server === 'docker.io' ? 'https://index.docker.io/v1/' : server;
  if (!KNOWN_REGISTRIES.includes(server.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))) {
    ctx.err(`Error response from daemon: Get "https://${server}/v2/": dial tcp: lookup ${server}: no such host\n`);
    return 1;
  }
  let pass = p.opts.pass as string | undefined;
  if (p.opts.stdin) {
    if (pass) {
      ctx.err('--password and --password-stdin are mutually exclusive\n');
      return 1;
    }
    if (!p.opts.user) {
      ctx.err('Must provide --username with --password-stdin\n');
      return 1;
    }
    pass = ctx.stdin.replace(/\r?\n$/, '');
    if (!pass) {
      ctx.err('Error: Password Required\n');
      return 1;
    }
  }
  if (!p.opts.user || pass === undefined) {
    ctx.err('Error: Cannot perform an interactive login from a non TTY device\n');
    return 1;
  }
  if (!pass) {
    ctx.err('Error: Password Required\n');
    return 1;
  }
  if (p.opts.pass) ctx.note('WARNING! Using --password via the CLI is insecure. Use --password-stdin.\n');
  ctx.state.dockerAuths = { ...(ctx.state.dockerAuths ?? {}), [server.replace(/^https?:\/\//, '')]: String(p.opts.user) };
  void shown;
  ctx.out('Login Succeeded\n');
  return 0;
}

export function dockerLogout(ctx: CommandContext): number {
  const server = ctx.args[0] ?? 'docker.io';
  if (!ctx.state.dockerAuths?.[server]) {
    ctx.err(`Not logged in to ${server === 'docker.io' ? 'https://index.docker.io/v1/' : server}\n`);
    return 0;
  }
  delete ctx.state.dockerAuths[server];
  ctx.out(`Removing login credentials for ${server === 'docker.io' ? 'https://index.docker.io/v1/' : server}\n`);
  return 0;
}

export function dockerPush(ctx: CommandContext, cmd = 'push'): number {
  let p;
  try {
    p = parseFlags(ctx.args, { flags: { '-q': { key: 'quiet' }, '--quiet': { key: 'quiet' }, '-a': { key: 'all' }, '--all-tags': { key: 'all' } } });
    requireArgs(cmd, p.args, 1, '[OPTIONS] NAME[:TAG]');
  } catch (e) {
    return usage(ctx, cmd, e);
  }
  const engine = connect(ctx);
  if (typeof engine === 'number') return engine;
  const ref = p.args[0];
  const { repository, tag } = parseRef(ref);
  const explicitTag = /:[^/]+$/.test(ref);
  if (!explicitTag && !p.opts.all) ctx.out('Using default tag: latest\n');
  const images = p.opts.all ? engine.d.images.filter((i) => i.repository === repository) : engine.d.images.filter((i) => i.repository === repository && i.tag === tag);
  if (!images.length) {
    ctx.err(engine.d.images.some((i) => i.repository === repository) ? `tag does not exist: ${repository}:${tag}\n` : `An image does not exist locally with the tag: ${repository}\n`);
    return 1;
  }
  const reg = registryHost(repository);
  const full = fullImageRef(`${repository}:${tag}`);
  ctx.out(`The push refers to repository [${full.replace(/:[^/:]+$/, '')}]\n`);
  if (!KNOWN_REGISTRIES.includes(reg)) {
    ctx.err(`Get "https://${reg}/v2/": dial tcp: lookup ${reg}: no such host\n`);
    return 1;
  }
  const layers = [0, 1, 2].map((n) => hexId(`push-layer-${images[0].id}-${n}`).slice(0, 12));
  const official = reg === 'docker.io' && !repository.replace(/^docker\.io\//, '').includes('/');
  if (official || !ctx.state.dockerAuths?.[reg]) {
    for (const l of layers) ctx.out(`${l}: Preparing\n`);
    ctx.err(
      reg === 'ghcr.io'
        ? 'unauthorized: unauthenticated: User cannot be authenticated with the token provided.\n'
        : reg === 'registry.gitlab.com'
          ? 'unauthorized: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect or you\'re required to use a token instead of a password.\n'
          : 'denied: requested access to the resource is denied\n',
    );
    return 1;
  }
  for (const image of images) {
    for (const l of layers) ctx.out(`${l}: Pushed\n`);
    const digest = hexId(`manifest-${image.id}-${image.repository}:${image.tag}`);
    registryPush(host(ctx), `${image.repository}:${image.tag}`, digest);
    ctx.out(`${image.tag}: digest: sha256:${digest} size: 1572\n`);
    ctx.state.clock += 2000;
  }
  return 0;
}
