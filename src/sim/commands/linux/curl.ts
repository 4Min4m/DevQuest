import type { CommandDef } from '../../shell/types';
import { httpRequest, parseUrl } from '../../net';
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
    let outFile: string | undefined;
    const urls: string[] = [];
    // Expand combined boolean short flags: -sSfL → -s -S -f -L
    const args = ctx.args.flatMap((a) => (/^-[sSiIfLvk]{2,}$/.test(a) ? [...a.slice(1)].map((c) => '-' + c) : [a]));
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
      else if (a === '-L' || a === '--location' || a === '-v' || a === '--verbose' || a === '-k' || a === '--insecure') {
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
      const result = httpRequest(ctx.state, url);
      if (result.kind === 'error') {
        if (!quietErrors) ctx.err(`curl: (${result.code}) ${result.message}\n`);
        code = result.code;
        continue;
      }
      const res = result.res;
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
