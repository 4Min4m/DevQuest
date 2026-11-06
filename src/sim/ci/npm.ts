/**
 * A simulated Node.js toolchain: `npm ci|install|test|run`, `node --version`. Test, lint and build
 * results come from the mission's project spec (by package name), evaluated against the files on disk.
 */
import type { CommandContext, CommandDef } from '../shell/types';
import { joinPath } from '../vfs/path';
import type { ProjectSpec } from '../forge/types';

const NODE_VERSIONS: Record<string, string> = { '16': 'v16.20.2', '18': 'v18.20.4', '20': 'v20.18.0', '22': 'v22.11.0', lts: 'v22.11.0', latest: 'v23.1.0' };

export function nodeVersion(spec: string | undefined): string {
  const v = String(spec ?? '20').replace(/^v/, '').replace(/\.x$/, '');
  return NODE_VERSIONS[v.split('.')[0]] ?? NODE_VERSIONS[v] ?? (v.split('.').length === 3 ? `v${v}` : 'v20.18.0');
}

function logPath(ctx: CommandContext): string {
  const t = new Date(ctx.state.clock).toISOString().replace(/[:.]/g, '_');
  return `${ctx.env.HOME ?? '/root'}/.npm/_logs/${t}-debug-0.log`;
}

function npmError(ctx: CommandContext, lines: string[]): number {
  ctx.err(lines.map((l) => `npm error ${l}`.trimEnd() + '\n').join('') + `npm error A complete log of this run can be found in: ${logPath(ctx)}\n`);
  return 1;
}

interface Pkg {
  name: string;
  version: string;
  scripts: Record<string, string>;
}

function readPkg(ctx: CommandContext): Pkg | { error: number } {
  const path = joinPath(ctx.state.cwd, 'package.json');
  if (!ctx.vfs.exists(path)) {
    return {
      error: npmError(ctx, [
        'code ENOENT',
        'syscall open',
        `path ${path}`,
        'errno -2',
        `enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${path}'`,
        'enoent This is related to npm not being able to find a file.',
        'enoent',
      ]),
    };
  }
  try {
    const j = JSON.parse(ctx.vfs.readFile(path));
    return { name: j.name ?? 'app', version: j.version ?? '1.0.0', scripts: j.scripts ?? {} };
  } catch (e) {
    return { error: npmError(ctx, ['code EJSONPARSE', `JSON.parse Invalid package.json: JSONParseError: ${(e as Error).message}`, 'JSON.parse Failed to parse JSON data.', 'JSON.parse Note: package.json must be actual JSON, not just JavaScript.']) };
  }
}

function spec(ctx: CommandContext, pkg: Pkg): ProjectSpec {
  return (ctx.state.runner?.host.projects ?? ctx.state.projects)?.[pkg.name] ?? {};
}

const read = (ctx: CommandContext, rel: string): string | null => {
  const p = joinPath(ctx.state.cwd, rel);
  try {
    return ctx.vfs.readFile(p);
  } catch {
    return null;
  }
};

/** Installing dependencies: slow the first time, fast with a warm npm cache (actions/cache, setup-node cache). */
function install(ctx: CommandContext, pkg: Pkg, clean: boolean): number {
  const lock = joinPath(ctx.state.cwd, 'package-lock.json');
  if (clean && !ctx.vfs.exists(lock)) {
    return npmError(ctx, [
      'code EUSAGE',
      '',
      'The `npm ci` command can only install with an existing package-lock.json or',
      'npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or',
      'later to generate a package-lock.json file, then try again.',
      '',
      'Clean install a project',
      '',
      'Usage:',
      'npm ci',
    ]);
  }
  const cacheDir = `${ctx.env.HOME ?? '/root'}/.npm/_cacache`;
  const warm = ctx.vfs.exists(cacheDir);
  const secs = warm ? 2 : 9;
  ctx.state.clock += (secs - 1) * 1000;
  const nm = joinPath(ctx.state.cwd, 'node_modules');
  if (clean && ctx.vfs.exists(nm)) ctx.vfs.remove(nm, { recursive: true });
  ctx.vfs.mkdir(joinPath(nm, '.bin'), { parents: true });
  ctx.vfs.writeFile(joinPath(nm, '.package-lock.json'), `{\n  "name": "${pkg.name}",\n  "lockfileVersion": 3\n}\n`);
  if (!ctx.vfs.exists(lock)) ctx.vfs.writeFile(lock, `{\n  "name": "${pkg.name}",\n  "version": "${pkg.version}",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {}\n}\n`);
  try {
    if (!ctx.vfs.exists(cacheDir)) ctx.vfs.mkdir(cacheDir, { parents: true });
    ctx.vfs.writeFile(`${cacheDir}/index-v5`, 'cached\n');
  } catch {
    /* read-only home: no cache */
  }
  ctx.out(`\nadded 312 packages, and audited 313 packages in ${secs}s\n\n58 packages are looking for funding\n  run \`npm fund\` for details\n\nfound 0 vulnerabilities\n`);
  return 0;
}

