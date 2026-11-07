/** Install the monitoring stack on a machine: Prometheus, Alertmanager and Loki as systemd services. */
import type { SimState } from '../state';
import { Systemd } from '../systemd/manager';
import { Vfs } from '../vfs/vfs';
import type { LogStreamSpec, SeriesSpec } from './types';
import { promQuery } from './prometheus';

const SERVICES = {
  prometheus: { exe: '/usr/local/bin/prometheus', port: 9090, args: '--config.file=/etc/prometheus/prometheus.yml', desc: 'Prometheus' },
  alertmanager: { exe: '/usr/local/bin/alertmanager', port: 9093, args: '--config.file=/etc/alertmanager/alertmanager.yml', desc: 'Alertmanager' },
  loki: { exe: '/usr/local/bin/loki', port: 3100, args: '-config.file=/etc/loki/config.yml', desc: 'Loki' },
} as const;

export interface StackSpec {
  series?: SeriesSpec[];
  logs?: LogStreamSpec[];
  /** Which services run (default: all three). */
  services?: (keyof typeof SERVICES)[];
  /** Extra rule files: path → YAML. */
  rules?: Record<string, string>;
}

export function installStack(state: SimState, spec: StackSpec): void {
  state.obs = { epoch: state.clock, series: spec.series ?? [], logs: spec.logs ?? [], predLog: {}, silences: [] };
  if (!state.systemd) return;
  const v = new Vfs(state.fs, { name: 'root', groups: ['root'] }, () => state.clock);
  const write = (p: string, c: string, mode?: number) => {
    v.mkdir(p.replace(/\/[^/]+$/, ''), { parents: true });
    v.writeFile(p, c);
    if (mode) v.chmod(p, mode);
  };
  write('/etc/prometheus/prometheus.yml', `global:\n  scrape_interval: 15s\n  evaluation_interval: 15s\n\nalerting:\n  alertmanagers:\n    - static_configs:\n        - targets: ["localhost:9093"]\n\nrule_files:\n  - "rules/*.yml"\n\nscrape_configs:\n  - job_name: prometheus\n    static_configs:\n      - targets: ["localhost:9090"]\n  - job_name: apps\n    static_configs:\n      - targets: ["checkout:8080", "catalog:8080", "payments:8080"]\n`);
  v.mkdir('/etc/prometheus/rules', { parents: true });
  for (const [p, c] of Object.entries(spec.rules ?? {})) write(p, c);
  write('/etc/alertmanager/alertmanager.yml', 'route:\n  receiver: oncall\n  group_by: [alertname, service]\nreceivers:\n  - name: oncall\n');
  write('/etc/loki/config.yml', 'auth_enabled: false\nserver:\n  http_listen_port: 3100\n');
  const sd = new Systemd(state);
  for (const name of spec.services ?? (Object.keys(SERVICES) as (keyof typeof SERVICES)[])) {
    const s = SERVICES[name];
    write(s.exe, `\x7fELF ${name}\n`, 0o755);
    state.systemd.binaries[s.exe] = { name, listen: s.port, app: name, startLog: [`level=info msg="Server is ready to receive web requests."`] };
    write(`/etc/systemd/system/${name}.service`, `[Unit]\nDescription=${s.desc}\nAfter=network-online.target\n\n[Service]\nUser=root\nExecStart=${s.exe} ${s.args}\nExecReload=/bin/kill -HUP $MAINPID\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n`);
    sd.daemonReload();
    const u = sd.load(`${name}.service`);
    if (u) u.runtime.enabled = true;
    sd.start(`${name}.service`);
  }
}

/** Pretend Prometheus has been evaluating its current rules for `hours` (alerts already firing). */
export function backdateRules(state: SimState, hours = 6): void {
  if (!state.obs) return;
  promQuery(state, 'vector(1)');
  for (const k of Object.keys(state.obs.ruleSince ?? {})) state.obs.ruleSince![k] = state.clock - hours * 3600_000;
}
