import { describe, expect, it } from 'vitest';
import { makeShell } from '../../testing';

describe('sudo', () => {
  it('runs a command as root', () => {
    const t = makeShell();
    expect(t.run('sudo whoami').out).toBe('root\n');
    expect(t.run('sudo id -un').out).toBe('root\n');
    expect(t.run('sudo -u www-data whoami').out).toBe('www-data\n');
    expect(t.run('whoami').out).toBe('student\n'); // back to normal afterwards
  });

  it('can write where the user cannot', () => {
    const t = makeShell();
    expect(t.run('touch /etc/app.conf').code).toBe(1);
    t.setup('sudo touch /etc/app.conf', 'sudo mkdir -p /opt/app');
    expect(t.run('ls -ld /opt/app').out).toMatch(/^drwxr-xr-x 2 root root /);
  });

  it('changes made through sudo persist (processes, PIDs, services)', () => {
    const t = makeShell();
    t.state.processes.push({ pid: 3000, ppid: 1, user: 'root', command: 'stuck-daemon', tty: '?', stat: 'S', cpu: 0, mem: 0, vsz: 1, rss: 1, start: '09:00', time: '0:00' });
    expect(t.run('kill 3000').code).toBe(1);
    t.setup('sudo kill 3000');
    expect(t.state.processes.some((p) => p.pid === 3000)).toBe(false);
    const before = t.state.nextPid;
    t.setup('sudo systemctl restart cron');
    expect(t.state.nextPid).toBeGreaterThan(before);
  });

  it('passes stdin through and keeps the redirect on the caller side', () => {
    const t = makeShell();
    expect(t.run('echo hi | sudo tee /etc/greeting').out).toBe('hi\n');
    // The redirect is done by the user's shell, not by sudo — the classic gotcha.
    expect(t.run('sudo echo x > /etc/nope')).toMatchObject({ err: 'bash: /etc/nope: Permission denied\n', code: 1 });
  });

  it('refuses users outside the sudo group and unknown users', () => {
    const t = makeShell({ user: 'www-data' });
    expect(t.run('sudo whoami')).toMatchObject({ err: 'www-data is not in the sudoers file.\n', code: 1 });
    const s = makeShell();
    expect(s.run('sudo -u ghost id').err).toMatch(/^sudo: unknown user ghost\n/);
  });

  it('explains builtins and usage errors', () => {
    const t = makeShell();
    expect(t.run('sudo cd /root')).toMatchObject({ err: 'sudo: cd: command not found\n', code: 1 });
    expect(t.run('sudo').err).toMatch(/^usage: sudo/);
    expect(t.run('sudo nosuchcmd').code).toBe(127);
  });

  it('sudo -i opens a root shell until exit', () => {
    const t = makeShell();
    t.setup('sudo -i');
    expect(t.run('whoami').out).toBe('root\n');
    expect(t.run('pwd').out).toBe('/root\n');
    t.setup('touch /root/made-by-root', 'exit');
    expect(t.run('whoami').out).toBe('student\n');
    expect(t.run('sudo ls /root').out).toBe('made-by-root\n');
  });

  it('is missing inside containers', () => {
    const t = makeShell();
    t.setup('docker run -d --name web nginx');
    t.shell.run('docker exec -it web bash');
    expect(t.run('sudo ls')).toMatchObject({ err: 'bash: sudo: command not found\n', code: 127 });
  });
});
