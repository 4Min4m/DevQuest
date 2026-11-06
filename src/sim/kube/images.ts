/** Images the cluster can pull: the offline Docker catalog, system images, and mission-defined apps. */
import { buildTree } from '../state';
import { catalogFs, CATALOG, findCatalog, parseRef } from '../docker/catalog';
import { HELLO } from '../docker/programs';
import type { DirNode } from '../vfs/types';
import { SYSTEM_IMAGES } from './cluster';
import type { AppSpec, KubeState } from './types';

/** "nginx" → "docker.io/library/nginx:latest"; registries other than Docker Hub are kept. */
export function fullRef(ref: string): string {
  let r = ref;
  const lastSlash = r.lastIndexOf('/');
  if (!r.slice(lastSlash + 1).includes(':') && !r.includes('@')) r += ':latest';
  const first = r.split('/')[0];
  if (!r.includes('/')) return `docker.io/library/${r}`;
  if (!first.includes('.') && !first.includes(':') && first !== 'localhost') return `docker.io/${r}`;
  return r;
}

export interface ResolvedImage {
  spec: AppSpec;
  /** Size in bytes (for pull events). */
  size: number;
  catalog?: { repository: string; tag: string };
}

const NGINX_LOGS = [
  '/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration',
  '/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/',
  '/docker-entrypoint.sh: Configuration complete; ready for start up',
  '{time} [notice] 1#1: using the "epoll" event method',
  '{time} [notice] 1#1: nginx/1.27.2',
  '{time} [notice] 1#1: start worker processes',
];

function catalogSpec(repository: string): AppSpec {
  switch (repository) {
    case 'nginx':
      return { listen: [80], staticRoot: '/usr/share/nginx/html', accessLog: true, logs: NGINX_LOGS, memMi: 9, cpuM: 1 };
    case 'httpd':
      return {
        listen: [80],
        staticRoot: '/usr/local/apache2/htdocs',
        logs: ["AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using {ip}. Set the 'ServerName' directive globally to suppress this message", '[mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.62 (Unix) configured -- resuming normal operations'],
        memMi: 12,
        cpuM: 1,
      };
    case 'redis':
      return { listen: [6379], logs: ['1:C 03 Nov 2026 09:00:00.000 * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo', '1:M 03 Nov 2026 09:00:00.000 * Server initialized', '1:M 03 Nov 2026 09:00:00.000 * Ready to accept connections tcp'], memMi: 4, cpuM: 2 };
    case 'postgres':
      return {
        listen: [5432],
        requireEnv: ['POSTGRES_PASSWORD'],
        requireEnvMessage:
          'Error: Database is uninitialized and superuser password is not specified.\n       You must specify POSTGRES_PASSWORD to a non-empty value for the\n       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".\n\n       You may also use "POSTGRES_HOST_AUTH_METHOD=trust" to allow all\n       connections without a password. This is *not* recommended.',
        logs: ['PostgreSQL init process complete; ready for start up.', '{time} UTC [1] LOG:  listening on IPv4 address "0.0.0.0", port 5432', '{time} UTC [1] LOG:  database system is ready to accept connections'],
        memMi: 45,
        cpuM: 5,
      };
    case 'mysql':
      return {
        listen: [3306],
        requireEnv: ['MYSQL_ROOT_PASSWORD'],
        requireEnvMessage:
          '{time}+00:00 [ERROR] [Entrypoint]: Database is uninitialized and password option is not specified\n    You need to specify one of the following as an environment variable:\n    - MYSQL_ROOT_PASSWORD\n    - MYSQL_ALLOW_EMPTY_PASSWORD\n    - MYSQL_RANDOM_ROOT_PASSWORD',
        logs: ['{time}+00:00 [Note] [Entrypoint]: Entrypoint script for MySQL Server 8.4.3-1.el9 started.', '{time} 0 [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. Version: \'8.4.3\'  socket: \'/var/run/mysqld/mysqld.sock\'  port: 3306  MySQL Community Server - GPL.'],
        memMi: 380,
        cpuM: 8,
      };
    case 'hello-world':
      return { logs: HELLO.split('\n').slice(1, -1), exitCode: 0 };
    default: {
      const cat = findCatalog(repository)!;
      return { shellImage: true, entrypoint: [...cat.config.entrypoint], cmd: [...cat.config.cmd], memMi: 2, cpuM: 0 };
    }
  }
}

