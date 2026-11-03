/**
 * Simulated networking for curl. Providers (like the Docker engine) can answer
 * requests dynamically; static responses live in `state.network`. Nothing here
 * ever touches the real network.
 */
import type { HttpResponse, SimState } from './state';

export interface Request {
  /** Normalized key used for `state.network`, e.g. "http://example.com/path". */
  key: string;
  host: string;
  port: number;
  path: string;
  method: string;
}

export type HttpResult = { kind: 'response'; res: HttpResponse } | { kind: 'error'; code: number; message: string };

export interface RequestOptions {
  /** Probe without side effects (no access-log lines) — used by mission validators. */
  silent?: boolean;
}

export type HttpProvider = (state: SimState, req: Request, opts: RequestOptions) => HttpResult | undefined;

const providers: { p: HttpProvider; priority: number }[] = [];

/** Lower priority runs first; general fallbacks (like remote hosts) use a high number. */
export function registerHttpProvider(p: HttpProvider, priority = 0): void {
  if (providers.some((x) => x.p === p)) return;
  providers.push({ p, priority });
  providers.sort((a, b) => a.priority - b.priority);
}

export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export function parseUrl(raw: string, method = 'GET'): Request | null {
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : 'http://' + raw;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return { key: `${u.protocol}//${u.host}${path}${u.search}`, host: u.hostname, port, path: u.pathname || '/', method };
}

/** Resolve a request: dynamic providers first, then static endpoints, then connection errors. */
export function httpRequest(state: SimState, req: Request, opts: RequestOptions = {}): HttpResult {
  for (const { p } of providers) {
    const r = p(state, req, opts);
    if (r) return r;
  }
  const res = state.network[req.key] ?? state.network[req.key + '/'];
  if (res) return { kind: 'response', res };
  const known = LOCAL_HOSTS.has(req.host) || Object.keys(state.network).some((k) => parseUrl(k)?.host === req.host);
  if (known) {
    return { kind: 'error', code: 7, message: `Failed to connect to ${req.host} port ${req.port} after 0 ms: Couldn't connect to server` };
  }
  return { kind: 'error', code: 6, message: `Could not resolve host: ${req.host}` };
}
