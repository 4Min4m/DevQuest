/**
 * The offline "Docker Hub": images that `docker pull` / `docker run` can fetch.
 * Each entry describes the image config and the files that matter for lessons.
 */
import { buildTree, DEFAULT_CLOCK } from '../state';
import type { DirNode } from '../vfs/types';
import type { ImageConfig } from './types';

const DAY = 86_400_000;

export interface CatalogTag {
  name: string;
  size: number;
  /** Alpine-based variant: busybox `sh` only, no bash. */
  alpine?: boolean;
  /** Days before the simulation clock that the image was built. */
  ageDays: number;
}

export interface CatalogImage {
  repository: string;
  tags: CatalogTag[];
  config: ImageConfig;
  /** Pretty OS name for /etc/os-release. */
  os: string;
  /** Extra files, path → content. */
  files: Record<string, string>;
  /** False for scratch images like hello-world (no shell at all). */
  hasShell?: boolean;
  /** Common tools this image does NOT ship (e.g. alpine has no curl, nginx has no ps). */
  lacks: string[];
  /** Registry namespace; official images live under "library". */
  namespace?: string;
}

const PATH = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export const NGINX_INDEX = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>
`;

export const NGINX_DEFAULT_CONF = `server {
    listen       80;
    listen  [::]:80;
    server_name  localhost;

    location / {
        root   /usr/share/nginx/html;
        index  index.html index.htm;
    }

    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   /usr/share/nginx/html;
    }
}
`;

export const CATALOG: CatalogImage[] = [
  {
    repository: 'nginx',
    lacks: ['ps'],
    tags: [
      { name: 'latest', size: 192_004_242, ageDays: 20 },
      { name: '1.27', size: 192_004_242, ageDays: 20 },
      { name: 'alpine', size: 47_983_515, ageDays: 20, alpine: true },
      { name: '1.27-alpine', size: 47_983_515, ageDays: 20, alpine: true },
    ],
    config: {
      entrypoint: ['/docker-entrypoint.sh'],
      cmd: ['nginx', '-g', 'daemon off;'],
      env: [PATH, 'NGINX_VERSION=1.27.2'],
      workdir: '/',
      exposedPorts: ['80/tcp'],
    },
    os: 'Debian GNU/Linux 12 (bookworm)',
    files: {
      '/usr/share/nginx/html/index.html': NGINX_INDEX,
      '/usr/share/nginx/html/50x.html': '<!DOCTYPE html>\n<html><body><h1>An error occurred.</h1></body></html>\n',
      '/etc/nginx/nginx.conf':
        'user  nginx;\nworker_processes  auto;\n\nevents {\n    worker_connections  1024;\n}\n\nhttp {\n    include       /etc/nginx/mime.types;\n    include /etc/nginx/conf.d/*.conf;\n}\n',
      '/etc/nginx/conf.d/default.conf': NGINX_DEFAULT_CONF,
      '/docker-entrypoint.sh': '#!/bin/sh\n# vendor entrypoint\nexec "$@"\n',
    },
  },
  {
    repository: 'httpd',
    lacks: ['ps', 'curl'],
    tags: [
      { name: 'latest', size: 148_022_416, ageDays: 30 },
      { name: '2.4', size: 148_022_416, ageDays: 30 },
      { name: 'alpine', size: 62_300_120, ageDays: 30, alpine: true },
    ],
    config: { entrypoint: [], cmd: ['httpd-foreground'], env: [PATH, 'HTTPD_VERSION=2.4.62'], workdir: '/usr/local/apache2', exposedPorts: ['80/tcp'] },
    os: 'Debian GNU/Linux 12 (bookworm)',
    files: {
      '/usr/local/apache2/htdocs/index.html': '<html><body><h1>It works!</h1></body></html>\n',
      '/usr/local/apache2/conf/httpd.conf': 'Listen 80\nDocumentRoot "/usr/local/apache2/htdocs"\n',
    },
  },
  {
    repository: 'redis',
    lacks: ['ps', 'curl'],
    tags: [
      { name: 'latest', size: 117_204_891, ageDays: 15 },
      { name: '7', size: 117_204_891, ageDays: 15 },
      { name: 'alpine', size: 41_208_220, ageDays: 15, alpine: true },
    ],
    config: { entrypoint: ['docker-entrypoint.sh'], cmd: ['redis-server'], env: [PATH, 'REDIS_VERSION=7.4.1'], workdir: '/data', exposedPorts: ['6379/tcp'] },
    os: 'Debian GNU/Linux 12 (bookworm)',
    files: { '/data/.keep': '' },
  },
  {
    repository: 'postgres',
    lacks: ['ps', 'curl'],
    tags: [
      { name: 'latest', size: 435_133_008, ageDays: 12 },
      { name: '17', size: 435_133_008, ageDays: 12 },
      { name: '16', size: 431_928_402, ageDays: 12 },
      { name: '17-alpine', size: 275_016_311, ageDays: 12, alpine: true },
    ],
    config: {
      entrypoint: ['docker-entrypoint.sh'],
      cmd: ['postgres'],
      env: [PATH, 'PG_MAJOR=17', 'PGDATA=/var/lib/postgresql/data'],
      workdir: '/',
      exposedPorts: ['5432/tcp'],
    },
    os: 'Debian GNU/Linux 12 (bookworm)',
    files: { '/var/lib/postgresql/data/.keep': '' },
  },
  {
    repository: 'mysql',
    lacks: ['curl'],
    tags: [
      { name: 'latest', size: 586_042_115, ageDays: 25 },
      { name: '8.4', size: 586_042_115, ageDays: 25 },
      { name: '8.0', size: 573_918_022, ageDays: 25 },
    ],
    config: { entrypoint: ['docker-entrypoint.sh'], cmd: ['mysqld'], env: [PATH, 'MYSQL_MAJOR=8.4'], workdir: '/', exposedPorts: ['3306/tcp', '33060/tcp'] },
    os: 'Oracle Linux Server 9.4',
    files: { '/var/lib/mysql/.keep': '' },
  },
  {
    repository: 'alpine',
    lacks: ['curl'],
    tags: [
      { name: 'latest', size: 7_799_999, ageDays: 40, alpine: true },
      { name: '3.20', size: 7_799_999, ageDays: 40, alpine: true },
      { name: '3.19', size: 7_380_412, ageDays: 90, alpine: true },
    ],
    config: { entrypoint: [], cmd: ['/bin/sh'], env: [PATH], workdir: '/', exposedPorts: [] },
    os: 'Alpine Linux v3.20',
    files: {},
  },
  {
    repository: 'busybox',
    lacks: ['curl'],
    tags: [{ name: 'latest', size: 4_269_183, ageDays: 60, alpine: true }],
    config: { entrypoint: [], cmd: ['sh'], env: [PATH], workdir: '/', exposedPorts: [] },
    os: 'BusyBox',
    files: {},
  },
  {
    repository: 'ubuntu',
    lacks: ['ps', 'curl'],
    tags: [
      { name: 'latest', size: 78_118_041, ageDays: 35 },
      { name: '24.04', size: 78_118_041, ageDays: 35 },
      { name: '22.04', size: 77_863_022, ageDays: 35 },
    ],
    config: { entrypoint: [], cmd: ['/bin/bash'], env: [PATH], workdir: '/', exposedPorts: [] },
    os: 'Ubuntu 24.04.1 LTS',
    files: {},
  },
  {
    repository: 'node',
    lacks: [],
    tags: [
      { name: 'latest', size: 1_120_442_316, ageDays: 10 },
      { name: '22', size: 1_120_442_316, ageDays: 10 },
      { name: '20', size: 1_096_315_002, ageDays: 10 },
      { name: '22-alpine', size: 155_301_870, ageDays: 10, alpine: true },
    ],
    config: { entrypoint: ['docker-entrypoint.sh'], cmd: ['node'], env: [PATH, 'NODE_VERSION=22.11.0'], workdir: '/', exposedPorts: [] },
    os: 'Debian GNU/Linux 12 (bookworm)',
    files: {},
  },
  {
    repository: 'python',
    lacks: [],
    tags: [
      { name: 'latest', size: 1_018_773_021, ageDays: 18 },
      { name: '3.12', size: 1_018_773_021, ageDays: 18 },
      { name: '3.12-slim', size: 130_281_533, ageDays: 18 },
      { name: '3.12-alpine', size: 57_316_221, ageDays: 18, alpine: true },
    ],
    config: { entrypoint: [], cmd: ['python3'], env: [PATH, 'PYTHON_VERSION=3.12.7'], workdir: '/', exposedPorts: [] },
    os: 'Debian GNU/Linux 12 (bookworm)',
    files: {},
  },
  {
    repository: 'hello-world',
    lacks: [],
    tags: [{ name: 'latest', size: 13_256, ageDays: 540 }],
    config: { entrypoint: [], cmd: ['/hello'], env: [PATH], workdir: '/', exposedPorts: [] },
    os: '',
    files: { '/hello': '\u007fELF' },
    hasShell: false,
  },
  {
    repository: 'curlimages/curl',
    namespace: 'curlimages',
    tags: [
      { name: 'latest', size: 23_318_092, ageDays: 14, alpine: true },
      { name: '8.11.0', size: 23_318_092, ageDays: 14, alpine: true },
    ],
    config: { entrypoint: ['curl'], cmd: ['--help'], env: [PATH], workdir: '/', exposedPorts: [] },
    os: 'Alpine Linux v3.20',
    files: {},
    lacks: [],
  },
];

/** Split "repo:tag" (accepting docker.io/library/ prefixes). */
export function parseRef(ref: string): { repository: string; tag: string } {
  let r = ref.replace(/^docker\.io\//, '').replace(/^library\//, '');
  let tag = 'latest';
  const colon = r.lastIndexOf(':');
  if (colon > 0 && !r.slice(colon).includes('/')) {
    tag = r.slice(colon + 1);
    r = r.slice(0, colon);
  }
  return { repository: r, tag };
}

export function findCatalog(repository: string): CatalogImage | undefined {
  return CATALOG.find((c) => c.repository === repository);
}

export function catalogCreated(tag: CatalogTag): number {
  return DEFAULT_CLOCK - tag.ageDays * DAY;
}

/** Build a fresh root filesystem for a container from a catalog image. */
export function catalogFs(image: CatalogImage, tag: CatalogTag): DirNode {
  const clock = catalogCreated(tag);
  const fs = buildTree(
    {
      bin: {},
      etc: {
        hostname: 'localhost\n',
        hosts: '127.0.0.1\tlocalhost\n',
        passwd: 'root:x:0:0:root:/root:/bin/sh\n',
        group: 'root:x:0:\n',
        ...(image.os ? { 'os-release': `PRETTY_NAME="${image.os}"\n` } : {}),
      },
      home: {},
      root: {},
      tmp: {},
      usr: { bin: {}, local: { bin: {} }, share: {} },
      var: { log: {} },
    },
    'root',
    'root',
    clock,
  );
  if (image.hasShell === false) {
    // scratch-based image: just the binary
    for (const k of Object.keys(fs.children)) delete fs.children[k];
  }
  for (const [path, content] of Object.entries(image.files)) {
    const parts = path.split('/').filter(Boolean);
    let dir = fs;
    for (const seg of parts.slice(0, -1)) {
      let next = dir.children[seg];
      if (!next || next.type !== 'dir') {
        next = buildTree({}, 'root', 'root', clock);
        dir.children[seg] = next;
      }
      dir = next;
    }
    const name = parts[parts.length - 1];
    if (name === '.keep') continue;
    dir.children[name] = { type: 'file', content, mode: path.endsWith('.sh') || name === 'hello' ? 0o755 : 0o644, owner: 'root', group: 'root', mtime: clock };
  }
  return fs;
}

/** Shells available inside an image. */
export function shellsOf(image: CatalogImage | undefined, tag: CatalogTag | undefined): string[] {
  if (image?.hasShell === false) return [];
  if (tag?.alpine) return ['sh', 'ash'];
  return ['sh', 'bash', 'dash'];
}
