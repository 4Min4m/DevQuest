import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { parseUnit, unitName } from './unitfile';

const UNIT = `[Unit]
Description=Demo app
After=network.target

[Service]
ExecStart=/opt/demo/demo --flag
Environment=PORT=8080 "GREETING=hello world"
Restart=on-failure

[Install]
WantedBy=multi-user.target
`;

/** A shell with /opt/demo/demo installed and its behaviour registered. */
function demo(unit = UNIT, spec: Record<string, unknown> = {}) {
  const t = makeShell();
  t.state.systemd!.binaries['/opt/demo/demo'] = {
    name: 'demo',
    portEnv: 'PORT',
    startLog: ['demo listening on :{port}'],
    http: { '/': { body: 'demo ok\n' } },
    ...spec,
  };
  t.setup('sudo mkdir -p /opt/demo', 'echo bin | sudo tee /opt/demo/demo > /dev/null', 'sudo chmod 755 /opt/demo/demo');
  t.shell.run(`echo '${unit}' | sudo tee /etc/systemd/system/demo.service`);
  return t;
}

describe('unit files', () => {
  it('parses the common keys', () => {
    const c = parseUnit('demo.service', UNIT);
    expect(c).toMatchObject({
      description: 'Demo app',
      execStart: '/opt/demo/demo --flag',
      environment: { PORT: '8080', GREETING: 'hello world' },
      restart: 'on-failure',
      wantedBy: ['multi-user.target'],
      warnings: [],
    });
    expect(c.badSetting).toBeUndefined();
  });

  it('warns about unknown keys and refuses units without an absolute ExecStart', () => {
    const c = parseUnit('x.service', '[Service]\nExecStrat=/bin/x\n');
    expect(c.warnings).toEqual(["/etc/systemd/system/x.service:2: Unknown key name 'ExecStrat' in section 'Service', ignoring."]);
    expect(c.badSetting).toMatch(/has no ExecStart=/);
    expect(parseUnit('y.service', '[Service]\nExecStart=python app.py\n').badSetting).toMatch(/Neither a valid executable name nor an absolute path: python/);
  });

  it('normalizes unit names', () => {
    expect(unitName('nginx')).toBe('nginx.service');
    expect(unitName('docker.socket')).toBe('docker.socket');
  });
});