function needModules(ctx: CommandContext, bin: string): boolean {
  if (ctx.vfs.exists(joinPath(ctx.state.cwd, 'node_modules'))) return true;
  ctx.err(`sh: 1: ${bin}: not found\n`);
  return false;
}

function runJest(ctx: CommandContext, pkg: Pkg): number {
  if (!needModules(ctx, 'jest')) return 127;
  const tests = spec(ctx, pkg).tests ?? [{ suite: 'src/app.test.js', name: 'app › starts', file: 'package.json', failure: '' }];
  const bySuite = new Map<string, { name: string; ok: boolean; failure: string }[]>();
  for (const t of tests) {
    const text = read(ctx, t.file);
    const ok = text !== null && (!t.regex || new RegExp(t.regex, 'm').test(text)) && (!t.absent || !new RegExp(t.absent, 'm').test(text));
    const failure = text === null ? `Cannot find module '../${t.file.replace(/^src\//, '')}' from '${t.suite}'` : t.failure;
    (bySuite.get(t.suite) ?? bySuite.set(t.suite, []).get(t.suite)!).push({ name: t.name, ok, failure });
  }
  ctx.state.clock += 2000;
  let out = '';
  let failedSuites = 0;
  for (const [suite, results] of bySuite) {
    const failed = results.filter((r) => !r.ok);
    if (failed.length) failedSuites++;
    out += `${failed.length ? 'FAIL' : 'PASS'} ${suite}\n`;
    for (const f of failed) {
      out += `  ● ${f.name}\n\n${f.failure
        .split('\n')
        .map((l) => (l ? `    ${l}` : ''))
        .join('\n')}\n\n`;
    }
  }
  const total = tests.length;
  const failedTests = [...bySuite.values()].flat().filter((r) => !r.ok).length;
  const suites = bySuite.size;
  const part = (n: number, word: string) => (n ? `${n} ${word}, ` : '');
  out += `\nTest Suites: ${part(failedSuites, 'failed')}${part(suites - failedSuites, 'passed')}${suites} total\n`;
  out += `Tests:       ${part(failedTests, 'failed')}${part(total - failedTests, 'passed')}${total} total\n`;
  out += `Snapshots:   0 total\nTime:        ${(1.2 + total * 0.11).toFixed(2)} s\nRan all test suites.\n`;
  // Jest reports on stderr. A passing report isn't an error, so it isn't shown as one.
  if (failedTests) ctx.err(out);
  else ctx.note(out);
  return failedTests ? 1 : 0;
}

function runLint(ctx: CommandContext, pkg: Pkg): number {
  if (!needModules(ctx, 'eslint')) return 127;
  const problems: { file: string; message: string }[] = [];
  for (const r of spec(ctx, pkg).lint ?? []) {
    const text = read(ctx, r.file);
    if (text !== null && new RegExp(r.pattern, 'm').test(text)) problems.push({ file: r.file, message: r.message });
  }
  ctx.state.clock += 1000;
  if (!problems.length) return 0;
  let out = '';
  for (const file of [...new Set(problems.map((p) => p.file))]) {
    out += `\n${joinPath(ctx.state.cwd, file)}\n${problems
      .filter((p) => p.file === file)
      .map((p) => `  ${p.message}\n`)
      .join('')}`;
  }
  out += `\n✖ ${problems.length} problem${problems.length > 1 ? 's' : ''} (${problems.length} error${problems.length > 1 ? 's' : ''}, 0 warnings)\n\n`;
  ctx.out(out);
  return 1;
}

