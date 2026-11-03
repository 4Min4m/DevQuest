/**
 * What runs inside a container. Each image's main process maps to a "program"
 * with start/stop behaviour, log output and (optionally) an HTTP handler.
 */
import type { HttpResult } from '../net';
import type { ShellLike } from '../shell/types';
import { normalize, resolvePath } from '../vfs/path';
import type { FsNode } from '../vfs/types';
import { Vfs } from '../vfs/vfs';
import type { Container } from './types';

export interface ProgramContext {
  container: Container;
  now: number;
  env: Record<string, string>;
  log(stream: 'stdout' | 'stderr', text: string): void;
  /** A shell inside the container, for programs that run commands. */
  shell(): ShellLike | null;
}

export type StartResult =
  | { kind: 'running'; listen: number[] }
  | { kind: 'exited'; code: number }
  /** The executable doesn't exist: the container never starts. */
  | { kind: 'oci'; exe: string };

export interface Program {
  start(ctx: ProgramContext): StartResult;
  /** Exit code after SIGTERM (`docker stop`); null means TERM is ignored and docker kills it (137). */
  termExit: number | null;
  onStop?(ctx: ProgramContext): void;
  http?(ctx: ProgramContext, path: string, port: number): HttpResult;
}

// ------------------------------------------------------------------ helpers

const rootVfs = (c: Container) => new Vfs(c.fs, { name: 'root', groups: ['root'] });

export function readFile(c: Container, path: string): string | null {
  try {
    return rootVfs(c).readFile(normalize(path));
  } catch {
    return null;
  }
}

function lookup(c: Container, path: string): FsNode | null {
  try {
    return rootVfs(c).lookup(normalize(path));
  } catch {
    return null;
  }
}

function writeFile(c: Container, path: string, content: string): void {
  const v = rootVfs(c);
  const abs = normalize(path);
  v.mkdir(abs.replace(/\/[^/]+$/, '') || '/', { parents: true });
  v.writeFile(abs, content);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clf(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}:${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} +0000`;
}

function nginxTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function html(status: number, body: string, server: string, type = 'text/html'): HttpResult {
  return { kind: 'response', res: { status, body, headers: { Server: server, 'Content-Type': type } } };
}

/** Serve a file from a document root, the way a static web server does. */
function serveStatic(c: Container, root: string, path: string): { status: number; body: string; file: string } {
  const clean = decodeURIComponent(path.split('?')[0] || '/');
  const target = resolvePath(root, '.' + clean);
  const node = lookup(c, target);
  if (node?.type === 'dir') {
    const index = readFile(c, target + '/index.html') ?? readFile(c, target + '/index.htm');
    if (index !== null) return { status: 200, body: index, file: target + '/index.html' };
    return { status: 403, body: '', file: target };
  }
  if (node?.type === 'file') return { status: 200, body: node.content, file: target };
  return { status: 404, body: '', file: target };
}

function errorPage(status: number, title: string, server: string): string {
  return `<html>\r\n<head><title>${status} ${title}</title></head>\r\n<body>\r\n<center><h1>${status} ${title}</h1></center>\r\n<hr><center>${server}</center>\r\n</body>\r\n</html>\r\n`;
}

// ------------------------------------------------------------------ nginx

const NGINX = 'nginx/1.27.2';

/** Validate nginx config files and return the ports `listen` directives use, or an [emerg] error. */
export function nginxConfig(c: Container): { ports: number[]; root: string } | { error: string } {
  const confFiles: string[] = ['/etc/nginx/nginx.conf'];
  const confd = lookup(c, '/etc/nginx/conf.d');
  if (confd?.type === 'dir') {
    for (const name of Object.keys(confd.children).sort()) if (name.endsWith('.conf')) confFiles.push(`/etc/nginx/conf.d/${name}`);
  }
  const ports: number[] = [];
  let root = '/usr/share/nginx/html';
  for (const file of confFiles) {
    const text = readFile(c, file);
    if (text === null) continue;
    // Tokenize like nginx: statements end with ';', blocks open with '{' and close with '}'.
    let depth = 0;
    let line = 1;
    let stmt = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '#') {
        while (i < text.length && text[i] !== '\n') i++;
        line++;
        continue;
      }
      if (ch === '\n') line++;
      if (ch === ';') {
        const words = stmt.trim().split(/\s+/);
        // A missing ';' glues two directives together — nginx then sees too many arguments.
        const ARITY: Record<string, number> = { root: 2, worker_processes: 2, user: 3 };
        if (ARITY[words[0]] !== undefined && words.length > ARITY[words[0]]) {
          return { error: `[emerg] 1#1: invalid number of arguments in "${words[0]}" directive in ${file}:${line}` };
        }
        if (words[0] === 'listen') {
          const port = /(?:^|:)(\d+)$/.exec(words[1] ?? '');
          if (port && !ports.includes(Number(port[1]))) ports.push(Number(port[1]));
        }
        if (words[0] === 'root' && file.includes('conf.d') && words[1]) root = words[1];
        stmt = '';
      } else if (ch === '{') {
        stmt = '';
        depth++;
      } else if (ch === '}') {
        if (stmt.trim()) return { error: `[emerg] 1#1: unexpected "}" in ${file}:${line}` };
        depth--;
        if (depth < 0) return { error: `[emerg] 1#1: unexpected "}" in ${file}:${line}` };
      } else stmt += ch;
    }
    if (stmt.trim()) return { error: `[emerg] 1#1: unexpected end of file, expecting ";" or "}" in ${file}:${line}` };
    if (depth > 0) return { error: `[emerg] 1#1: unexpected end of file, expecting "}" in ${file}:${line}` };
  }
  return { ports: ports.length ? ports : [80], root };
}

