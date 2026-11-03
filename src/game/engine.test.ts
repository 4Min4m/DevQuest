import { describe, expect, it } from 'vitest';
import { createShell } from '../sim';
import { buildInitialState } from './initialState';
import { MissionSession } from './session';
import type { Check, Mission } from './types';
import { describe as describeCheck, runCheck, validate } from './validators';

function stateWith(lines: string[], spec = {}) {
  const shell = createShell(buildInitialState(spec));
  const outputs = lines.map((l) => shell.run(l).output.filter((c) => c.stream === 'stdout').map((c) => c.text).join(''));
  return { state: shell.state, outputs };
}

const pass = (check: Check, ctx: ReturnType<typeof stateWith>) => runCheck(check, ctx).passed;

describe('buildInitialState', () => {
  it('creates files with parents, modes and sensible owners', () => {
    const s = buildInitialState({
      files: {
        '/home/student/a/b/c.txt': 'hi\n',
        '/opt/app/run.sh': { content: '#!/bin/sh\n', mode: '750', owner: 'www-data' },
        '/home/student/empty': { type: 'dir', mode: '700' },
      },
    });
    const shell = createShell(s);
    expect(shell.run('cat a/b/c.txt').output[0].text).toBe('hi\n');
    expect(shell.run('ls -ld a /opt/app/run.sh empty').output[0].text).toMatch(
      // ls sorts operands in byte order, so '/opt/...' comes first.
      /^-rwxr-x--- 1 www-data www-data .*\/opt\/app\/run.sh\ndrwxr-xr-x 3 student +student .* a\ndrwx------ 2 student +student .* empty\n$/,
    );
  });

  it('removes paths, sets env, user, cwd and processes', () => {
    const s = buildInitialState({
      remove: ['/home/student/notes.txt'],
      env: { APP_ENV: 'staging' },
      cwd: '/tmp',
      processes: [{ pid: 7000, command: 'nginx: master process' }],
    });
    expect(s.cwd).toBe('/tmp');
    expect(s.vars.PWD).toBe('/tmp');
    expect(s.exported).toContain('APP_ENV');
    expect(s.processes.find((p) => p.pid === 7000)).toMatchObject({ user: 'student', ppid: 1 });
    expect(s.nextPid).toBe(7001);
    const shell = createShell(s);
    expect(shell.run('ls ~').output[0].text).toBe('projects\n');
    expect(buildInitialState({ user: 'root' }).cwd).toBe('/root');
  });

  it('rejects impossible specs', () => {
    expect(() => buildInitialState({ user: 'nobody' })).toThrow(/unknown user/);
    expect(() => buildInitialState({ cwd: '/root' })).toThrow(/not an accessible directory/);
  });
});

