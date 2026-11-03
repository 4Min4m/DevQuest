import { LOCAL_HOSTS, registerHttpProvider } from '../net';
import { isLocalIp, resolveHost } from '../netsim/resolve';
import { journalctl, systemctl } from './commands';

export { Systemd } from './manager';
export type * from './types';

/** curl to services listening on this host (started by systemd or present at boot). */
registerHttpProvider((state, req) => {
  if (state.context || !state.systemd) return undefined;
  const local = LOCAL_HOSTS.has(req.host) || (() => {
    const ip = resolveHost(state, req.host);
    return !!ip && isLocalIp(state, ip);
  })();
  if (!local) return undefined;
  const proc = state.processes.find((p) => p.ports?.includes(req.port));
  if (!proc) return undefined;
  const exe = proc.command.split(/\s+/)[0];
  const spec = state.systemd.binaries[exe];
  if (exe.endsWith('sshd') || proc.command.startsWith('sshd')) {
    return { kind: 'error', code: 1, message: 'Received HTTP/0.9 when not allowed' };
  }
  const routes = spec?.http;
  if (!routes) return { kind: 'error', code: 52, message: 'Empty reply from server' };
  const route = routes[req.path] ?? routes[req.path.replace(/\/$/, '')];
  if (!route) return { kind: 'response', res: { status: 404, body: '404 page not found\n', headers: { 'Content-Type': 'text/plain; charset=utf-8' } } };
  return { kind: 'response', res: { status: route.status ?? 200, body: route.body, headers: { 'Content-Type': 'text/plain; charset=utf-8' } } };
});

export const systemdCommands = [systemctl, journalctl];
