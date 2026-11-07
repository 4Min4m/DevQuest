/** The simulated systemd: loads unit files, starts/stops services, writes the journal. */
import { spaceGuard } from '../disk';
import { resolveHost } from '../netsim/resolve';
import type { Process, SimState } from '../state';
import { Vfs } from '../vfs/vfs';
import type { BinarySpec, JournalEntry, SystemdState, UnitRuntime } from './types';
import { parseUnit, UnitConfig } from './unitfile';
import { unpem } from '../security/tls';
import { startHooks } from './hooks';
import type { Cert } from '../security/tls';

export const UNIT_DIRS = ['/etc/systemd/system', '/lib/systemd/system'];
const ROOT = { name: 'root', groups: ['root'] };

export interface LoadedUnit {
  name: string;
  path: string;
  /** Config systemd is actually using (as of the last daemon-reload). */
  config: UnitConfig;
  runtime: UnitRuntime;
  /** The file changed on disk since it was loaded. */
  stale: boolean;
}

export class Systemd {
  constructor(public readonly state: SimState) {
    if (!state.systemd) throw new Error('this machine has no systemd');
  }

  get sd(): SystemdState {
    return this.state.systemd!;
  }

  private vfs(): Vfs {
    return new Vfs(this.state.fs, ROOT, () => this.state.clock);
  }

  private read(path: string): string | null {
    try {
      return this.vfs().readFile(path);
    } catch {
      return null;
    }
  }

  /** Where the unit file lives (/etc overrides /lib), or null. */
  unitPath(name: string): string | null {
    for (const dir of UNIT_DIRS) {
      const p = `${dir}/${name}`;
      if (this.read(p) !== null) return p;
    }
    return null;
  }

  /** All unit names that have a file or runtime state. */
  allUnits(): string[] {
    const names = new Set(Object.keys(this.sd.units));
    for (const dir of UNIT_DIRS) {
      try {
        for (const f of this.vfs().readdir(dir)) if (f.endsWith('.service')) names.add(f);
      } catch {
        /* dir missing */
      }
    }
    return [...names].sort();
  }

  private runtime(name: string): UnitRuntime {
    return (this.sd.units[name] ??= {
      name,
      active: 'inactive',
      sub: 'dead',
      enabled: false,
      mainPid: null,
      since: this.state.clock,
      result: 'success',
      loadedSource: null,
      restarts: 0,
    });
  }

  /** Load a unit: the config systemd uses is the file content as of the last daemon-reload. */
  load(name: string): LoadedUnit | null {
    const path = this.unitPath(name);
    if (!path) return null;
    const current = this.read(path)!;
    const rt = this.runtime(name);
    // A unit nobody loaded yet is read fresh; an already-loaded one keeps its old config
    // until `systemctl daemon-reload`.
    if (rt.loadedSource === null) rt.loadedSource = current;
    const source = rt.loadedSource;
    return { name, path, config: parseUnit(name, source, path), runtime: rt, stale: source !== current };
  }

  /** `systemctl daemon-reload`: pick up every unit file as it is now. */
  daemonReload(): void {
    for (const name of this.allUnits()) {
      const path = this.unitPath(name);
      if (path) this.runtime(name).loadedSource = this.read(path);
    }
    this.log('systemd', 1, '', 'Reloading.');
  }

  log(ident: string, pid: number, unit: string, message: string, priority = 6): void {
    this.sd.journal.push({ time: this.state.clock, ident, pid, unit, message, priority } satisfies JournalEntry);
  }

