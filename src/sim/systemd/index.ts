import { LOCAL_HOSTS, registerHttpProvider } from '../net';
import type { HttpResult, Request } from '../net';
import { appHandlers } from './hooks';
import { curlTlsMessage, verifyCert } from '../security/tls';
import type { SimState } from '../state';
import { joinPath, normalize } from '../vfs/path';
import { Vfs } from '../vfs/vfs';
import { isLocalIp, resolveHost } from '../netsim/resolve';
import { journalctl, systemctl } from './commands';

export { Systemd } from './manager';
export type * from './types';

/** Answer an HTTP request to `port` on machine `state` from whatever process listens there. */
export function answerOnMachine(state: SimState, port: number, path: string, req?: Request & { body?: string }): HttpResult | undefined {
  const proc = state.processes.find((p) => p.ports?.includes(port));
  if (!proc) return undefined;
  const exe = proc.command.split(/\s+/)[0];
  const spec = state.systemd?.binaries[exe];
  if (exe.endsWith('sshd') || proc.command.startsWith('sshd')) {
    return { kind: 'error', code: 1, message: 'Received HTTP/0.9 when not allowed' };
  }
  const https = !!req?.key.startsWith('https:');
  if (proc.tls) {
    if (!https) return { kind: 'response', res: { status: 400, body: 'Client sent an HTTP request to an HTTPS server.\n', headers: { 'Content-Type': 'text/plain; charset=utf-8' } } };
    if (!req?.insecure) {
      const err = verifyCert(state, proc.tls, req!.host, req!.cacert);
      if (err) return { kind: 'error', code: err.code, message: curlTlsMessage(err, req!.host) };
    }
  } else if (https) return { kind: 'error', code: 35, message: 'OpenSSL/3.0.13: error:0A00010B:SSL routines::wrong version number' };
  if (spec?.app && appHandlers[spec.app]) return appHandlers[spec.app](state, req ?? { key: `http://localhost:${port}${path}`, host: 'localhost', port, path, method: 'GET' });
  if (spec?.staticRoot) {
    const vfs = new Vfs(state.fs, { name: 'root', groups: ['root'] });
    const clean = normalize(joinPath(spec.staticRoot, path.split('?')[0]));
    const candidates = vfs.isDir(clean) ? ['index.html', 'index.htm', 'index.nginx-debian.html'].map((i) => joinPath(clean, i)) : [clean];
    const server = spec.server ?? 'nginx';
    for (const c of candidates) {
      try {
        return { kind: 'response', res: { status: 200, body: vfs.readFile(c), headers: { Server: server, 'Content-Type': c.endsWith('.html') ? 'text/html' : 'text/plain' } } };
      } catch {
        /* next */
      }
    }
    const sig = server.split(' ')[0];
    return { kind: 'response', res: { status: 404, body: `<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>${sig}</center>\r\n</body>\r\n</html>\r\n`, headers: { Server: server, 'Content-Type': 'text/html' } } };
  }
  const routes = spec?.http;
  if (!routes) return { kind: 'error', code: 52, message: 'Empty reply from server' };
  const route = routes[path] ?? routes[path.replace(/\/$/, '')];
  if (!route) return { kind: 'response', res: { status: 404, body: '404 page not found\n', headers: { 'Content-Type': 'text/plain; charset=utf-8' } } };
  return { kind: 'response', res: { status: route.status ?? 200, body: route.body, headers: { 'Content-Type': 'text/plain; charset=utf-8' } } };
}

/** curl to services listening on this host (started by systemd or present at boot). */
registerHttpProvider((state, req) => {
  if (state.context || !state.systemd) return undefined;
  const local = LOCAL_HOSTS.has(req.host) || (() => {
    const ip = resolveHost(state, req.host);
    return !!ip && isLocalIp(state, ip);
  })();
  if (!local) return undefined;
  return answerOnMachine(state, req.port, req.path, req);
});

export const systemdCommands = [systemctl, journalctl];
