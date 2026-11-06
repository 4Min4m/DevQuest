/**
 * `docker build`: a small Dockerfile interpreter producing a real image in the
 * simulated engine. Output mimics BuildKit's progress display and its errors.
 */
import { segmentToRegExp } from '../shell/glob';
import type { ShellLike } from '../shell/types';
import type { SimState } from '../state';
import { basename, joinPath, normalize, resolvePath } from '../vfs/path';
import type { DirNode, FsNode } from '../vfs/types';
import { cloneNode, nodeSize, Vfs } from '../vfs/vfs';
import { parseRef } from './catalog';
import { DockerEngine, DockerError } from './engine';
import { hexId } from './format';
import type { Container, Image, ImageConfig } from './types';

/** A build failure: printed as "ERROR: failed to solve: <message>". */
export class BuildError extends Error {
  constructor(
    message: string,
    /** Lines to print before the ERROR line (failing step output, Dockerfile excerpt). */
    public readonly detail: string[] = [],
  ) {
    super(message);
  }
}

export interface Instruction {
  line: number;
  cmd: string;
  args: string;
  /** The instruction as written (for progress output). */
  raw: string;
}

const KNOWN = new Set([
  'FROM', 'RUN', 'CMD', 'ENTRYPOINT', 'COPY', 'ADD', 'WORKDIR', 'ENV', 'ARG', 'EXPOSE', 'USER', 'LABEL',
  'VOLUME', 'HEALTHCHECK', 'STOPSIGNAL', 'SHELL', 'ONBUILD', 'MAINTAINER',
]);

export function parseDockerfile(text: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let line = lines[i];
    if (/^\s*#/.test(line) || !line.trim()) continue;
    // Line continuations.
    while (/\\\s*$/.test(line) && i + 1 < lines.length) {
      line = line.replace(/\s*\\\s*$/, ' ') + lines[++i].trim();
    }
    const m = /^\s*(\S+)\s*(.*)$/.exec(line)!;
    const cmd = m[1].toUpperCase();
    if (!KNOWN.has(cmd)) throw new BuildError(`dockerfile parse error on line ${start + 1}: unknown instruction: ${m[1]}`);
    out.push({ line: start + 1, cmd, args: m[2].trim(), raw: `${cmd} ${m[2].trim()}`.trim() });
  }
  if (!out.length) throw new BuildError('the Dockerfile cannot be empty');
  return out;
}

/** JSON exec form (`["a","b"]`) or shell form (wrapped in /bin/sh -c). */
function execForm(args: string): string[] {
  if (args.startsWith('[')) {
    try {
      const v = JSON.parse(args);
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
    } catch {
      /* not valid JSON: docker treats it as shell form */
    }
  }
  return ['/bin/sh', '-c', args];
}

function substitute(s: string, vars: Record<string, string>): string {
  return s.replace(/\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g, (_m, a, def, b) => vars[a ?? b] ?? def ?? '');
}

/** key=value pairs (ENV/ARG/LABEL), also the legacy `ENV KEY value` form. */
function pairs(args: string): [string, string][] {
  if (!args.includes('=')) {
    const [k, ...rest] = args.split(/\s+/);
    return [[k, rest.join(' ')]];
  }
  const out: [string, string][] = [];
  const re = /(\w+)=("([^"]*)"|'([^']*)'|\S*)/g;
  let m;
  while ((m = re.exec(args))) out.push([m[1], m[3] ?? m[4] ?? m[2]]);
  return out;
}

function pad(text: string, time: string): string {
  return text.length >= 76 ? `${text} ${time}` : text.padEnd(76) + time.padStart(5);
}

interface BuildContext {
  engine: DockerEngine;
  host: SimState;
  spawn: (state: SimState) => ShellLike;
}

export interface BuildRequest {
  /** Absolute path of the build context on the host. */
  contextDir: string;
  /** Absolute path of the Dockerfile. */
  dockerfile: string;
  /** "name[:tag]" or undefined for an untagged image. */
  tag?: string;
}

export interface BuildOutput {
  image: Image;
  /** BuildKit-style progress lines (docker prints them on stderr). */
  progress: string[];
}

const ROOT = { name: 'root', groups: ['root'] };

export function validateTag(tag: string): { repository: string; tag: string } {
  const { repository, tag: t } = parseRef(tag);
  if (repository !== repository.toLowerCase()) {
    throw new DockerError(`invalid tag "${tag}": repository name must be lowercase`, 1);
  }
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(repository) || !/^[\w][\w.-]{0,127}$/.test(t)) {
    throw new DockerError(`invalid reference format: invalid tag "${tag}"`, 1);
  }
  return { repository, tag: t };
}