const nginx: Program = {
  termExit: 0,
  start(ctx) {
    const now = nginxTime(ctx.now);
    ctx.log('stdout', '/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration\n');
    ctx.log('stdout', '/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/\n');
    ctx.log('stdout', '/docker-entrypoint.sh: Configuration complete; ready for start up\n');
    const conf = nginxConfig(ctx.container);
    if ('error' in conf) {
      ctx.log('stderr', `${now} ${conf.error}\n`);
      ctx.log('stderr', `nginx: ${conf.error.replace(/^\[emerg\] 1#1: /, '[emerg] ')}\n`);
      return { kind: 'exited', code: 1 };
    }
    ctx.log('stderr', `${now} [notice] 1#1: using the "epoll" event method\n`);
    ctx.log('stderr', `${now} [notice] 1#1: ${NGINX}\n`);
    ctx.log('stderr', `${now} [notice] 1#1: start worker processes\n`);
    return { kind: 'running', listen: conf.ports };
  },
  onStop(ctx) {
    ctx.log('stderr', `${nginxTime(ctx.now)} [notice] 1#1: signal 3 (SIGQUIT) received, shutting down\n`);
  },
  http(ctx, path) {
    const conf = nginxConfig(ctx.container);
    const root = 'root' in conf ? conf.root : '/usr/share/nginx/html';
    const r = serveStatic(ctx.container, root, path);
    const status = r.status;
    const body = status === 200 ? r.body : errorPage(status, status === 404 ? 'Not Found' : 'Forbidden', NGINX);
    if (status === 404) {
      ctx.log(
        'stderr',
        `${nginxTime(ctx.now)} [error] 29#29: *${ctx.container.requests + 1} open() "${r.file}" failed (2: No such file or directory), client: 172.17.0.1, server: localhost, request: "GET ${path} HTTP/1.1", host: "localhost"\n`,
      );
    }
    ctx.log('stdout', `172.17.0.1 - - [${clf(ctx.now)}] "GET ${path} HTTP/1.1" ${status} ${new TextEncoder().encode(body).length} "-" "curl/8.5.0" "-"\n`);
    return html(status, body, NGINX);
  },
};

// ------------------------------------------------------------------ httpd