describe('checks', () => {
  it('file checks', () => {
    const ctx = stateWith(['mkdir d', 'echo hello > d/f', 'chmod 600 d/f']);
    expect(pass({ type: 'fileExists', path: '/home/student/d', kind: 'dir' }, ctx)).toBe(true);
    expect(pass({ type: 'fileExists', path: '/home/student/d', kind: 'file' }, ctx)).toBe(false);
    expect(pass({ type: 'fileMissing', path: '/home/student/nope' }, ctx)).toBe(true);
    expect(pass({ type: 'fileContains', path: '/home/student/d/f', text: 'ell' }, ctx)).toBe(true);
    expect(pass({ type: 'fileContains', path: '/home/student/d/f', equals: 'hello\n' }, ctx)).toBe(true);
    expect(pass({ type: 'fileContains', path: '/home/student/d/f', regex: '^h\\w+\\s*$' }, ctx)).toBe(true);
    expect(pass({ type: 'fileContains', path: '/home/student/d', text: 'x' }, ctx)).toBe(false);
    expect(pass({ type: 'fileMode', path: '/home/student/d/f', mode: '600' }, ctx)).toBe(true);
    expect(pass({ type: 'fileOwner', path: '/home/student/d/f', owner: 'student', group: 'student' }, ctx)).toBe(true);
    expect(pass({ type: 'fileOwner', path: '/etc/hostname', owner: 'student' }, ctx)).toBe(false);
  });

  it('validators see files the learner cannot read', () => {
    const ctx = stateWith([]);
    expect(pass({ type: 'fileContains', path: '/var/log/syslog', text: 'sshd' }, ctx)).toBe(true);
  });

  it('shell state checks', () => {
    const ctx = stateWith(['cd /tmp', 'export MODE=prod', 'LOCAL=1', 'ls nope', 'grep -c root /etc/passwd']);
    expect(pass({ type: 'cwd', path: '/tmp/' }, ctx)).toBe(true);
    expect(pass({ type: 'varEquals', name: 'MODE', value: 'prod', exported: true }, ctx)).toBe(true);
    expect(pass({ type: 'varEquals', name: 'LOCAL', value: '1', exported: true }, ctx)).toBe(false);
    expect(pass({ type: 'varEquals', name: 'LOCAL', value: '1' }, ctx)).toBe(true);
    expect(pass({ type: 'commandUsed', command: 'grep', argsInclude: ['-c'] }, ctx)).toBe(true);
    expect(pass({ type: 'commandUsed', command: 'ls', succeeded: true }, ctx)).toBe(false);
    expect(pass({ type: 'commandUsed', command: 'ls' }, ctx)).toBe(true);
    expect(pass({ type: 'outputContains', text: '1' }, ctx)).toBe(true);
    expect(pass({ type: 'outputContains', regex: '^\\d+\\n$' }, ctx)).toBe(true);
  });

  it('process checks', () => {
    const ctx = stateWith(['kill 9000'], { processes: [{ pid: 9000, command: 'sleep 1000' }, { pid: 9001, command: 'cron' }] });
    expect(pass({ type: 'processAbsent', match: 'sleep' }, ctx)).toBe(true);
    expect(pass({ type: 'processRunning', match: 'cron' }, ctx)).toBe(true);
  });

  it('anyOf / not combinators', () => {
    const ctx = stateWith([]);
    const yes: Check = { type: 'cwd', path: '/home/student' };
    const no: Check = { type: 'cwd', path: '/' };
    expect(pass({ type: 'anyOf', checks: [no, yes] }, ctx)).toBe(true);
    expect(pass({ type: 'anyOf', checks: [no, no] }, ctx)).toBe(false);
    expect(pass({ type: 'not', check: no }, ctx)).toBe(true);
  });

  it('uses custom messages, otherwise describes the goal', () => {
    const ctx = stateWith([]);
    expect(runCheck({ type: 'fileMode', path: '/x', mode: '600', message: 'Lock it' }, ctx).message).toBe('Lock it');
    expect(describeCheck({ type: 'fileMode', path: '/x', mode: '600' })).toBe('`/x` should have mode 600');
    expect(describeCheck({ type: 'fileExists', path: '/d', kind: 'dir' })).toBe('`/d` should exist as a directory');
    expect(validate({ checks: [{ type: 'cwd', path: '/' }] }, ctx)).toMatchObject({ passed: false });
  });
});

describe('MissionSession', () => {
  const mission: Mission = {
    id: 'm',
    title: 'Make a dir',
    type: 'guided',
    prompt: 'mkdir ~/x without touching notes',
    hints: [
      { text: 'use mkdir', cost: 5 },
      { text: 'mkdir x', cost: 10 },
    ],
    validator: {
      checks: [{ type: 'fileExists', path: '/home/student/x', kind: 'dir' }],
      guards: [{ type: 'fileExists', path: '/home/student/notes.txt', message: 'keep notes' }],
    },
    xp: 20,
    par: 1,
    solution: ['mkdir x'],
  };

  it('counts commands and passes automatically', () => {
    const s = new MissionSession(mission);
    expect(s.run('ls').events).toEqual([]);
    s.run('   ');
    const { events } = s.run('mkdir x');
    expect(events).toEqual([{ type: 'passed' }]);
    expect(s.status).toBe('passed');
    expect(s.stats).toMatchObject({ commands: 2, par: 1, hintsUsed: 0, failedChecks: 0, mistakes: 0 });
    s.run('ls');
    expect(s.stats.commands).toBe(2); // commands after success don't count
  });

  it('reveals hints progressively and totals their cost', () => {
    const s = new MissionSession(mission);
    expect(s.revealHint()?.text).toBe('use mkdir');
    expect(s.revealHint()?.text).toBe('mkdir x');
    expect(s.revealHint()).toBeUndefined();
    expect(s.hasMoreHints).toBe(false);
    expect(s.stats).toMatchObject({ hintsUsed: 2, hintXpCost: 15 });
  });

  it('counts failed manual checks', () => {
    const s = new MissionSession(mission);
    const v = s.check();
    expect(v.passed).toBe(false);
    expect(v.results[0].message).toBe('`/home/student/x` should exist as a directory');
    expect(s.stats.failedChecks).toBe(1);
  });

  it('reports a broken guard once as a mistake', () => {
    const s = new MissionSession(mission);
    const { events } = s.run('rm notes.txt');
    expect(events).toEqual([{ type: 'guardBroken', result: expect.objectContaining({ message: 'keep notes' }) }]);
    expect(s.run('ls').events).toEqual([]);
    expect(s.stats.mistakes).toBe(1);
  });

  it('a broken guard blocks success', () => {
    const s = new MissionSession(mission);
    s.run('rm notes.txt');
    expect(s.run('mkdir x').events).toEqual([]);
    expect(s.status).toBe('active');
    const v = s.check();
    expect(v.passed).toBe(false);
    expect(v.results.map((r) => [r.passed, r.message])).toEqual([
      [true, '`/home/student/x` should exist as a directory'],
      [false, 'keep notes'],
    ]);
  });

  it('each session gets a fresh machine', () => {
    const a = new MissionSession(mission);
    a.run('mkdir x');
    const b = new MissionSession(mission);
    expect(b.run('ls x').result.exitCode).toBe(2);
  });
});