export type PullResult = { ok: true; image: ResolvedImage } | { ok: false; message: string };

/** Look an image up the way containerd would, with containerd's error text on failure. */
export function resolveImage(ks: KubeState, ref: string): PullResult {
  const full = fullRef(ref);
  const custom = ks.images[ref] ?? Object.entries(ks.images).find(([k]) => fullRef(k) === full)?.[1] ?? SYSTEM_IMAGES[ref];
  if (custom) return { ok: true, image: { spec: custom, size: 48_211_334 } };
  const base = `failed to pull and unpack image "${full}": failed to resolve reference "${full}"`;
  // `repo:*` images exist for every tag pushed to the registry (e.g. by a CI pipeline).
  const repoOf = (r: string) => fullRef(r.replace(/:\*$/, ':x')).replace(/:[^:/]+$/, '');
  const wildcard = Object.entries(ks.images).find(([k]) => k.endsWith(':*') && repoOf(k) === full.replace(/:[^:/]+$/, ''));
  if (wildcard) {
    if ((ks.pushed ?? []).includes(full)) return { ok: true, image: { spec: wildcard[1], size: 52_418_903 } };
    return { ok: false, message: `${base}: ${full}: not found` };
  }
  if (full.startsWith('docker.io/')) {
    const { repository, tag } = parseRef(full);
    const cat = findCatalog(repository);
    if (cat) {
      const t = cat.tags.find((x) => x.name === tag);
      if (t) return { ok: true, image: { spec: catalogSpec(repository), size: t.size, catalog: { repository, tag } } };
      return { ok: false, message: `${base}: ${full}: not found` };
    }
    return { ok: false, message: `${base}: pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed` };
  }
  // Another registry that knows the repository but not this tag?
  const repo = full.replace(/:[^:/]+$/, '');
  if (Object.keys(ks.images).some((k) => fullRef(k).replace(/:[^:/]+$/, '') === repo)) return { ok: false, message: `${base}: ${full}: not found` };
  const host = full.split('/')[0];
  return { ok: false, message: `${base}: failed to do request: Head "https://${host}/v2/${full.slice(host.length + 1).replace(/:([^:]+)$/, '/manifests/$1')}": dial tcp: lookup ${host}: no such host` };
}

/** A root filesystem for a container running this image (for exec and static servers). */
export function imageFs(image: ResolvedImage, now: number): DirNode {
  if (image.catalog) {
    const cat = findCatalog(image.catalog.repository)!;
    const tag = cat.tags.find((t) => t.name === image.catalog!.tag)!;
    return catalogFs(cat, tag);
  }
  const alpine = CATALOG.find((c) => c.repository === 'alpine')!;
  const fs = catalogFs(alpine, alpine.tags[0]);
  fs.children.app = buildTree({}, 'root', 'root', now);
  return fs;
}

/** Shell and missing tools inside the image (for kubectl exec). */
export function imageShell(image: ResolvedImage): { shells: string[]; lacks: string[] } {
  if (image.catalog) {
    const cat = findCatalog(image.catalog.repository)!;
    const tag = cat.tags.find((t) => t.name === image.catalog!.tag)!;
    if (cat.hasShell === false) return { shells: [], lacks: cat.lacks };
    return { shells: tag.alpine ? ['sh', 'ash'] : ['sh', 'bash', 'dash'], lacks: cat.lacks };
  }
  return { shells: ['sh', 'ash'], lacks: ['nano', 'vim'] };
}