const httpd: Program = {
  termExit: 0,
  start(ctx) {
    const ip = Object.values(ctx.container.networks)[0]?.ip ?? '127.0.0.1';
    ctx.log('stderr', `AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using ${ip}. Set the 'ServerName' directive globally to suppress this message\n`);
    ctx.log('stderr', `[${new Date(ctx.now).toUTCString()}] [mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.62 (Unix) configured -- resuming normal operations\n`);
    return { kind: 'running', listen: [80] };
  },
  http(ctx, path) {
    const r = serveStatic(ctx.container, '/usr/local/apache2/htdocs', path);
    const body =
      r.status === 200
        ? r.body
        : `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>${r.status} ${r.status === 404 ? 'Not Found' : 'Forbidden'}</title>\n</head><body>\n<h1>${r.status === 404 ? 'Not Found' : 'Forbidden'}</h1>\n</body></html>\n`;
    ctx.log('stdout', `172.17.0.1 - - [${clf(ctx.now)}] "GET ${path} HTTP/1.1" ${r.status} ${body.length}\n`);
    return html(r.status, body, 'Apache/2.4.62 (Unix)');
  },
};

// ------------------------------------------------------------------ databases & caches

const notHttp = (message: string, code: number): Program['http'] => () => ({ kind: 'error', code, message });

const redis: Program = {
  termExit: 0,
  start(ctx) {
    const t = `${pad2(new Date(ctx.now).getUTCDate())} ${MONTHS[new Date(ctx.now).getUTCMonth()]} ${new Date(ctx.now).getUTCFullYear()}`;
    ctx.log('stdout', `1:C ${t} 09:00:00.000 * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo\n`);
    ctx.log('stdout', `1:M ${t} 09:00:00.001 * Running mode=standalone, port=6379.\n`);
    ctx.log('stdout', `1:M ${t} 09:00:00.002 * Ready to accept connections tcp\n`);
    return { kind: 'running', listen: [6379] };
  },
  onStop(ctx) {
    ctx.log('stdout', '1:signal-handler Received SIGTERM scheduling shutdown...\n1:M * Redis is now ready to exit, bye bye...\n');
  },
  http: notHttp('Received HTTP/0.9 when not allowed', 1),
};

const postgres: Program = {
  termExit: 0,
  start(ctx) {
    const pgdata = ctx.env.PGDATA ?? '/var/lib/postgresql/data';
    const initialized = readFile(ctx.container, `${pgdata}/PG_VERSION`) !== null;
    if (!initialized) {
      if (!ctx.env.POSTGRES_PASSWORD && ctx.env.POSTGRES_HOST_AUTH_METHOD !== 'trust') {
        ctx.log(
          'stderr',
          'Error: Database is uninitialized and superuser password is not specified.\n' +
            '       You must specify POSTGRES_PASSWORD to a non-empty value for the\n' +
            '       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".\n\n' +
            '       You may also use "POSTGRES_HOST_AUTH_METHOD=trust" to allow all\n' +
            '       connections without a password. This is *not* recommended.\n\n' +
            '       See PostgreSQL documentation about "trust":\n' +
            '       https://www.postgresql.org/docs/current/auth-trust.html\n',
        );
        return { kind: 'exited', code: 1 };
      }
      writeFile(ctx.container, `${pgdata}/PG_VERSION`, '17\n');
      writeFile(ctx.container, `${pgdata}/postgresql.conf`, "listen_addresses = '*'\n");
      ctx.log('stdout', 'The files belonging to this database system will be owned by user "postgres".\n');
      ctx.log('stdout', 'PostgreSQL init process complete; ready for start up.\n\n');
    } else {
      ctx.log('stdout', '\nPostgreSQL Database directory appears to contain a database; Skipping initialization\n\n');
    }
    ctx.log('stderr', `${new Date(ctx.now).toISOString().replace('T', ' ').slice(0, 23)} UTC [1] LOG:  database system is ready to accept connections\n`);
    return { kind: 'running', listen: [5432] };
  },
  http: notHttp('Empty reply from server', 52),
};