describe('host validators and initial state (services, DNS, disks)', () => {
  const svc = {
    files: {
      '/opt/w/w': { content: 'bin\n', mode: '755' },
      '/etc/systemd/system/w.service': '[Service]\nExecStart=/opt/w/w\n[Install]\nWantedBy=multi-user.target\n',
    },
    binaries: { '/opt/w/w': { listen: 8088, http: { '/': { body: 'w ok\n' } } } },
  };

  it('serviceActive / serviceEnabled follow systemctl', () => {
    const before = stateWith([], svc);
    expect(pass({ type: 'serviceActive', unit: 'w' }, before)).toBe(false);
    expect(pass({ type: 'serviceActive', unit: 'w', state: 'inactive' }, before)).toBe(true);
    expect(pass({ type: 'serviceEnabled', unit: 'w' }, before)).toBe(false);
    const after = stateWith(['sudo systemctl enable --now w'], svc);
    expect(pass({ type: 'serviceActive', unit: 'w.service' }, after)).toBe(true);
    expect(pass({ type: 'serviceEnabled', unit: 'w' }, after)).toBe(true);
    expect(pass({ type: 'httpResponds', url: 'http://localhost:8088', contains: 'w ok' }, after)).toBe(true);
    expect(describeCheck({ type: 'serviceEnabled', unit: 'w' })).toBe('`w.service` should be enabled at boot');
  });

  it('serviceActive can expect a failed unit', () => {
    const spec = { ...svc, binaries: { '/opt/w/w': { requireEnv: ['X'] } } };
    const ctx = stateWith(['sudo systemctl start w'], spec);
    expect(pass({ type: 'serviceActive', unit: 'w', state: 'failed' }, ctx)).toBe(true);
  });

  it('applies DNS records, remote hosts and perf figures', () => {
    const ctx = stateWith(['dig +short db.test', 'curl -s http://db.test/', 'uptime'], {
      dns: [{ name: 'db.test', type: 'A', value: '10.1.2.3', ttl: 60 }],
      remotes: [{ ip: '10.1.2.3', up: true, latency: 1, services: { 80: { kind: 'http', body: 'remote!\n' } } }],
      perf: { load: [9.5, 8, 7] },
    });
    expect(ctx.outputs).toEqual(['10.1.2.3\n', 'remote!\n', expect.stringContaining('load average: 9.50, 8.00, 7.00')]);
  });

  it('diskUsageBelow / inodeUsageBelow, big files and bulk files', () => {
    const full = stateWith([], { files: { '/var/log/big.log': { content: 'x\n', size: 15 * 1024 ** 3 } } });
    expect(pass({ type: 'diskUsageBelow', mount: '/', percent: 90 }, full)).toBe(false);
    expect(pass({ type: 'diskUsageBelow', mount: '/var/log', percent: 95 }, full)).toBe(false); // same filesystem as /
    const freed = stateWith(['sudo rm /var/log/big.log'], { files: { '/var/log/big.log': { content: 'x\n', size: 15 * 1024 ** 3 } } });
    expect(pass({ type: 'diskUsageBelow', mount: '/', percent: 90 }, freed)).toBe(true);

    const spec = {
      disks: [{ mount: '/srv', filesystem: '/dev/sdc1', size: 1024, used: 0, inodes: 100, inodesUsed: 0 }],
      bulkFiles: [{ dir: '/srv/cache', prefix: 'c_', count: 95, owner: 'student' }],
    };
    const inodes = stateWith(['df -i /srv'], spec);
    expect(inodes.outputs[0]).toMatch(/\/dev\/sdc1 +100 +97 +3 +97% \/srv\n$/);
    expect(pass({ type: 'inodeUsageBelow', mount: '/srv', percent: 50 }, inodes)).toBe(false);
    const cleaned = stateWith(["sudo find /srv/cache -name 'c_*' -delete"], spec);
    expect(pass({ type: 'inodeUsageBelow', mount: '/srv', percent: 50 }, cleaned)).toBe(true);
  });
});