function runBuild(ctx: CommandContext, pkg: Pkg): number {
  if (!needModules(ctx, 'vite')) return 127;
  const files = spec(ctx, pkg).build ?? {
    'dist/index.html': `<!doctype html>\n<html><head><title>${pkg.name}</title><script type="module" src="/assets/index-4f2a1c9b.js"></script></head><body><div id="app"></div></body></html>\n`,
    'dist/assets/index-4f2a1c9b.js': `console.log("${pkg.name} ${pkg.version}");\n`,
  };
  ctx.state.clock += 3000;
  let out = 'vite v5.4.10 building for production...\ntransforming...\n✓ 34 modules transformed.\nrendering chunks...\ncomputing gzip size...\n';
  for (const [rel, content] of Object.entries(files)) {
    const abs = joinPath(ctx.state.cwd, rel);
    const parent = abs.replace(/\/[^/]+$/, '');
    if (!ctx.vfs.exists(parent)) ctx.vfs.mkdir(parent, { parents: true });
    ctx.vfs.writeFile(abs, content);
    const kb = (new TextEncoder().encode(content).length / 1000).toFixed(2);
    out += `${rel.padEnd(36)}${kb.padStart(6)} kB │ gzip: ${(Number(kb) * 0.6).toFixed(2).padStart(5)} kB\n`;
  }
  ctx.out(out + '✓ built in 1.21s\n');
  return 0;
}

function runScript(ctx: CommandContext, pkg: Pkg, name: string): number {
  const cmd = pkg.scripts[name];
  if (cmd === undefined) {
    return npmError(ctx, [`Missing script: "${name}"`, '', 'To see a list of scripts, run:', '  npm run']);
  }
  ctx.out(`\n> ${pkg.name}@${pkg.version} ${name}\n> ${cmd}\n\n`);
  const tool = cmd.trim().split(/\s+/)[0];
  if (/^(jest|vitest|mocha)$/.test(tool)) return runJest(ctx, pkg);
  if (/^(eslint|next)$/.test(tool) && name.includes('lint')) return runLint(ctx, pkg);
  if (tool === 'eslint') return runLint(ctx, pkg);
  if (/^(vite|webpack|tsc|next|react-scripts)$/.test(tool)) return runBuild(ctx, pkg);
  // Plain shell scripts (echo, cp, …) run for real.
  const r = ctx.shell.spawn(ctx.state).run(cmd);
  for (const c of r.output) (c.stream === 'stderr' ? ctx.err : ctx.out)(c.text);
  return r.exitCode;
}

export const npm: CommandDef = {
  name: 'npm',
  summary: 'Node.js package manager (simulated: ci, install, test, run)',
  run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (!sub || sub === 'help' || sub === '-h') {
      ctx.out('npm <command>\n\nUsage:\n\nnpm install        install all the dependencies in your project\nnpm ci             clean install from package-lock.json\nnpm test           run this project\'s tests\nnpm run <foo>      run the script named <foo>\n\nnpm@10.8.2 /usr/local/lib/node_modules/npm\n');
      return 0;
    }
    if (sub === '-v' || sub === '--version') {
      ctx.out('10.8.2\n');
      return 0;
    }
    const pkg = readPkg(ctx);
    if ('error' in pkg) return pkg.error;
    switch (sub) {
      case 'ci':
      case 'clean-install':
        return install(ctx, pkg, true);
      case 'install':
      case 'i':
      case 'add':
        if (rest.filter((a) => !a.startsWith('-')).length) {
          ctx.note('devquest: adding new packages needs the network; the project\'s dependencies are installed instead.\n');
        }
        return install(ctx, pkg, false);
      case 'test':
      case 't':
      case 'tst':
        return runScript(ctx, pkg, 'test');
      case 'run':
      case 'run-script': {
        const name = rest[0];
        if (!name) {
          const names = Object.keys(pkg.scripts);
          ctx.out(names.length ? `Lifecycle scripts included in ${pkg.name}@${pkg.version}:\n${names.map((n) => `  ${n}\n    ${pkg.scripts[n]}\n`).join('')}` : '');
          return 0;
        }
        return runScript(ctx, pkg, name);
      }
      case 'start':
        return runScript(ctx, pkg, 'start');
      default:
        if (['audit', 'outdated', 'publish', 'update', 'uninstall', 'link', 'pack', 'exec', 'init', 'fund'].includes(sub)) {
          ctx.err(`devquest: 'npm ${sub}' is real, but not simulated here\n`);
          return 1;
        }
        ctx.err(`Unknown command: "${sub}"\n\nTo see a list of supported npm commands, run:\n  npm help\n`);
        return 1;
    }
  },
};

export const node: CommandDef = {
  name: 'node',
  summary: 'Node.js (simulated: --version only)',
  run(ctx) {
    if (ctx.args[0] === '-v' || ctx.args[0] === '--version') {
      ctx.out(`${nodeVersion(ctx.env.DEVQUEST_NODE_VERSION)}\n`);
      return 0;
    }
    ctx.err("devquest: running JavaScript isn't simulated; use the project's npm scripts (npm test, npm run build)\n");
    return 1;
  },
};