const mysql: Program = {
  termExit: 0,
  start(ctx) {
    const ts = new Date(ctx.now).toISOString().replace('T', ' ').slice(0, 19) + '+00:00';
    ctx.log('stdout', `${ts} [Note] [Entrypoint]: Entrypoint script for MySQL Server 8.4.3-1.el9 started.\n`);
    const initialized = readFile(ctx.container, '/var/lib/mysql/ibdata1') !== null;
    if (!initialized) {
      if (!ctx.env.MYSQL_ROOT_PASSWORD && !ctx.env.MYSQL_ALLOW_EMPTY_PASSWORD && !ctx.env.MYSQL_RANDOM_ROOT_PASSWORD) {
        ctx.log(
          'stderr',
          `${ts} [ERROR] [Entrypoint]: Database is uninitialized and password option is not specified\n` +
            '    You need to specify one of the following as an environment variable:\n' +
            '    - MYSQL_ROOT_PASSWORD\n    - MYSQL_ALLOW_EMPTY_PASSWORD\n    - MYSQL_RANDOM_ROOT_PASSWORD\n',
        );
        return { kind: 'exited', code: 1 };
      }
      writeFile(ctx.container, '/var/lib/mysql/ibdata1', '');
    }
    ctx.log('stderr', `${ts} 0 [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. Version: '8.4.3'  socket: '/var/run/mysqld/mysqld.sock'  port: 3306  MySQL Community Server - GPL.\n`);
    return { kind: 'running', listen: [3306, 33060] };
  },
  http: notHttp('Received HTTP/0.9 when not allowed', 1),
};

// ------------------------------------------------------------------ generic processes

/** `sleep N` / `tail -f`: long-running, and as PID 1 it ignores SIGTERM (docker stop → 137). */
const idle: Program = {
  termExit: null,
  start(ctx) {
    const [exe, arg] = ctx.container.argv;
    if (exe.endsWith('sleep')) {
      if (arg === undefined) {
        ctx.log('stderr', "sleep: missing operand\nTry 'sleep --help' for more information.\n");
        return { kind: 'exited', code: 1 };
      }
      const secs = arg === 'infinity' ? Infinity : parseFloat(arg);
      if (Number.isNaN(secs)) {
        ctx.log('stderr', `sleep: invalid time interval '${arg}'\n`);
        return { kind: 'exited', code: 1 };
      }
      if (secs < 3) return { kind: 'exited', code: 0 };
    }
    return { kind: 'running', listen: [] };
  },
};

/** A shell without a script and without a TTY reads EOF and exits immediately. */
const shellNoInput: Program = { termExit: 0, start: () => ({ kind: 'exited', code: 0 }) };

/** Run a command line (e.g. `sh -c "..."` or `echo hi`) once in the container. */
function runOnce(line: string): Program {
  return {
    termExit: null,
    start(ctx) {
      const sh = ctx.shell();
      if (!sh) return { kind: 'exited', code: 0 };
      const r = sh.run(line);
      for (const chunk of r.output) ctx.log(chunk.stream, chunk.text);
      // A script that ends by waiting forever keeps the container up.
      if (/\b(sleep\s+(infinity|\d{2,})|tail\s+-f)\b/.test(line)) return { kind: 'running', listen: [] };
      return { kind: 'exited', code: r.exitCode };
    },
  };
}

export const HELLO = `
Hello from Docker!
This message shows that your installation appears to be working correctly.

To generate this message, Docker took the following steps:
 1. The Docker client contacted the Docker daemon.
 2. The Docker daemon pulled the "hello-world" image from the Docker Hub.
    (amd64)
 3. The Docker daemon created a new container from that image which runs the
    executable that produces the output you are currently reading.
 4. The Docker daemon streamed that output to the Docker client, which sent it
    to your terminal.

To try something more ambitious, you can run an Ubuntu container with:
 $ docker run -it ubuntu bash

Share images, automate workflows, and more with a free Docker ID:
 https://hub.docker.com/

For more examples and ideas, visit:
 https://docs.docker.com/get-started/

`;