  private envOf(cfg: UnitConfig): Record<string, string> | { missingFile: string } {
    const env: Record<string, string> = {};
    for (const f of cfg.environmentFiles) {
      const optional = f.startsWith('-');
      const path = f.replace(/^-/, '');
      const text = this.read(path);
      if (text === null) {
        if (optional) continue;
        return { missingFile: path };
      }
      for (const line of text.split('\n')) {
        const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$/.exec(line);
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
    return { ...env, ...cfg.environment };
  }

  /** Is a TCP port already taken on this host? */
  portOwner(port: number): string | null {
    const p = this.state.processes.find((x) => x.ports?.includes(port));
    if (p) return p.command.split(' ')[0];
    const c = this.state.docker?.containers.find((x) => (x.status === 'running' || x.status === 'restarting') && x.ports.some((b) => b.hostPort === port));
    return c ? 'docker-proxy' : null;
  }

  /**
   * Run the unit's program once. Returns null on success (process started) or the
   * failure: the exit status and the log lines the program/systemd write.
   */
  private spawn(u: LoadedUnit): { pid: number; status?: number; step?: string; lines: { ident: string; msg: string; prio: number }[] } {
    const cfg = u.config;
    const [exe] = cfg.execStart.split(/\s+/);
    const pid = this.state.nextPid++;
    const lines: { ident: string; msg: string; prio: number }[] = [];
    const exeName = exe.split('/').pop()!;
    const fail = (status: number, ...msgs: string[]) => {
      for (const m of msgs) lines.push({ ident: exeName, msg: m, prio: 3 });
      return { pid, status, lines };
    };
    // systemd-level failures (before the program runs)
    if (cfg.user && !this.state.users.some((x) => x.name === cfg.user)) {
      lines.push({ ident: '(' + exeName + ')', msg: `${u.name}: Failed to determine user credentials: No such process`, prio: 3 });
      lines.push({ ident: '(' + exeName + ')', msg: `${u.name}: Failed at step USER spawning ${exe}: No such process`, prio: 3 });
      return { pid, status: 217, step: 'USER', lines };
    }
    let node;
    try {
      node = this.vfs().lookup(exe);
    } catch {
      node = null;
    }
    if (!node || node.type !== 'file') {
      lines.push({ ident: '(' + exeName + ')', msg: `${u.name}: Unable to locate executable '${exe}': No such file or directory`, prio: 3 });
      lines.push({ ident: '(' + exeName + ')', msg: `${u.name}: Failed at step EXEC spawning ${exe}: No such file or directory`, prio: 3 });
      return { pid, status: 203, step: 'EXEC', lines };
    }
    if ((node.mode & 0o111) === 0) {
      lines.push({ ident: '(' + exeName + ')', msg: `${u.name}: Failed to execute ${exe}: Permission denied`, prio: 3 });
      lines.push({ ident: '(' + exeName + ')', msg: `${u.name}: Failed at step EXEC spawning ${exe}: Permission denied`, prio: 3 });
      return { pid, status: 203, step: 'EXEC', lines };
    }
    const envOrErr = this.envOf(cfg);
    if ('missingFile' in envOrErr) {
      lines.push({ ident: 'systemd', msg: `${u.name}: Failed to load environment files: No such file or directory`, prio: 3 });
      lines.push({ ident: 'systemd', msg: `${u.name}: Failed to spawn 'start' task: No such file or directory`, prio: 3 });
      return { pid, status: 243, step: 'EXEC', lines };
    }
    const env = envOrErr;
    const spec: BinarySpec = this.sd.binaries[exe] ?? {};
    const name = spec.name ?? exeName;
    const ident = name;
    for (const f of spec.requireFiles ?? []) {
      if (this.read(f) === null) return fail(1, `Error: open ${f}: no such file or directory`);
    }
    let tlsCert: string | undefined;
    if (spec.tls) {
      const cert = this.read(spec.tls.cert);
      const key = this.read(spec.tls.key);
      if (cert === null) return fail(1, `Error: open ${spec.tls.cert}: no such file or directory`);
      if (key === null) return fail(1, `Error: open ${spec.tls.key}: no such file or directory`);
      const c = unpem<Cert>('cert', cert)[0];
      const k = unpem<{ keyId: string }>('key', key)[0];
      if (!c) return fail(1, `Error: tls: failed to find any PEM data in certificate input`);
      if (!k || k.keyId !== c.keyId) return fail(1, `Error: tls: private key does not match public key`);
      tlsCert = cert;
    }
    for (const k of spec.requireEnv ?? []) {
      if (!env[k]) return fail(1, `Error: environment variable ${k} is required but not set`);
    }
    const nofile = cfg.limitNofile ?? 1024;
    if (spec.minNofile && nofile < spec.minNofile) {
      return fail(1, `accept tcp [::]:${spec.listen ?? 8080}: accept4: too many open files; retrying in 1s`, `fatal: too many open files (limit ${nofile}, need ${spec.minNofile})`);
    }
    if (spec.connect) {
      const host = env[spec.connect.hostEnv];
      if (!host) return fail(1, `Error: environment variable ${spec.connect.hostEnv} is required but not set`);
      const ip = resolveHost(this.state, host);
      if (!ip) return fail(1, `Error: dial tcp: lookup ${host} on ${this.state.net?.resolver ?? '127.0.0.53'}:53: no such host`);
      const remote = this.state.net?.remotes.find((r) => r.ip === ip);
      if (!remote || !remote.up) return fail(1, `Error: dial tcp ${ip}:${spec.connect.port}: connect: connection timed out`);
      if (!remote.services[spec.connect.port]) return fail(1, `Error: dial tcp ${ip}:${spec.connect.port}: connect: connection refused`);
    }
    if (spec.writesTo) {
      const ok = spaceGuard(this.state)(spec.writesTo + '/.probe', { inodes: 1, bytes: 4096 });
      if (!ok) return fail(1, `Error: open ${spec.writesTo}/upload-${pid}.tmp: no space left on device`);
    }
    const port = spec.portEnv && env[spec.portEnv] ? Number(env[spec.portEnv]) : spec.listen;
    if (port) {
      const owner = this.portOwner(port);
      if (owner) return fail(1, `Error: listen tcp :${port}: bind: address already in use`);
    }
    // Started successfully.
    const proc: Process = {
      pid,
      ppid: 1,
      user: cfg.user ?? 'root',
      command: cfg.execStart,
      tty: '?',
      stat: 'Ssl',
      cpu: 0.3,
      mem: 0.6,
      vsz: 1_200_000,
      rss: spec.memKb ?? 24_000,
      start: '09:00',
      time: '0:00',
      ports: port ? [port] : undefined,
      unit: u.name,
      files: cfg.workingDirectory ? [cfg.workingDirectory] : undefined,
      ...(tlsCert ? { tls: tlsCert } : {}),
    };
    this.state.processes.push(proc);
    for (const l of spec.startLog ?? []) lines.push({ ident, msg: l.replace('{port}', String(port)), prio: 6 });
    return { pid, lines };
  }

  /** `systemctl start`. Returns the resulting runtime state. */
  start(name: string): LoadedUnit | null {
    const u = this.load(name);
    if (!u) return null;
    const rt = u.runtime;
    if (rt.active === 'active') return u;
    if (u.config.badSetting) {
      this.log('systemd', 1, name, u.config.badSetting, 3);
      return u;
    }
    for (const w of u.config.warnings) this.log('systemd', 1, name, w, 4);
    const restartOnFail = u.config.restart === 'always' || u.config.restart === 'on-failure' || u.config.restart === 'on-abnormal';
    let attempts = 0;
    for (;;) {
      this.log('systemd', 1, name, `Started ${name} - ${u.config.description}.`);
      const r = this.spawn(u);
      for (const l of r.lines) this.log(l.ident, l.ident === 'systemd' ? 1 : r.pid, name, l.msg, l.prio);
      if (r.status === undefined) {
        rt.active = 'active';
        rt.sub = 'running';
        for (const h of startHooks) h(this.state, name);
        rt.mainPid = r.pid;
        rt.since = this.state.clock;
        rt.result = 'success';
        delete rt.exitStatus;
        return u;
      }
      const label = r.step ? `${r.status}/${r.step}` : `${r.status}/FAILURE`;
      this.log('systemd', 1, name, `${name}: Main process exited, code=exited, status=${label}`, 4);
      this.log('systemd', 1, name, `${name}: Failed with result 'exit-code'.`, 4);
      rt.exitStatus = r.status;
      rt.mainPid = r.pid;
      rt.result = 'exit-code';
      if (restartOnFail && attempts < 4) {
        attempts++;
        rt.restarts++;
        this.log('systemd', 1, name, `${name}: Scheduled restart job, restart counter is at ${rt.restarts}.`);
        continue;
      }
      // Without Restart=, a crash after launch is just "Failed with result"; systemd only
      // reports "Failed to start" when it gives up restarting.
      if (restartOnFail) {
        rt.restarts++;
        this.log('systemd', 1, name, `${name}: Start request repeated too quickly.`, 3);
        this.log('systemd', 1, name, `Failed to start ${name} - ${u.config.description}.`, 3);
      }
      rt.active = 'failed';
      rt.sub = 'failed';
      rt.since = this.state.clock;
      return u;
    }
  }

  stop(name: string): LoadedUnit | null {
    const u = this.load(name);
    if (!u) return null;
    const rt = u.runtime;
    if (rt.active === 'active' && rt.mainPid) {
      this.log('systemd', 1, name, `Stopping ${name} - ${u.config.description}...`);
      this.state.processes = this.state.processes.filter((p) => p.pid !== rt.mainPid);
      this.log('systemd', 1, name, `${name}: Deactivated successfully.`);
      this.log('systemd', 1, name, `Stopped ${name} - ${u.config.description}.`);
    }
    rt.active = 'inactive';
    rt.sub = 'dead';
    rt.mainPid = null;
    rt.since = this.state.clock;
    rt.result = 'success';
    rt.restarts = 0;
    return u;
  }

  restart(name: string): LoadedUnit | null {
    if (!this.unitPath(name)) return null;
    this.stop(name);
    return this.start(name);
  }

  /** The unit's main process (if running). */
  mainProcess(u: LoadedUnit): Process | undefined {
    return this.state.processes.find((p) => p.pid === u.runtime.mainPid);
  }

  /** Journal lines for some units (all when empty). */
  journal(units: string[]): JournalEntry[] {
    return this.sd.journal.filter((e) => !units.length || units.includes(e.unit));
  }
}