/** Read a .dockerignore file into matchers for top-level names / simple globs. */
function ignoreMatchers(vfs: Vfs, dir: string): RegExp[] {
  try {
    return vfs
      .readFile(joinPath(dir, '.dockerignore'))
      .split('\n')
      .map((l) => l.trim().replace(/^\.\//, '').replace(/\/$/, ''))
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => segmentToRegExp({ text: l, active: [...l].map(() => true) }));
  } catch {
    return [];
  }
}

export function buildImage(ctx: BuildContext, req: BuildRequest): BuildOutput {
  // Docker validates the tag before reading anything.
  const tag = req.tag ? validateTag(req.tag) : { repository: '<none>', tag: '<none>' };
  const hostVfs = new Vfs(ctx.host.fs, ROOT);
  let dockerfileText: string;
  try {
    dockerfileText = hostVfs.readFile(req.dockerfile);
  } catch {
    throw new BuildError(`failed to read dockerfile: open ${basename(req.dockerfile)}: no such file or directory`);
  }
  if (!hostVfs.isDir(req.contextDir)) throw new BuildError(`unable to prepare context: path "${req.contextDir}" not found`);
  const instructions = parseDockerfile(dockerfileText);
  const firstReal = instructions.find((i) => i.cmd !== 'ARG');
  if (!firstReal || firstReal.cmd !== 'FROM') throw new BuildError('no build stage in current context');
  if (instructions.filter((i) => i.cmd === 'FROM').length > 1) {
    throw new BuildError('devquest: multi-stage builds (several FROM lines) are not supported yet');
  }
  const ignore = ignoreMatchers(hostVfs, req.contextDir);
  const ignored = (name: string) => ignore.some((re) => re.test(name));

  const steps = instructions.filter((i) => !['ARG', 'MAINTAINER'].includes(i.cmd) || i.line > firstReal.line);
  const total = steps.filter((i) => ['FROM', 'RUN', 'COPY', 'ADD', 'WORKDIR'].includes(i.cmd)).length;
  const progress: string[] = [
    pad(' => [internal] load build definition from ' + basename(req.dockerfile), '0.0s'),
    pad(` => => transferring dockerfile: ${dockerfileText.length}B`, '0.0s'),
  ];
  const vars: Record<string, string> = {};
  for (const i of instructions) {
    if (i.cmd === 'ARG' && i.line < firstReal.line) for (const [k, v] of pairs(i.args)) vars[k] = v;
  }

  // ------------------------------------------------------------ FROM
  const fromRef = substitute(firstReal.args.split(/\s+/)[0], vars);
  let base: Image;
  try {
    base = ctx.engine.findImage(fromRef) ?? ctx.engine.pull(fromRef).image;
  } catch (e) {
    const { repository, tag } = parseRef(fromRef);
    if (e instanceof DockerError) {
      throw new BuildError(`${repository}:${tag}: failed to resolve source metadata for docker.io/library/${repository}:${tag}: ${e.message}`);
    }
    throw e;
  }
  const { repository: baseRepo, tag: baseTag } = parseRef(fromRef);
  progress.push(pad(` => [internal] load metadata for docker.io/library/${baseRepo}:${baseTag}`, '0.4s'));
  progress.push(pad(' => [internal] load .dockerignore', '0.0s'));

  const fs: DirNode = base.fs ? cloneNode(base.fs) : ctx.engine.imageFsOf(base);
  const config: ImageConfig = structuredClone(base.config);
  const lacks = [...base.lacks];
  const shells = [...base.shells];
  let size = base.size;
  let stepNo = 0;
  const content: string[] = [base.id];
  const vfs = new Vfs(fs, ROOT);
  const env = () => Object.fromEntries(config.env.map((e) => [e.split('=')[0], e.slice(e.indexOf('=') + 1)]));

  const fail = (instr: Instruction, message: string, output: string[] = []): never => {
    const excerpt = dockerfileText.split('\n');
    throw new BuildError(message, [
      pad(` => ERROR [${stepNo}/${total}] ${instr.raw}`, '0.3s'),
      '------',
      ` > [${stepNo}/${total}] ${instr.raw}:`,
      ...output.map((l) => `0.245 ${l}`),
      '------',
      `${basename(req.dockerfile)}:${instr.line}`,
      '--------------------',
      ...excerpt
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ n }) => Math.abs(n - instr.line) <= 1)
        .map(({ l, n }) => `${String(n).padStart(4)} | ${n === instr.line ? '>>> ' : '    '}${l}`),
      '--------------------',
    ]);
  };

  /** A throwaway container over the build filesystem, for RUN. */
  const buildContainer = (): Container => ({
    id: hexId('build-' + content.join('|')),
    name: 'buildkit',
    image: fromRef,
    imageId: base.id,
    argv: [],
    env: config.env,
    workdir: config.workdir || '/',
    created: ctx.host.clock,
    status: 'running',
    exitCode: 0,
    startedAt: ctx.host.clock,
    finishedAt: 0,
    restartPolicy: 'no',
    restartCount: 0,
    ports: [],
    exposedPorts: [],
    mounts: [],
    networks: {},
    autoRemove: false,
    logs: [],
    fs,
    listening: [],
    program: '',
    requests: 0,
    labels: {},
  });

  stepNo = 1;
  progress.push(pad(` => [1/${total}] FROM docker.io/library/${baseRepo}:${baseTag}`, '0.0s'));

  for (const instr of steps) {
    if (instr === firstReal) continue;
    const args = substitute(instr.args, { ...vars, ...env() });
    switch (instr.cmd) {
      case 'ARG':
        for (const [k, v] of pairs(args)) if (!(k in vars)) vars[k] = v;
        break;
      case 'ENV':
        for (const [k, v] of pairs(args)) config.env = [...config.env.filter((e) => !e.startsWith(k + '=')), `${k}=${v}`];
        break;
      case 'LABEL':
      case 'MAINTAINER':
      case 'STOPSIGNAL':
      case 'HEALTHCHECK':
      case 'SHELL':
      case 'ONBUILD':
      case 'VOLUME':
      case 'USER':
        break;
      case 'EXPOSE':
        for (const p of args.split(/\s+/)) {
          const spec = p.includes('/') ? p : `${p}/tcp`;
          if (!/^\d+\/(tcp|udp)$/.test(spec)) fail(instr, `invalid containerPort: ${p}`);
          if (!config.exposedPorts.includes(spec)) config.exposedPorts.push(spec);
        }
        break;
      case 'CMD':
        config.cmd = execForm(args);
        break;
      case 'ENTRYPOINT':
        config.entrypoint = execForm(args);
        // Setting ENTRYPOINT resets the inherited CMD.
        if (!steps.some((s) => s.cmd === 'CMD' && s.line > instr.line)) config.cmd = [];
        break;
      case 'WORKDIR': {
        stepNo++;
        config.workdir = resolvePath(config.workdir || '/', args);
        vfs.mkdir(config.workdir, { parents: true });
        progress.push(pad(` => [${stepNo}/${total}] ${instr.raw}`, '0.0s'));
        content.push(instr.raw);
        break;
      }
      case 'COPY':
      case 'ADD': {
        stepNo++;
        const parts = args.split(/\s+/).filter((a) => !a.startsWith('--chown') && !a.startsWith('--chmod'));
        if (parts.some((a) => a.startsWith('--from'))) fail(instr, 'devquest: COPY --from (multi-stage) is not supported yet');
        if (parts.length < 2) fail(instr, `${instr.cmd} requires at least two arguments, but only one was provided. Destination could not be determined`);
        const dest = parts[parts.length - 1];
        const sources = parts.slice(0, -1);
        if (sources.some((s) => /^https?:\/\//.test(s))) fail(instr, 'devquest: ADD from URLs is not supported (no network access)');
        const destAbs = resolvePath(config.workdir || '/', dest);
        const many = sources.length > 1 || sources.some((s) => /[*?]/.test(s));
        const intoDir = dest.endsWith('/') || dest === '.' || many || vfs.isDir(destAbs);
        if (many && !dest.endsWith('/') && !vfs.isDir(destAbs) && dest !== '.') {
          fail(instr, `When using COPY with more than one source file, the destination must be a directory and end with a /`);
        }
        let copiedBytes = 0;
        for (const src of sources) {
          const srcClean = normalize('/' + src).slice(1);
          const matches: string[] = [];
          if (/[*?]/.test(srcClean)) {
            const re = segmentToRegExp({ text: basename(srcClean), active: [...basename(srcClean)].map(() => true) });
            const dir = joinPath(req.contextDir, srcClean.includes('/') ? srcClean.slice(0, srcClean.lastIndexOf('/')) : '');
            for (const n of hostVfs.isDir(dir) ? hostVfs.readdir(dir) : []) if (re.test(n) && !ignored(n)) matches.push(joinPath(dir, n));
          } else {
            const abs = srcClean ? joinPath(req.contextDir, srcClean) : req.contextDir;
            if (!hostVfs.exists(abs) || (srcClean && ignored(srcClean.split('/')[0]))) {
              fail(
                instr,
                `failed to compute cache key: failed to calculate checksum of ref ${hexId('ref' + src).slice(0, 25)}::${hexId('ck' + src).slice(0, 25)}: "/${srcClean}": not found`,
              );
            }
            matches.push(abs);
          }
          for (const abs of matches) {
            const node = hostVfs.lookup(abs);
            if (node.type === 'dir') {
              // Docker copies the *contents* of a directory, not the directory itself.
              vfs.mkdir(destAbs, { parents: true });
              const dirNode = vfs.lookup(destAbs) as DirNode;
              for (const [name, child] of Object.entries(node.children)) {
                if (abs === req.contextDir && ignored(name)) continue;
                dirNode.children[name] = chownTree(cloneNode(child));
                copiedBytes += treeSize(child);
              }
            } else {
              const target = intoDir ? joinPath(destAbs, basename(abs)) : destAbs;
              vfs.mkdir(target.replace(/\/[^/]+$/, '') || '/', { parents: true });
              vfs.writeFile(target, node.content);
              vfs.chmod(target, node.mode);
              copiedBytes += nodeSize(node);
              content.push(node.content);
            }
          }
        }
        size += copiedBytes;
        progress.push(pad(` => [${stepNo}/${total}] ${instr.raw}`, '0.0s'));
        content.push(instr.raw);
        break;
      }
      case 'RUN': {
        stepNo++;
        const script = args.startsWith('[') ? execForm(args).join(' ') : args;
        const output: string[] = [];
        const container = buildContainer();
        const state = ctx.engine.containerState(container, 'sh');
        state.context!.lacks = lacks;
        let code = 0;
        for (const segment of script.split(/\s*&&\s*/)) {
          const r = runSegment(segment.trim(), { state, lacks, shells, baseRepo, spawn: ctx.spawn, output, vfs, workdir: config.workdir || '/' });
          size += r.bytes;
          code = r.code;
          if (code !== 0) break;
        }
        if (code !== 0) fail(instr, `process "/bin/sh -c ${script}" did not complete successfully: exit code: ${code}`, output);
        progress.push(pad(` => [${stepNo}/${total}] ${instr.raw}`, '1.2s'));
        content.push(instr.raw);
        break;
      }
    }
  }

  const id = hexId('image-build-' + content.join('\u0000') + JSON.stringify(config));
  progress.push(pad(' => exporting to image', '0.1s'), pad(' => => exporting layers', '0.1s'), pad(` => => writing image sha256:${id}`, '0.0s'));
  if (req.tag) progress.push(pad(` => => naming to ${/^[^/]+[.:][^/]*\//.test(tag.repository) ? '' : tag.repository.includes('/') ? 'docker.io/' : 'docker.io/library/'}${tag.repository}:${tag.tag}`, '0.0s'));
  progress.unshift(`[+] Building 2.4s (${stepNo + 3}/${stepNo + 3}) FINISHED`.padEnd(70) + 'docker:default');

  const images = ctx.engine.d.images;
  // Re-using a tag leaves the previous image dangling as <none>:<none>.
  for (const old of images) {
    if (old.repository === tag.repository && old.tag === tag.tag && old.id !== id && tag.repository !== '<none>') {
      old.repository = '<none>';
      old.tag = '<none>';
    }
  }
  let image = images.find((i) => i.id === id && i.repository === tag.repository && i.tag === tag.tag);
  if (!image) {
    image = { id, repository: tag.repository, tag: tag.tag, fs, created: ctx.host.clock, size, config, shells, lacks, digest: hexId('digest-' + id) };
    images.push(image);
  }
  return { image, progress };
}

function chownTree<T extends FsNode>(n: T): T {
  n.owner = 'root';
  n.group = 'root';
  if (n.type === 'dir') for (const c of Object.values(n.children)) chownTree(c);
  return n;
}

function treeSize(n: FsNode): number {
  return n.type === 'dir' ? Object.values(n.children).reduce((s, c) => s + treeSize(c), 0) : nodeSize(n);
}

// ------------------------------------------------------------------ RUN helpers

/** Package names that provide tools the images may lack. */
const PROVIDES: Record<string, string[]> = { curl: ['curl'], procps: ['ps'], 'procps-ng': ['ps'], bash: ['bash'] };

interface SegmentEnv {
  state: SimState;
  lacks: string[];
  shells: string[];
  baseRepo: string;
  spawn: (state: SimState) => ShellLike;
  output: string[];
  vfs: Vfs;
  workdir: string;
}

function install(pkgs: string[], env: SegmentEnv): void {
  for (const p of pkgs) {
    for (const tool of PROVIDES[p] ?? []) {
      if (tool === 'bash') {
        if (!env.shells.includes('bash')) env.shells.push('bash');
      } else {
        const i = env.lacks.indexOf(tool);
        if (i >= 0) env.lacks.splice(i, 1);
      }
    }
  }
}

function runSegment(segment: string, env: SegmentEnv): { code: number; bytes: number } {
  const words = segment.split(/\s+/);
  const [cmd, sub] = words;
  const alpine = !env.shells.includes('bash') || env.baseRepo === 'alpine';
  const notFound = (name: string) => {
    env.output.push(alpine ? `/bin/sh: ${name}: not found` : `/bin/sh: 1: ${name}: not found`);
    return { code: 127, bytes: 0 };
  };
  const pkgsOf = (from: number) => words.slice(from).filter((w) => !w.startsWith('-'));
  if (cmd === 'apt-get' || cmd === 'apt') {
    if (alpine || env.baseRepo === 'mysql') return notFound(cmd);
    if (sub === 'update') {
      env.output.push('Get:1 http://deb.debian.org/debian bookworm InRelease [151 kB]', 'Reading package lists...');
      return { code: 0, bytes: 0 };
    }
    if (sub === 'install') {
      const pkgs = pkgsOf(2);
      if (!words.includes('-y') && !words.includes('--yes') && !words.includes('-qy')) {
        env.output.push('Reading package lists...', 'Do you want to continue? [Y/n] Abort.');
        return { code: 1, bytes: 0 };
      }
      install(pkgs, env);
      env.output.push(...pkgs.map((p) => `Setting up ${p} ...`));
      return { code: 0, bytes: pkgs.length * 12_000_000 };
    }
    return { code: 0, bytes: 0 };
  }
  if (cmd === 'apk') {
    if (!alpine) return notFound('apk');
    if (sub === 'add') {
      const pkgs = pkgsOf(2);
      install(pkgs, env);
      env.output.push(...pkgs.map((p, i) => `(${i + 1}/${pkgs.length}) Installing ${p}`), 'OK: 12 MiB in 20 packages');
      return { code: 0, bytes: pkgs.length * 3_000_000 };
    }
    return { code: 0, bytes: 0 };
  }
  if (cmd === 'pip' || cmd === 'pip3') {
    if (!env.baseRepo.startsWith('python')) return notFound(cmd);
    const r = words.indexOf('-r');
    if (r >= 0) {
      const file = resolvePath(env.workdir, words[r + 1] ?? '');
      if (!env.vfs.exists(file)) {
        env.output.push(`ERROR: Could not open requirements file: [Errno 2] No such file or directory: '${words[r + 1]}'`);
        return { code: 1, bytes: 0 };
      }
    }
    env.output.push(`Successfully installed ${pkgsOf(2).filter((p) => p !== words[r + 1]).join(' ') || 'requirements'}`);
    return { code: 0, bytes: 25_000_000 };
  }
  if (cmd === 'npm') {
    if (!env.baseRepo.startsWith('node')) return notFound('npm');
    if (sub === 'install' || sub === 'ci' || sub === 'i') {
      const pkg = resolvePath(env.workdir, 'package.json');
      if (!env.vfs.exists(pkg)) {
        env.output.push(
          'npm error code ENOENT',
          'npm error syscall open',
          `npm error path ${pkg}`,
          'npm error errno -2',
          `npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${pkg}'`,
        );
        return { code: 254, bytes: 0 };
      }
      env.vfs.mkdir(resolvePath(env.workdir, 'node_modules'), { parents: true });
      env.output.push('added 64 packages, and audited 65 packages in 2s', 'found 0 vulnerabilities');
      return { code: 0, bytes: 30_000_000 };
    }
    return { code: 0, bytes: 0 };
  }
  const shell = env.spawn(env.state);
  const r = shell.run(segment);
  for (const chunk of r.output) env.output.push(...chunk.text.split('\n').filter(Boolean));
  return { code: r.exitCode, bytes: 0 };
}
