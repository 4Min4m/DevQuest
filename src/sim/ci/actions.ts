/** The GitHub Actions marketplace actions the simulator knows (others fail like an unresolvable action). */
import { sha1 as sha1Bytes, utf8 } from '../git/sha1';
import type { CiRun, ForgeRepo } from '../forge/types';
import { findBySlug, hostOf, webUrl } from '../forge';
import { joinPath } from '../vfs/path';
import { nodeVersion } from './npm';
import { collectFiles, mask, Runner, runScript, writeFiles } from './runner';

const sha1 = (s: string) => sha1Bytes(utf8(s));

export interface ActionCtx {
  runner: Runner;
  inputs: Record<string, string>;
  repo: ForgeRepo;
  url: string;
  run: CiRun;
  sha: string;
  ref: string;
  secrets: string[];
  /** The job's status so far (post steps run differently on failure). */
  jobOk: () => boolean;
}

export interface ActionResult {
  code: number;
  log: string[];
  outputs?: Record<string, string>;
  /** Variables for the rest of the job (like $GITHUB_ENV). */
  env?: Record<string, string>;
  post?: () => string[];
  /** Simulated duration in seconds. */
  secs?: number;
}

type Impl = (a: ActionCtx) => ActionResult;

const shell = (a: ActionCtx, line: string, cwd?: string, stdin?: string) => {
  const s = a.runner.state;
  const saved = s.cwd;
  if (cwd) s.cwd = cwd;
  const r = (a.runner.shell as { run(l: string, i?: string): { output: { text: string }[]; exitCode: number } }).run(line, stdin);
  s.cwd = saved;
  return { code: r.exitCode, text: mask(r.output.map((o) => o.text).join(''), a.secrets) };
};

const lines = (t: string) => t.replace(/\n$/, '').split('\n').filter((l, i, arr) => l !== '' || i < arr.length - 1);

/** "a\nb", "a,b" → [a, b] */
function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const home = (a: ActionCtx) => a.runner.state.vars.HOME ?? '/home/runner';