describe('systemctl', () => {
  it('shows the built-in services', () => {
    const t = makeShell();
    const r = t.run('systemctl status ssh');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^● ssh\.service - OpenBSD Secure Shell server\n\s+Loaded: loaded \(\/lib\/systemd\/system\/ssh\.service; enabled; preset: enabled\)\n\s+Active: active \(running\)/);
    expect(r.out).toContain('Main PID: 655 (sshd)');
    expect(t.run('systemctl is-active cron')).toMatchObject({ out: 'active\n', code: 0 });
    expect(t.run('systemctl list-units').out).toContain('2 loaded units listed.');
  });

  it('needs root to change state', () => {
    const t = makeShell();
    expect(t.run('systemctl stop cron')).toMatchObject({
      err: "Failed to stop cron.service: Interactive authentication required.\nSee system logs and 'systemctl status cron.service' for details.\n",
      code: 1,
    });
    expect(t.run('sudo systemctl stop cron').code).toBe(0);
    expect(t.run('systemctl is-active cron')).toMatchObject({ out: 'inactive\n', code: 3 });
    expect(t.state.processes.some((p) => p.command.includes('cron'))).toBe(false);
  });

  it('reports unknown units', () => {
    const t = makeShell();
    expect(t.run('systemctl status nope')).toMatchObject({ err: 'Unit nope.service could not be found.\n', code: 4 });
    expect(t.run('sudo systemctl start nope')).toMatchObject({ err: 'Failed to start nope.service: Unit nope.service not found.\n', code: 5 });
  });

  it('starts, enables and serves a custom unit', () => {
    const t = demo();
    expect(t.run('systemctl is-enabled demo')).toMatchObject({ out: 'disabled\n', code: 1 });
    const r = t.run('sudo systemctl enable --now demo');
    expect(r.out).toBe('Created symlink /etc/systemd/system/multi-user.target.wants/demo.service → /etc/systemd/system/demo.service.\n');
    expect(t.run('systemctl is-active demo').out).toBe('active\n');
    expect(t.run('systemctl is-enabled demo').out).toBe('enabled\n');
    expect(t.run('curl -s localhost:8080').out).toBe('demo ok\n');
    expect(t.run('systemctl status demo').out).toContain('demo listening on :8080');
    expect(t.run('sudo ss -tlnp').out).toMatch(/0\.0\.0\.0:8080 .*users:\(\("demo",pid=\d+,fd=3\)\)/);
    expect(t.run('sudo systemctl disable demo').out).toBe('Removed "/etc/systemd/system/multi-user.target.wants/demo.service".\n');
    t.setup('sudo systemctl stop demo');
    expect(t.run('curl -s localhost:8080').code).toBe(7);
  });

  it('start succeeds even when the program crashes right away (Type=simple)', () => {
    const t = demo(UNIT.replace('Restart=on-failure', 'Restart=no'), { requireEnv: ['DATABASE_URL'] });
    expect(t.run('sudo systemctl start demo')).toMatchObject({ out: '', err: '', code: 0 });
    const s = t.run('systemctl status demo');
    expect(s.code).toBe(3);
    expect(s.out).toMatch(/^× demo\.service - Demo app/);
    expect(s.out).toContain('Active: failed (Result: exit-code)');
    expect(s.out).toContain('Error: environment variable DATABASE_URL is required but not set');
    expect(t.run('systemctl is-failed demo')).toMatchObject({ out: 'failed\n', code: 0 });
    expect(t.run('journalctl -u demo').out).not.toContain('Failed to start'); // no restart policy, no give-up message
  });

  it('restart loops end with "Start request repeated too quickly"', () => {
    const t = demo(UNIT.replace('/opt/demo/demo', '/opt/demo/dmeo'));
    t.setup('sudo systemctl start demo');
    const j = t.run('journalctl -u demo').out;
    expect(j).toContain("Unable to locate executable '/opt/demo/dmeo': No such file or directory");
    expect(j).toContain('Main process exited, code=exited, status=203/EXEC');
    expect(j).toContain('Scheduled restart job, restart counter is at 4.');
    expect(j).toContain('demo.service: Start request repeated too quickly.');
    expect(j).toContain('Failed to start demo.service - Demo app.');
  });

  it('reports a non-executable binary as 203/EXEC Permission denied', () => {
    const t = demo(UNIT.replace('Restart=on-failure', 'Restart=no'));
    t.setup('sudo chmod 644 /opt/demo/demo', 'sudo systemctl start demo');
    expect(t.run('journalctl -u demo').out).toContain('Failed to execute /opt/demo/demo: Permission denied');
  });

  it('keeps using the old unit until daemon-reload', () => {
    const t = demo();
    t.setup('sudo systemctl start demo');
    t.setup("sudo sed -i 's/PORT=8080/PORT=9090/' /etc/systemd/system/demo.service");
    const r = t.run('sudo systemctl restart demo');
    expect(r.err).toMatch(/^Warning: The unit file, source configuration file or drop-ins of demo\.service changed on disk\. Run 'systemctl daemon-reload' to reload units\.\n$/);
    expect(t.run('curl -s localhost:8080').out).toBe('demo ok\n');
    t.setup('sudo systemctl daemon-reload', 'sudo systemctl restart demo');
    expect(t.run('curl -s localhost:9090').out).toBe('demo ok\n');
    expect(t.run('systemctl cat demo').out).toContain('Environment=PORT=9090');
  });

  it('fails to bind a port that is already taken', () => {
    const t = demo(UNIT.replace('Restart=on-failure', 'Restart=no'));
    t.state.processes.push({ pid: 3000, ppid: 1, user: 'root', command: 'nginx', tty: '?', stat: 'S', cpu: 0, mem: 0, vsz: 1, rss: 1, start: '09:00', time: '0:00', ports: [8080] });
    t.setup('sudo systemctl start demo');
    expect(t.run('journalctl -u demo -n 3').out).toContain('Error: listen tcp :8080: bind: address already in use');
  });

  it('reads EnvironmentFile= (and fails when it is missing)', () => {
    const unit = UNIT.replace('Environment=PORT=8080 "GREETING=hello world"', 'EnvironmentFile=/etc/demo.env').replace('Restart=on-failure', 'Restart=no');
    const t = demo(unit);
    t.setup('sudo systemctl start demo');
    expect(t.run('journalctl -u demo').out).toContain('Failed to load environment files: No such file or directory');
    t.setup('echo PORT=7000 | sudo tee /etc/demo.env', 'sudo systemctl start demo');
    expect(t.run('curl -s localhost:7000').out).toBe('demo ok\n');
  });

  it('explains when systemd is not available (containers)', () => {
    const t = makeShell();
    t.setup('docker run -d --name web nginx');
    t.shell.run('docker exec -it web bash');
    const r = t.run('systemctl status');
    expect(r.err).toMatch(/System has not been booted with systemd/);
  });
});

describe('journalctl', () => {
  it('filters by unit and line count', () => {
    const t = makeShell();
    t.setup('sudo systemctl restart cron');
    const all = t.run('journalctl -u cron').out.trim().split('\n');
    expect(all.every((l) => /^Nov 03 \d\d:\d\d:\d\d devquest \S+\[\d+\]: /.test(l))).toBe(true);
    expect(t.run('journalctl -u cron -n 2').out.trim().split('\n')).toEqual(all.slice(-2));
    expect(t.run('journalctl -n1 -u cron').out.trim().split('\n')).toEqual(all.slice(-1));
    expect(t.run('journalctl -xeu cron').code).toBe(0);
  });

  it('says when there is nothing to show', () => {
    const t = makeShell();
    expect(t.run('journalctl -u nothing').out).toBe('-- No entries --\n');
  });
});
