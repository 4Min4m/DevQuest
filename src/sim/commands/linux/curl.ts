import type { CommandDef } from '../../shell/types';
import { errText } from './util';

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

interface ParsedUrl {
  key: string;
  host: string;
  port: number;
}

function parseUrl(raw: string): ParsedUrl | null {
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : 'http://' + raw;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  const key = `${u.protocol}//${u.host}${path}${u.search}`;
  return { key, host: u.hostname, port };
}

/**
 * Mocked curl: responses come from `state.network` (missions and the Docker
 * simulator register endpoints there). No real network access, ever.
 */
export const curl: CommandDef = {
  name: 'curl',
  summary: 'transfer a URL (simulated, offline)',
  run(ctx) {
    let silent = false;
    let showErrors = false;
    let include = false;
    let headOnly = false;
    let fail = false;
    let outFile: string | undefined;
    const urls: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-s' || a === '--silent') silent = true;
      else if (a === '-S' || a === '--show-error') showErrors = true;
      else if (a === '-sS' || a === '-Ss') silent = showErrors = true;
      else if (a === '-i' || a === '--include') include = true;
      else if (a === '-I' || a === '--head') headOnly = true;
      else if (a === '-f' || a === '--fail') fail = true;
      else if (a === '-fsSL' || a === '-sSL' || a === '-fsS') {
        silent = showErrors = true;
        fail = a.includes('f');
      } else if (a === '-L' || a === '--location' || a === '-v' || a === '--verbose' || a === '-k' || a === '--insecure') {
        /* accepted; no visible effect in the simulator */
      } else if (a === '-o' || a === '--output') outFile = args[++i];
      else if (a === '-X' || a === '--request' || a === '-H' || a === '--header' || a === '-d' || a === '--data') i++;
      else if (a.startsWith('-')) {
        ctx.err(`curl: option ${a}: is unknown (or not supported in devquest)\ncurl: try 'curl --help' for more information\n`);
        return 2;
      } else urls.push(a);
    }
    if (!urls.length) {
      ctx.err("curl: try 'curl --help' for more information\n");
      return 2;
    }
    const quietErrors = silent && !showErrors;
    let code = 0;
    for (const raw of urls) {
      const url = parseUrl(raw);
      if (!url) {
        if (!quietErrors) ctx.err(`curl: (3) URL rejected: Malformed input to a URL function\n`);
        code = 3;
        continue;
      }
      const res = ctx.state.network[url.key] ?? ctx.state.network[url.key + '/'];
      if (!res) {
        const known = LOCAL_HOSTS.has(url.host) || Object.keys(ctx.state.network).some((k) => parseUrl(k)?.host === url.host);
        if (known) {
          if (!quietErrors) ctx.err(`curl: (7) Failed to connect to ${url.host} port ${url.port} after 0 ms: Couldn't connect to server\n`);
          code = 7;
        } else {
          if (!quietErrors) ctx.err(`curl: (6) Could not resolve host: ${url.host}\n`);
          code = 6;
        }
        continue;
      }
      if (fail && res.status >= 400) {
        if (!quietErrors) ctx.err(`curl: (22) The requested URL returned error: ${res.status}\n`);
        code = 22;
        continue;
      }
      let headerText = `HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status] ?? ''}\n`;
      const headers = { 'Content-Length': String(new TextEncoder().encode(res.body).length), ...(res.headers ?? {}) };
      for (const [k, v] of Object.entries(headers)) headerText += `${k}: ${v}\n`;
      headerText += '\n';
      const output = headOnly ? headerText : (include ? headerText : '') + res.body;
      if (outFile !== undefined) {
        try {
          ctx.vfs.writeFile(ctx.resolve(outFile), output);
        } catch (e) {
          if (!quietErrors) ctx.err(`curl: (23) Failed writing body: ${outFile}: ${errText(e)}\n`);
          code = 23;
        }
      } else {
        ctx.out(output);
      }
    }
    return code;
  },
};