function expandPath(a: ActionCtx, p: string): string {
  if (p.startsWith('~')) return joinPath(home(a), p.slice(1).replace(/^\//, ''));
  return p.startsWith('/') ? p : joinPath(a.runner.workspace, p);
}

/** hashFiles()-style digest of files matching glob patterns under the workspace. */
export function hashFiles(r: Runner, patterns: string[]): string {
  const files = collectFiles(r.vfs, r.workspace) ?? {};
  const re = (g: string) => {
    let out = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*' && g[i + 1] === '*') {
        out += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += g[i + 2] === '/' ? 2 : 1;
      } else if (c === '*') out += '[^/]*';
      else if (c === '?') out += '[^/]';
      else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
  };
  const hits = Object.keys(files)
    .filter((f) => !f.startsWith('node_modules/') && patterns.some((p) => re(p.replace(/^\.\//, '')).test(f)))
    .sort();
  if (!hits.length) return '';
  const h = sha1(hits.map((f) => `${f}\0${files[f]}`).join('\n'));
  return (h + sha1(h)).slice(0, 64);
}

// ------------------------------------------------------------------ actions/checkout

const checkout: Impl = (a) => {
  const target = a.inputs.repository ? findBySlug(a.runner.state.runner!.host, a.inputs.repository) : { url: a.url, remote: null };
  const slug = a.inputs.repository ?? a.repo.slug;
  const log = [`Syncing repository: ${slug}`, 'Getting Git version info', `  Working directory is '${a.runner.workspace}'`, '  /usr/bin/git version', '  git version 2.47.1'];
  if (!target) {
    log.push('Error: fatal: could not read Username for \'https://github.com\': terminal prompts disabled', `Error: The process '/usr/bin/git' failed with exit code 128`);
    return { code: 1, log };
  }
  const dest = a.inputs.path ? joinPath(a.runner.workspace, a.inputs.path) : a.runner.workspace;
  if (a.runner.vfs.exists(dest)) a.runner.vfs.remove(dest, { recursive: true });
  const parent = dest.replace(/\/[^/]+$/, '') || '/';
  if (!a.runner.vfs.exists(parent)) a.runner.vfs.mkdir(parent, { parents: true });
  const clone = shell(a, `git clone -q ${target.url} ${dest}`, parent);
  if (clone.code !== 0) return { code: 1, log: [...log, ...lines(clone.text), `Error: The process '/usr/bin/git' failed with exit code ${clone.code}`] };
  const ref = a.inputs.ref || (a.inputs.repository ? '' : a.sha);
  if (ref) {
    const co = shell(a, `git checkout -q ${ref}`, dest);
    if (co.code !== 0) return { code: 1, log: [...log, ...lines(co.text), `Error: A branch or tag with the name '${ref}' could not be found`] };
  }
  const head = shell(a, 'git rev-parse HEAD', dest).text.trim();
  shell(a, 'git config user.name github-actions[bot]', dest);
  shell(a, 'git config user.email 41898282+github-actions[bot]@users.noreply.github.com', dest);
  log.push(`Temporarily overriding HOME='${home(a)}' before making global git config changes`, `Deleting the contents of '${dest}'`, 'Initializing the repository', 'Fetching the repository', 'Determining the checkout info', 'Checking out the ref', '/usr/bin/git log -1 --format=%H', head);
  return { code: 0, log, secs: 1, post: () => ['Post job cleanup.', '/usr/bin/git version', 'git version 2.47.1', `Temporarily overriding HOME='${home(a)}' before making global git config changes`, "/usr/bin/git config --local --name-only --get-regexp core\\.sshCommand", "/usr/bin/git config --local --name-only --get-regexp http\\.https\\:\\/\\/github\\.com\\/\\.extraheader"] };
};

// ------------------------------------------------------------------ caches

function restoreCache(a: ActionCtx, key: string, restoreKeys: string[], paths: string[]): { hit: 'exact' | 'partial' | 'miss'; log: string[] } {
  const caches = a.repo.caches;
  let found = caches[key] ? key : undefined;
  let hit: 'exact' | 'partial' | 'miss' = found ? 'exact' : 'miss';
  if (!found) {
    for (const rk of restoreKeys) {
      const k = Object.keys(caches).reverse().find((x) => x.startsWith(rk));
      if (k) {
        found = k;
        hit = 'partial';
        break;
      }
    }
  }
  if (!found) return { hit, log: [`Cache not found for input keys: ${[key, ...restoreKeys].join(', ')}`] };
  const files = caches[found];
  for (const p of paths) {
    const prefix = `${p}/`;
    const mine = Object.fromEntries(Object.entries(files).filter(([f]) => f.startsWith(prefix)).map(([f, c]) => [f.slice(prefix.length), c]));
    writeFiles(a.runner.vfs, expandPath(a, p), mine);
  }
  const size = Object.values(files).reduce((n, c) => n + c.length, 0) + 48_000_000;
  return {
    hit,
    log: [`Cache Size: ~${Math.round(size / 1024 / 1024)} MB (${size} B)`, `/usr/bin/tar -xf /home/runner/work/_temp/cache.tzst -P -C ${a.runner.workspace} --use-compress-program unzstd`, `Cache restored successfully`, `Cache restored from key: ${found}`],
  };
}

function saveCache(a: ActionCtx, key: string, paths: string[]): string[] {
  if (a.repo.caches[key]) return [`Cache hit occurred on the primary key ${key}, not saving cache.`];
  const files: Record<string, string> = {};
  for (const p of paths) {
    const got = collectFiles(a.runner.vfs, expandPath(a, p));
    if (got) for (const [f, c] of Object.entries(got)) files[`${p}/${f}`] = c;
  }
  if (!Object.keys(files).length) return [`Warning: Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`];
  a.repo.caches[key] = files;
  return [`/usr/bin/tar --posix -cf cache.tzst --exclude cache.tzst -P -C ${a.runner.workspace} --files-from manifest.txt --use-compress-program zstdmt`, `Cache Size: ~47 MB (49283072 B)`, `Cache saved successfully`, `Cache saved with key: ${key}`];
}

const cache: Impl = (a) => {
  const key = a.inputs.key;
  const paths = list(a.inputs.path);
  if (!key || !paths.length) return { code: 1, log: [`Error: Input required and not supplied: ${!paths.length ? 'path' : 'key'}`] };
  const r = restoreCache(a, key, list(a.inputs['restore-keys']), paths);
  return { code: 0, log: r.log, outputs: { 'cache-hit': String(r.hit === 'exact') }, secs: r.hit === 'miss' ? 1 : 2, post: () => (a.jobOk() ? saveCache(a, key, paths) : ['Not saving cache as the job did not succeed.']) };
};

// ------------------------------------------------------------------ setup-*

const setupNode: Impl = (a) => {
  const spec = a.inputs['node-version'];
  const v = nodeVersion(spec);
  const log = spec
    ? [`Attempting to download ${spec}...`, `Acquiring ${v.slice(1)} - x64 from https://github.com/actions/node-versions/releases/download/${v.slice(1)}-11593495226/node-${v.slice(1)}-linux-x64.tar.gz`, 'Extracting ...', 'Adding to the cache ...', 'Environment details', `  node: ${v}`, '  npm: 10.8.2', '  yarn: 1.22.22']
    : ['Environment details', `  node: ${v}`, '  npm: 10.8.2', '  yarn: 1.22.22'];
  let post: (() => string[]) | undefined;
  if (a.inputs.cache === 'npm') {
    const hash = hashFiles(a.runner, ['**/package-lock.json']);
    if (!hash) return { code: 1, log: [...log, 'Error: Dependencies lock file is not found in /home/runner/work. Supported file patterns: package-lock.json,npm-shrinkwrap.json,yarn.lock'] };
    const key = `node-cache-Linux-x64-npm-${hash}`;
    const r = restoreCache(a, key, [], ['~/.npm']);
    log.push(...(r.hit === 'miss' ? ['npm cache is not found'] : r.log));
    post = () => (a.jobOk() ? saveCache(a, key, ['~/.npm']) : []);
  }
  return { code: 0, log, env: { DEVQUEST_NODE_VERSION: v }, secs: 2, post };
};

const setupPython: Impl = (a) => {
  const v = a.inputs['python-version'] || '3.12';
  return { code: 0, log: [`Installed versions`, `  Successfully set up CPython (${v}.7)`], secs: 1 };
};

// ------------------------------------------------------------------ artifacts

const upload: Impl = (a) => {
  const name = a.inputs.name || 'artifact';
  const paths = list(a.inputs.path);
  const files: Record<string, string> = {};
  for (const p of paths) {
    const got = collectFiles(a.runner.vfs, expandPath(a, p));
    if (got) Object.assign(files, got);
  }
  const n = Object.keys(files).length;
  if (!n) {
    const mode = a.inputs['if-no-files-found'] || 'warn';
    const msg = `No files were found with the provided path: ${paths.join('\n')}. No artifacts will be uploaded.`;
    if (mode === 'error') return { code: 1, log: [`Error: ${msg}`] };
    return { code: 0, log: mode === 'ignore' ? [msg] : [`Warning: ${msg}`] };
  }
  if (a.run.artifacts[name]) return { code: 1, log: [`With the provided path, there will be ${n} file${n > 1 ? 's' : ''} uploaded`, 'Artifact name is valid!', 'Root directory input is valid!', `Error: Failed to CreateArtifact: Received non-retryable error: Failed request: (409) Conflict: an artifact with this name already exists on the workflow run`] };
  a.run.artifacts[name] = files;
  const bytes = Object.values(files).reduce((s, c) => s + c.length, 0);
  const id = 2_000_000_000 + (a.run.id % 100000) * 10 + Object.keys(a.run.artifacts).length;
  return {
    code: 0,
    secs: 1,
    log: [
      `With the provided path, there will be ${n} file${n > 1 ? 's' : ''} uploaded`,
      'Artifact name is valid!',
      'Root directory input is valid!',
      'Beginning upload of artifact content to blob storage',
      `Uploaded bytes ${bytes}`,
      'Finished uploading artifact content to blob storage!',
      `SHA256 hash of uploaded artifact zip is ${(sha1(JSON.stringify(files)) + sha1(name)).slice(0, 64)}`,
      'Finalizing artifact upload',
      `Artifact ${name}.zip successfully finalized. Artifact ID ${id}`,
      `Artifact ${name} has been successfully uploaded! Final size is ${bytes} bytes. Artifact ID is ${id}`,
      `Artifact download URL: ${webUrl(a.repo)}/actions/runs/${a.run.id}/artifacts/${id}`,
    ],
  };
};

const download: Impl = (a) => {
  const names = a.inputs.name ? [a.inputs.name] : Object.keys(a.run.artifacts);
  const dest = a.inputs.path ? expandPath(a, a.inputs.path) : a.runner.workspace;
  const log: string[] = [`Downloading single artifact`];
  for (const name of names) {
    const files = a.run.artifacts[name];
    if (!files) {
      return {
        code: 1,
        log: [
          `Error: Unable to download artifact(s): Artifact not found for name: ${name}`,
          '        Please ensure that your artifact is not expired and the artifact was uploaded using a compatible version of toolkit/upload-artifact.',
          '        For more information, visit the GitHub Artifacts FAQ: https://github.com/actions/toolkit/blob/main/packages/artifact/docs/faq.md',
        ],
      };
    }
    writeFiles(a.runner.vfs, a.inputs.name ? dest : joinPath(dest, name), files);
    log.push(`Preparing to download the following artifacts:`, `- ${name}`, `Redirecting to blob download url`, `Starting download of artifact to: ${dest}`, `Artifact download completed successfully.`);
  }
  log.push(`Total of ${names.length} artifact(s) downloaded`, 'Download artifact has finished successfully');
  return { code: 0, log, secs: 1 };
};

// ------------------------------------------------------------------ docker/*

const dockerLogin: Impl = (a) => {
  const reg = a.inputs.registry || 'docker.io';
  const user = a.inputs.username;
  const pass = a.inputs.password;
  if (!user || !pass) return { code: 1, log: ['Error: Username and password required'] };
  const r = shell(a, `docker login ${reg} -u ${user} --password-stdin`, undefined, pass + '\n');
  if (r.code !== 0) return { code: 1, log: [`Logging into ${reg}...`, ...lines(r.text).map((l) => `Error: ${l}`)] };
  return { code: 0, log: [`Logging into ${reg}...`, 'Login Succeeded!'], post: () => [`Logging out of ${reg}...`, `Removing login credentials for ${reg}`] };
};

const buildx: Impl = () => ({ code: 0, secs: 3, log: ['Docker info', '  Server Version: 27.3.1', 'Inspecting default docker context', 'Creating a new builder instance', '/usr/bin/docker buildx create --name builder-6f4c --driver docker-container --use', 'Booting builder', 'Inspect builder', '  Name:          builder-6f4c', '  Driver:        docker-container', 'BuildKit version', '  v0.17.2'] });

const buildPush: Impl = (a) => {
  const tags = list(a.inputs.tags);
  const ctxDir = a.inputs.context && a.inputs.context !== '.' ? a.inputs.context : '.';
  const file = a.inputs.file ? ` -f ${a.inputs.file}` : '';
  const log: string[] = [];
  const b = shell(a, `docker build${tags.map((t) => ` -t ${t}`).join('')}${file} ${ctxDir}`, a.runner.workspace);
  log.push(...lines(b.text));
  if (b.code !== 0) return { code: 1, log: [...log, `Error: buildx failed with: ERROR: failed to solve: process did not complete successfully: exit code: ${b.code}`] };
  if (a.inputs.push === 'true') {
    if (!tags.length) return { code: 1, log: [...log, 'ERROR: tag is needed when pushing to registry'] };
    for (const t of tags) {
      const p = shell(a, `docker push ${t}`);
      log.push(...lines(p.text));
      if (p.code !== 0) return { code: 1, log: [...log, `Error: buildx failed with: ERROR: failed to push ${t}: ${lines(p.text).pop() ?? ''}`] };
    }
  }
  return { code: 0, log, secs: 15 };
};

// ------------------------------------------------------------------ kubernetes

const setupKubectl: Impl = (a) => ({ code: 0, secs: 1, log: [`Downloading kubectl ${a.inputs.version && a.inputs.version !== 'latest' ? a.inputs.version : 'v1.31.2'}`, 'kubectl installed to /opt/hostedtoolcache/kube/1.31.2/x64/kubectl'] });

const setContext: Impl = (a) => {
  const cfg = a.inputs.kubeconfig;
  if (!cfg) return { code: 1, log: ['Error: Kubeconfig not provided'] };
  const path = '/home/runner/work/_temp/kubeconfig_1730883600000';
  writeFiles(a.runner.vfs, '/home/runner/work/_temp', { 'kubeconfig_1730883600000': cfg });
  return { code: 0, log: [`Setting context using kubeconfig`], env: { KUBECONFIG: path } };
};

const ACTIONS: Record<string, { versions: string[]; impl: Impl }> = {
  'actions/checkout': { versions: ['v2', 'v3', 'v4'], impl: checkout },
  'actions/setup-node': { versions: ['v3', 'v4'], impl: setupNode },
  'actions/setup-python': { versions: ['v4', 'v5'], impl: setupPython },
  'actions/cache': { versions: ['v3', 'v4'], impl: cache },
  'actions/upload-artifact': { versions: ['v3', 'v4'], impl: upload },
  'actions/download-artifact': { versions: ['v3', 'v4'], impl: download },
  'docker/login-action': { versions: ['v2', 'v3'], impl: dockerLogin },
  'docker/setup-buildx-action': { versions: ['v2', 'v3'], impl: buildx },
  'docker/build-push-action': { versions: ['v4', 'v5', 'v6'], impl: buildPush },
  'azure/setup-kubectl': { versions: ['v3', 'v4'], impl: setupKubectl },
  'azure/k8s-set-context': { versions: ['v3', 'v4'], impl: setContext },
};

export const KNOWN_ACTIONS = Object.keys(ACTIONS);

/** Resolve `owner/repo@ref`; returns an implementation or the error the runner prints. */
export function resolveAction(uses: string): { impl: Impl } | { error: string } {
  const [name, ref] = uses.split('@');
  const a = ACTIONS[name.toLowerCase()];
  if (!a) {
    return {
      error: `Unable to resolve action \`${uses}\`, repository not found\n(devquest simulates these actions: ${KNOWN_ACTIONS.join(', ')})`,
    };
  }
  const major = /^v\d+/.exec(ref ?? '')?.[0];
  if (!major || !a.versions.includes(major)) return { error: `Unable to resolve action \`${uses}\`, unable to find version \`${ref}\`` };
  return { impl: a.impl };
}

export { hostOf, runScript };
