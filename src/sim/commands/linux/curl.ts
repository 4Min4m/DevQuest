import type { CommandDef } from '../../shell/types';
import { httpRequest, parseUrl } from '../../net';
import { errText } from './util';
import { resolveHost } from '../../netsim/resolve';

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
  503: 'Service Temporarily Unavailable',
  504: 'Gateway Time-out',
};

/**
 * Mocked curl: responses come from simulated services (e.g. Docker containers)
 * or static `state.network` entries. No real network access, ever.
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
    let verbose = false;
    let writeOut: string | undefined;
    let timeout: number | undefined;
    let outFile: string | undefined;
    const urls: string[] = [];
    let method: string | undefined;
    let body: string | undefined;
    let getData = false;
    let insecure = false;
    let cacert: string | undefined;
    const reqHeaders: Record<string, string> = {};
    // Expand combined boolean short flags: -sSfL → -s -S -f -L
    const args = ctx.args.flatMap((a) => (/^-[sSiIfLvkG]{2,}$/.test(a) ? [...a.slice(1)].map((c) => '-' + c) : [a]));
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--help' || a === '-h') {
        ctx.out('Usage: curl [options...] <url>\n -f, --fail        Fail fast with no output on HTTP errors\n -i, --include     Include response headers in output\n -I, --head        Show document info only\n -o, --output <file> Write to file instead of stdout\n -s, --silent      Silent mode\n -S, --show-error  Show error even when -s is used\n');
        return 0;
      }
      if (a === '-s' || a === '--silent') silent = true;
      else if (a === '-S' || a === '--show-error') showErrors = true;
      else if (a === '-i' || a === '--include') include = true;
      else if (a === '-I' || a === '--head') headOnly = true;
      else if (a === '-f' || a === '--fail') fail = true;
      else if (a === '-v' || a === '--verbose') verbose = true;
      else if (a === '-w' || a === '--write-out') writeOut = args[++i] ?? '';
      else if (a === '--connect-timeout' || a === '-m' || a === '--max-time') {
        const n = Number(args[++i]);
        if (!Number.isFinite(n) || n < 0) {
          ctx.err(`curl: option ${a}: expected a proper numerical parameter\ncurl: try 'curl --help' for more information\n`);
          return 2;
        }
        timeout = timeout === undefined ? n : Math.min(timeout, n);
      } else if (a === '-L' || a === '--location') {
        /* accepted; no visible effect in the simulator */
      } else if (a === '-o' || a === '--output') outFile = args[++i];
      else if (a === '-H' || a === '--header') {
        const h = args[++i] ?? '';
        const colon = h.indexOf(':');
        if (colon > 0) reqHeaders[h.slice(0, colon).trim().toLowerCase()] = h.slice(colon + 1).trim();
      } else if (a === '-X' || a === '--request') method = (args[++i] ?? 'GET').toUpperCase();
      else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-urlencode') {
        const d = args[++i] ?? '';
        const enc = a === '--data-urlencode' ? d.replace(/^([^=]*=)?(.*)$/s, (_m, k: string | undefined, v: string) => (k ?? '') + encodeURIComponent(v)) : d;
        body = body === undefined ? enc : body + '&' + enc;
      } else if (a === '-G' || a === '--get') getData = true;
      else if (a === '-k' || a === '--insecure') insecure = true;
      else if (a === '--cacert') cacert = args[++i];
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
      const url = parseUrl(getData && body !== undefined ? raw + (raw.includes('?') ? '&' : '?') + body : raw, method ?? (body !== undefined && !getData ? 'POST' : 'GET'));
      if (url) {
        if (body !== undefined && !getData) (url as typeof url & { body?: string }).body = body;
        if (insecure) url.insecure = true;
        if (cacert) {
          try {
            url.cacert = ctx.vfs.readFile(ctx.resolve(cacert));
          } catch {
            if (!quietErrors) ctx.err(`curl: (77) error setting certificate file: ${cacert}\n`);
            code = 77;
            continue;
          }
        }
      }
      if (!url) {
        if (!quietErrors) ctx.err(`curl: (3) URL rejected: Malformed input to a URL function\n`);
        code = 3;
        continue;
      }
      const ip = remoteIp(ctx.state, url.host);
      if (verbose && ip) ctx.err(`*   Trying ${ip}:${url.port}...\n`);
      if (Object.keys(reqHeaders).length) url.headers = reqHeaders;
      let result = httpRequest(ctx.state, url);
      if (result.kind === 'error' && result.code === 28 && timeout !== undefined) {
        result = { kind: 'error', code: 28, message: `Failed to connect to ${url.host} port ${url.port} after ${Math.round(timeout * 1000) + 1} ms: Timeout was reached` };
      }
      const writeStats = (status: number) => {
        if (writeOut !== undefined) ctx.out(formatWriteOut(writeOut, { status, ip: ip ?? '', url: raw, time: result.kind === 'error' && result.code === 28 ? (timeout ?? 133.012) : 0.012 }));
      };
      if (result.kind === 'error') {
        if (verbose) ctx.err(`* ${result.message}\n* Closing connection\n`);
        if (!quietErrors) ctx.err(`curl: (${result.code}) ${result.message}\n`);
        code = result.code;
        writeStats(0);
        continue;
      }
      const res = result.res;
      if (verbose) {
        let v = `* Connected to ${url.host} (${ip}) port ${url.port}\n> ${headOnly ? 'HEAD' : url.method} ${url.path} HTTP/1.1\n> Host: ${reqHeaders.host ?? url.host + (url.port === 80 || url.port === 443 ? '' : ':' + url.port)}\n> User-Agent: curl/8.5.0\n> Accept: */*\n>\n`;
        v += `< HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status] ?? ''}\n`;
        const hs = { 'Content-Length': String(new TextEncoder().encode(res.body).length), ...(res.headers ?? {}) };
        for (const [k, val] of Object.entries(hs)) v += `< ${k}: ${val}\n`;
        ctx.err(v + '<\n');
      }
      if (fail && res.status >= 400) {
        if (!quietErrors) ctx.err(`curl: (22) The requested URL returned error: ${res.status}\n`);
        code = 22;
        writeStats(res.status);
        continue;
      }
      let headerText = `HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status] ?? ''}\n`;
      const headers = { 'Content-Length': String(new TextEncoder().encode(res.body).length), ...(res.headers ?? {}) };
      for (const [k, v] of Object.entries(headers)) headerText += `${k}: ${v}\n`;
      headerText += '\n';
      const output = headOnly ? headerText : (include ? headerText : '') + res.body;
      if (outFile === '/dev/null') {
        /* discarded */
      } else if (outFile !== undefined) {
        try {
          ctx.vfs.writeFile(ctx.resolve(outFile), output);
        } catch (e) {
          if (!quietErrors) ctx.err(`curl: (23) Failed writing body: ${outFile}: ${errText(e)}\n`);
          code = 23;
        }
      } else {
        ctx.out(output);
      }
      if (verbose) ctx.err(`* Connection #0 to host ${url.host} left intact\n`);
      writeStats(res.status);
    }
    return code;
  },
};

function remoteIp(state: Parameters<typeof resolveHost>[0], host: string): string | null {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return '127.0.0.1';
  return state.net ? resolveHost(state, host) : null;
}

/** curl -w: the handful of variables people actually use in health checks. */
function formatWriteOut(fmt: string, v: { status: number; ip: string; url: string; time: number }): string {
  const vars: Record<string, string> = {
    http_code: String(v.status).padStart(3, '0'),
    response_code: String(v.status).padStart(3, '0'),
    remote_ip: v.ip,
    time_total: v.time.toFixed(6),
    time_connect: (v.time / 2).toFixed(6),
    url_effective: v.url,
  };
  return fmt
    .replace(/%\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}
