import { describe, expect, it } from 'vitest';
import { makeShell } from '../../testing';

describe('uptime / nproc', () => {
  it('prints uptime and load averages', () => {
    const t = makeShell();
    expect(t.run('uptime').out).toMatch(/^ \d\d:\d\d:\d\d up 10 days,  2:13,  1 user,  load average: 0\.15, 0\.10, 0\.05\n$/);
    expect(t.run('uptime -p').out).toBe('up 1 week, 3 days, 2 hours, 13 minutes\n');
    expect(t.run('uptime -z').code).toBe(1);
    expect(t.run('nproc').out).toBe('2\n');
  });

  it('/proc mirrors the same numbers', () => {
    const t = makeShell();
    expect(t.run('cat /proc/loadavg').out).toMatch(/^0\.15 0\.10 0\.05 /);
    expect(t.run('grep MemAvailable /proc/meminfo').out).toMatch(/^MemAvailable: +\d+ kB\n$/);
    expect(t.run('grep -c processor /proc/cpuinfo').out).toBe('2\n');
  });
});

describe('free', () => {
  it('prints KiB by default and human sizes with -h', () => {
    const t = makeShell();
    const r = t.run('free');
    expect(r.out).toMatch(/^ +total +used +free +shared +buff\/cache +available\nMem: +4028488 +812344 +1293032 +1200 +1923112 +\d+\nSwap: +2097148 +0 +2097148\n$/);
    expect(t.run('free -h').out).toMatch(/Mem: +3\.8Gi +793Mi +1\.2Gi/);
    expect(t.run('free -h').out).toMatch(/Swap: +2\.0Gi +0B +2\.0Gi/);
    expect(t.run('free -m').out).toMatch(/Mem: +3934 +793 /);
    expect(t.run('free -x').code).toBe(1);
  });

  it('available is much larger than free (cache is reclaimable)', () => {
    const t = makeShell();
    const [, , , free, , , avail] = t.run('free').out.split('\n')[1].split(/\s+/).map(Number);
    expect(avail).toBeGreaterThan(free * 2);
  });
});

describe('top / vmstat', () => {
  it('prints one snapshot sorted by CPU, or by memory with -o %MEM', () => {
    const t = makeShell();
    t.state.processes.push(
      { pid: 2000, ppid: 1, user: 'student', command: 'python3 hog.py', tty: '?', stat: 'R', cpu: 97.5, mem: 1.0, vsz: 30000, rss: 9000, start: '09:00', time: '12:00' },
      { pid: 2001, ppid: 1, user: 'student', command: 'java -jar big.jar', tty: '?', stat: 'S', cpu: 3.0, mem: 60.2, vsz: 3000000, rss: 2400000, start: '09:00', time: '1:00' },
    );
    const r = t.shell.run('top');
    const out = r.output.filter((c) => c.stream === 'stdout').map((c) => c.text).join('');
    expect(out).toMatch(/^top - \d\d:\d\d:\d\d up 10 days,  2:13,  1 user,  load average: 0\.15, 0\.10, 0\.05\nTasks: +7 total/);
    expect(out).toContain('%Cpu(s):');
    expect(out).toContain('MiB Mem :   3934.1 total,');
    const firstProc = (text: string) => text.split('COMMAND\n')[1].split('\n')[0];
    expect(firstProc(out)).toMatch(/^ +2000 student .* python3$/);
    expect(firstProc(t.run('top -o %MEM').out)).toMatch(/^ +2001 student .* java$/);
    expect(r.output.some((c) => c.note)).toBe(true);
    expect(t.run('top -bn1').code).toBe(0);
    expect(t.run('top -z').code).toBe(1);
  });

  it('vmstat prints the requested number of samples', () => {
    const t = makeShell();
    const lines = t.run('vmstat 1 3').out.trim().split('\n');
    expect(lines[0]).toMatch(/^procs -+memory-+ ---swap-- -----io---- -system-- ------cpu-----$/);
    expect(lines[1]).toBe(' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st');
    expect(lines).toHaveLength(5);
    expect(t.run('vmstat x').code).toBe(1);
  });
});

describe('pgrep', () => {
  it('finds processes by name or full command', () => {
    const t = makeShell();
    expect(t.run('pgrep sshd')).toMatchObject({ out: '655\n', code: 0 });
    expect(t.run('pgrep -a cron').out).toBe('412 /usr/sbin/cron -f\n');
    expect(t.run('pgrep -l cron').out).toBe('412 cron\n');
    expect(t.run('pgrep -f "cron -f"').out).toBe('412\n');
    expect(t.run('pgrep -u student bash').out).toBe('1001\n');
    expect(t.run('pgrep nothing')).toMatchObject({ out: '', code: 1 });
    expect(t.run('pgrep').code).toBe(2);
  });
});

describe('ulimit', () => {
  it('shows and lowers the open-files limit', () => {
    const t = makeShell();
    expect(t.run('ulimit -n').out).toBe('1024\n');
    expect(t.run('ulimit -Hn').out).toBe('1048576\n');
    expect(t.run('ulimit -a').out).toContain('open files                          (-n) 1024');
    t.setup('ulimit -n 4096');
    // Without -S/-H bash sets both limits, so the hard limit dropped too.
    expect(t.run('ulimit -n; ulimit -Hn').out).toBe('4096\n4096\n');
    expect(t.run('ulimit -n 8192')).toMatchObject({ err: 'bash: ulimit: open files: cannot modify limit: Operation not permitted\n', code: 1 });
    expect(t.run('ulimit -n lots')).toMatchObject({ err: 'bash: ulimit: lots: invalid number\n', code: 1 });
  });

  it('a soft limit can go up to the hard limit', () => {
    const t = makeShell();
    t.setup('ulimit -Sn 65536');
    expect(t.run('ulimit -n; ulimit -Hn').out).toBe('65536\n1048576\n');
    expect(t.run('ulimit -Sn 2000000').code).toBe(1);
  });

  it('is a builtin, so sudo cannot run it', () => {
    const t = makeShell();
    expect(t.run('sudo ulimit -n 100000')).toMatchObject({ err: 'sudo: ulimit: command not found\n', code: 1 });
  });
});