const hello: Program = {
  termExit: 0,
  start(ctx) {
    ctx.log('stdout', HELLO);
    return { kind: 'exited', code: 0 };
  },
};

// ------------------------------------------------------------------ app scripts (python / node)

/** A tiny static analysis of an app script: what it prints, needs and serves. */
export function analyzeScript(src: string): { port: number | null; requiredEnv: string[]; prints: string[]; body: string } {
  const portMatch =
    /\.listen\(\s*(\d{2,5})/.exec(src) ??
    /PORT\s*\|\|\s*(\d{2,5})/.exec(src) ??
    /port\s*=\s*(\d{2,5})/.exec(src) ??
    /HTTPServer\(\s*\(\s*["'][^"']*["']\s*,\s*(\d{2,5})/.exec(src);
  const requiredEnv = [...src.matchAll(/os\.environ\[\s*["'](\w+)["']\s*\]/g)].map((m) => m[1]);
  for (const m of src.matchAll(/if\s*\(\s*!\s*process\.env\.(\w+)\s*\)\s*(?:\{\s*)?throw/g)) requiredEnv.push(m[1]);
  const prints = [...src.matchAll(/(?:print|console\.log)\(\s*(?:f?["'`])([^"'`]*)["'`]\s*\)/g)].map((m) => m[1]);
  const bodyMatch = /(?:res\.(?:end|send)|return|wfile\.write\(b?)\(?\s*b?["'`]([^"'`]+)["'`]/.exec(src);
  return { port: portMatch ? Number(portMatch[1]) : null, requiredEnv, prints, body: bodyMatch ? bodyMatch[1] : 'OK' };
}

function scriptApp(lang: 'python' | 'node', scriptPath: string): Program {
  return {
    termExit: 0,
    start(ctx) {
      const abs = resolvePath(ctx.container.workdir, scriptPath);
      const src = readFile(ctx.container, abs);
      if (src === null) {
        if (lang === 'python') {
          ctx.log('stderr', `python3: can't open file '${abs}': [Errno 2] No such file or directory\n`);
          return { kind: 'exited', code: 2 };
        }
        ctx.log('stderr', `node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module '${abs}'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n    at node:internal/main/run_main_module:28:49 {\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js v22.11.0\n`);
        return { kind: 'exited', code: 1 };
      }
      const info = analyzeScript(src);
      const missing = info.requiredEnv.find((k) => !(k in ctx.env));
      if (missing) {
        if (lang === 'python') {
          ctx.log('stderr', `Traceback (most recent call last):\n  File "${abs}", line 1, in <module>\nKeyError: '${missing}'\n`);
        } else {
          ctx.log('stderr', `${abs}:1\nError: missing required environment variable ${missing}\n\nNode.js v22.11.0\n`);
        }
        return { kind: 'exited', code: 1 };
      }
      for (const p of info.prints) ctx.log('stdout', p.replace(/\{(\w+)\}|\$\{(\w+)\}/g, (_m, a, b) => ctx.env[a ?? b] ?? '') + '\n');
      if (info.port === null) return { kind: 'exited', code: 0 };
      const port = Number(ctx.env.PORT) || info.port;
      return { kind: 'running', listen: [port] };
    },
    http(ctx, path) {
      const src = readFile(ctx.container, resolvePath(ctx.container.workdir, scriptPath)) ?? '';
      ctx.log('stdout', `172.17.0.1 - - [${clf(ctx.now)}] "GET ${path} HTTP/1.1" 200 -\n`);
      return html(200, analyzeScript(src).body + '\n', lang === 'python' ? 'BaseHTTP/0.6 Python/3.12.7' : 'Node.js', 'text/plain');
    },
  };
}

/** `python -c "print('hi')"`: print the literals, exit 0. */
function pythonInline(code: string): Program {
  return {
    termExit: 0,
    start(ctx) {
      for (const p of analyzeScript(code).prints) ctx.log('stdout', p + '\n');
      return { kind: 'exited', code: 0 };
    },
  };
}

function pythonHttpServer(port: number): Program {
  return {
    termExit: 0,
    start(ctx) {
      ctx.log('stdout', `Serving HTTP on 0.0.0.0 port ${port} (http://0.0.0.0:${port}/) ...\n`);
      return { kind: 'running', listen: [port] };
    },
    http(ctx, path) {
      const dir = resolvePath(ctx.container.workdir, '.' + path);
      const node = lookup(ctx.container, dir);
      ctx.log('stderr', `172.17.0.1 - - [${clf(ctx.now)}] "GET ${path} HTTP/1.1" ${node ? 200 : 404} -\n`);
      if (node?.type === 'file') return html(200, node.content, 'SimpleHTTP/0.6 Python/3.12.7');
      if (node?.type === 'dir') {
        const items = Object.keys(node.children).sort().map((n) => `<li><a href="${n}">${n}</a></li>`).join('\n');
        return html(200, `<!DOCTYPE HTML>\n<html>\n<body>\n<h1>Directory listing for ${path}</h1>\n<hr>\n<ul>\n${items}\n</ul>\n<hr>\n</body>\n</html>\n`, 'SimpleHTTP/0.6 Python/3.12.7');
      }
      return html(404, 'File not found\n', 'SimpleHTTP/0.6 Python/3.12.7');
    },
  };
}

// ------------------------------------------------------------------ resolution

function quote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/**
 * Decide which program a container's argv runs. `hasCommand` says whether a
 * simulated Linux command of that name exists; `hasFile` checks the container fs;
 * `shells` lists the shells the image ships (alpine has no bash).
 */
export function resolveProgram(
  argv: string[],
  hasCommand: (name: string) => boolean,
  hasFile: (path: string) => boolean,
  shells: string[],
): Program | { oci: string } {
  let args = argv;
  if (args.length && /(^|\/)docker-entrypoint\.sh$/.test(args[0])) args = args.slice(1);
  if (!args.length) return { oci: '' };
  const [exe, ...rest] = args;
  const base = exe.split('/').pop() ?? exe;
  switch (base) {
    case 'nginx':
      return nginx;
    case 'httpd-foreground':
      return httpd;
    case 'redis-server':
      return redis;
    case 'postgres':
      return postgres;
    case 'mysqld':
      return mysql;
    case 'hello':
      return hasFile(exe.startsWith('/') ? exe : '/' + exe) ? hello : { oci: exe };
    case 'sleep':
      return idle;
    case 'tail':
      return rest.includes('-f') ? idle : runOnce(args.map(quote).join(' '));
    case 'sh':
    case 'bash':
    case 'ash':
    case 'dash': {
      if (!shells.includes(base)) return { oci: exe };
      const c = rest.indexOf('-c');
      if (c < 0 || rest[c + 1] === undefined) return shellNoInput;
      const script = rest[c + 1].trim().replace(/^exec\s+/, '');
      // Shell-form CMD ("python app.py") is just a wrapper around one program.
      if (/^[\w./=:@ -]+$/.test(script) && !/[;&|<>]/.test(script)) {
        const inner = resolveProgram(script.split(/\s+/), hasCommand, hasFile, shells);
        if (!('oci' in inner)) return inner;
      }
      return runOnce(rest[c + 1]);
    }
    case 'python':
    case 'python3': {
      if (rest[0] === '-m' && rest[1] === 'http.server') return pythonHttpServer(Number(rest[2]) || 8000);
      if (rest[0] === '-c') return pythonInline(rest[1] ?? '');
      return rest[0] ? scriptApp('python', rest[0]) : shellNoInput;
    }
    case 'node':
      return rest[0] && !rest[0].startsWith('-') ? scriptApp('node', rest[0]) : shellNoInput;
    default:
      if (hasCommand(base)) return runOnce(args.map(quote).join(' '));
      return { oci: exe };
  }
}
