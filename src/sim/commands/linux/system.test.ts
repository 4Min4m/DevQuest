import { describe, expect, it } from 'vitest';
import { makeShell } from '../../testing';

describe('whoami / id', () => {
  it('prints the user', () => {
    const t = makeShell();
    expect(t.run('whoami').out).toBe('student\n');
    expect(t.run('whoami x')).toMatchObject({ code: 1 });
    expect(makeShell({ user: 'root' }).run('whoami').out).toBe('root\n');
  });
  it('id formats', () => {
    const t = makeShell();
    expect(t.run('id').out).toBe('uid=1000(student) gid=1000(student) groups=1000(student),27(sudo),999(docker)\n');
    expect(t.run('id -u').out).toBe('1000\n');
    expect(t.run('id -un').out).toBe('student\n');
    expect(t.run('id -Gn').out).toBe('student sudo docker\n');
    expect(t.run('id root').out).toBe('uid=0(root) gid=0(root) groups=0(root)\n');
    expect(t.run('id bob')).toMatchObject({ err: "id: 'bob': no such user\n", code: 1 });
  });
});

describe('env / export / unset', () => {
  it('env shows exported variables sorted', () => {
    const out = makeShell().run('env').out;
    expect(out).toContain('HOME=/home/student\n');
    expect(out).toContain('PATH=/usr/local/bin:/usr/bin:/bin\n');
    expect(out).not.toContain('HOSTNAME='); // shell var, not exported
  });
  it('export makes variables visible to env', () => {
    const t = makeShell();
    t.run('export APP_PORT=8080');
    expect(t.run('env | grep APP_PORT').out).toBe('APP_PORT=8080\n');
    t.run('MODE=dev');
    expect(t.run('env | grep MODE').code).toBe(1);
    t.run('export MODE');
    expect(t.run('env | grep MODE').out).toBe('MODE=dev\n');
    expect(t.run('export -p | grep MODE').out).toBe('declare -x MODE="dev"\n');
    expect(t.run('env EXTRA=1 | grep EXTRA').out).toBe('EXTRA=1\n');
  });
  it('unset removes variables', () => {
    const t = makeShell();
    t.run('export A=1');
    t.run('unset A');
    expect(t.run('echo "[$A]"').out).toBe('[]\n');
    expect(t.run('env | grep -c "^A="').out).toBe('0\n');
  });
  it('errors', () => {
    const t = makeShell();
    expect(t.run('export 1A=2')).toMatchObject({ err: "bash: export: `1A=2': not a valid identifier\n", code: 1 });
    expect(t.run('env ls').code).toBe(125);
  });
});

describe('ps / kill', () => {
  it('ps shows the session processes including itself', () => {
    const out = makeShell().run('ps').out;
    expect(out).toBe('    PID TTY          TIME CMD\n   1001 pts/0    00:00:00 bash\n   1200 pts/0    00:00:00 ps\n');
  });
  it('ps aux / -ef list all processes', () => {
    const t = makeShell();
    const aux = t.run('ps aux').out.split('\n');
    expect(aux[0]).toBe('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND');
    expect(aux[1]).toBe('root           1  0.0  0.1 167000 11800 ?        Ss   08:58   0:01 /sbin/init');
    const ef = t.run('ps -ef').out.split('\n');
    expect(ef[0]).toBe('UID          PID    PPID  C STIME TTY          TIME CMD');
    expect(t.run('ps aux | grep cron').out).toContain('/usr/sbin/cron -f');
    expect(t.run('ps --forest')).toMatchObject({ code: 1 });
  });
  it('kill terminates processes the user owns', () => {
    const t = makeShell();
    t.state.processes.push({ ...t.state.processes[3], pid: 2000, command: 'python3 app.py' });
    t.state.processes.push({ ...t.state.processes[3], pid: 2001, command: 'stubborn', ignoresTerm: true });
    expect(t.run('kill 2000')).toEqual({ out: '', err: '', code: 0 });
    expect(t.state.processes.some((p) => p.pid === 2000)).toBe(false);
    t.run('kill 2001');
    expect(t.state.processes.some((p) => p.pid === 2001)).toBe(true);
    t.run('kill -9 2001');
    expect(t.state.processes.some((p) => p.pid === 2001)).toBe(false);
  });
  it('kill signal syntaxes', () => {
    const t = makeShell();
    for (const pid of [3000, 3001, 3002]) t.state.processes.push({ ...t.state.processes[3], pid, command: 'x' });
    expect(t.run('kill -SIGKILL 3000').code).toBe(0);
    expect(t.run('kill -s TERM 3001').code).toBe(0);
    expect(t.run('kill -STOP 3002').code).toBe(0);
    expect(t.state.processes.find((p) => p.pid === 3002)?.stat).toBe('Ts');
    expect(t.run('kill -l').out).toContain('15) SIGTERM');
  });
  it('kill errors', () => {
    const t = makeShell();
    expect(t.run('kill 999')).toMatchObject({ err: 'bash: kill: (999) - No such process\n', code: 1 });
    expect(t.run('kill 1')).toMatchObject({ err: 'bash: kill: (1) - Operation not permitted\n', code: 1 });
    expect(t.run('kill -FOO 1').err).toBe('bash: kill: FOO: invalid signal specification\n');
    expect(t.run('kill abc').err).toBe('bash: kill: abc: arguments must be process or job IDs\n');
    expect(t.run('kill').code).toBe(2);
    expect(makeShell({ user: 'root' }).run('kill 412').code).toBe(0);
  });
});

describe('df / du', () => {
  it('df prints usage in 1K blocks or human sizes', () => {
    const t = makeShell();
    expect(t.run('df').out).toBe(
      'Filesystem     1K-blocks    Used Available Use% Mounted on\n' +
        '/dev/sda1       20511312 6123520  14387792  30% /\n' +
        'tmpfs            1012848       0   1012848   0% /tmp\n',
    );
    expect(t.run('df -h /').out).toBe('Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        20G  5.9G   14G  30% /\n');
    expect(t.run('df nope')).toMatchObject({ err: 'df: nope: No such file or directory\n', code: 1 });
  });
  it('du sums 4K blocks', () => {
    const t = makeShell();
    t.setup('mkdir -p d/sub', 'echo x > d/a', 'echo y > d/sub/b');
    expect(t.run('du d').out).toBe('8\td/sub\n16\td\n');
    expect(t.run('du -s d').out).toBe('16\td\n');
    expect(t.run('du -sh d').out).toBe('16K\td\n');
    expect(t.run('du -a d').out).toBe('4\td/a\n4\td/sub/b\n8\td/sub\n16\td\n');
    expect(t.run('du -c d d').out.split('\n').at(-2)).toBe('32\ttotal');
    expect(t.run('du -d 0 d').out).toBe('16\td\n');
  });
  it('du errors', () => {
    const t = makeShell();
    expect(t.run('du nope')).toMatchObject({ err: "du: cannot access 'nope': No such file or directory\n", code: 1 });
    expect(t.run('du /root')).toMatchObject({ err: "du: cannot read directory '/root': Permission denied\n", code: 1 });
  });
});

describe('curl (mocked)', () => {
  it('fetches registered endpoints', () => {
    const t = makeShell();
    expect(t.run('curl http://example.com').out).toContain('Example Domain');
    expect(t.run('curl example.com/').code).toBe(0);
    const head = t.run('curl -I http://example.com').out;
    expect(head.startsWith('HTTP/1.1 200 OK\n')).toBe(true);
    expect(head).toContain('Content-Type: text/html; charset=UTF-8');
    expect(t.run('curl -i http://example.com').out).toMatch(/^HTTP\/1.1 200 OK\n[\s\S]*\n\n<!doctype html>/);
  });
  it('writes to a file with -o', () => {
    const t = makeShell();
    t.run('curl -s -o page.html http://example.com');
    expect(t.read('/home/student/page.html')).toContain('Example Domain');
  });
  it('reproduces real connection errors', () => {
    const t = makeShell();
    expect(t.run('curl http://nowhere.test')).toEqual({ out: '', err: 'curl: (6) Could not resolve host: nowhere.test\n', code: 6 });
    expect(t.run('curl localhost:8080')).toMatchObject({
      err: "curl: (7) Failed to connect to localhost port 8080 after 0 ms: Couldn't connect to server\n",
      code: 7,
    });
    expect(t.run('curl -s localhost:8080')).toEqual({ out: '', err: '', code: 7 });
    expect(t.run('curl -sS localhost:8080').err).toContain('(7)');
  });
  it('honours -f for HTTP errors', () => {
    const t = makeShell();
    t.state.network['http://localhost:3000/health'] = { status: 503, body: 'down\n' };
    expect(t.run('curl localhost:3000/health')).toMatchObject({ out: 'down\n', code: 0 });
    expect(t.run('curl -f localhost:3000/health')).toEqual({
      out: '',
      err: 'curl: (22) The requested URL returned error: 503\n',
      code: 22,
    });
  });
  it('unknown options are explained', () => {
    expect(makeShell().run('curl --bogus x')).toMatchObject({ code: 2 });
    expect(makeShell().run('curl')).toMatchObject({ code: 2 });
  });
});

describe('help / history / true / false', () => {
  it('help lists commands', () => {
    const out = makeShell().run('help').out;
    expect(out).toMatch(/\n {2}grep +print lines that match patterns\n/);
  });
  it('history numbers previous lines', () => {
    const t = makeShell();
    t.run('echo a');
    t.run('pwd');
    expect(t.run('history').out).toBe('    1  echo a\n    2  pwd\n    3  history\n');
    expect(t.run('history 1').out).toBe('    4  history 1\n');
    expect(t.run('history x').code).toBe(1);
  });
  it('true/false exit codes', () => {
    const t = makeShell();
    expect(t.run('true').code).toBe(0);
    expect(t.run('false').code).toBe(1);
  });
});

describe('sleep / exit', () => {
  it('sleep advances the simulated clock instantly', () => {
    const t = makeShell();
    const before = t.state.clock;
    expect(t.run('sleep 2m 30')).toEqual({ out: '', err: '', code: 0 });
    expect(t.state.clock - before).toBe(1000 + 150_000);
  });
  it('sleep errors', () => {
    const t = makeShell();
    expect(t.run('sleep')).toMatchObject({ err: "sleep: missing operand\nTry 'sleep --help' for more information.\n", code: 1 });
    expect(t.run('sleep abc').err).toBe("sleep: invalid time interval 'abc'\nTry 'sleep --help' for more information.\n");
    expect(t.run('sleep infinity').err).toMatch(/would never return/);
  });
  it('exit in the main shell explains itself', () => {
    const t = makeShell();
    expect(t.run('exit 3')).toMatchObject({ err: "devquest: this is your main shell — there's nothing to exit to\n", code: 3 });
  });
});

describe('curl flag handling', () => {
  it('accepts combined short flags', () => {
    const t = makeShell();
    expect(t.run('curl -sSf http://nowhere.test')).toEqual({ out: '', err: 'curl: (6) Could not resolve host: nowhere.test\n', code: 6 });
    expect(t.run('curl -sI http://example.com').out).toMatch(/^HTTP\/1.1 200 OK/);
    expect(t.run('curl --help').out).toMatch(/^Usage: curl/);
  });
});

describe('nano / vi / vim', () => {
  it('opens an edit request and saves through the VFS with permissions', () => {
    const t = makeShell();
    const r = t.shell.run('nano notes.txt');
    expect(r.exitCode).toBe(0);
    expect(r.edit).toMatchObject({ display: 'notes.txt', editor: 'nano' });
    expect(r.edit!.content).toContain('Welcome');
    expect(r.edit!.save('changed\n')).toBeNull();
    expect(t.read('/home/student/notes.txt')).toBe('changed\n');
    const fresh = t.shell.run('vim new.txt').edit!;
    expect(fresh.content).toBe('');
    expect(fresh.editor).toBe('vim');
    fresh.save('x');
    expect(t.read('/home/student/new.txt')).toBe('x');
    expect(t.shell.run('nano /etc/hostname').edit!.save('hacked')).toBe('[ Error writing /etc/hostname: Permission denied ]');
  });
  it('errors', () => {
    const t = makeShell();
    expect(t.run('nano')).toMatchObject({ err: 'devquest: usage: nano FILE  (the simple editor opens one file at a time)\n', code: 1 });
    expect(t.run('nano projects').err).toBe('nano: projects: Is a directory\n');
    expect(t.run('nano nodir/x').err).toBe('nano: nodir/x: No such file or directory (parent directory missing)\n');
    expect(t.run('nano /var/log/syslog').err).toBe('nano: /var/log/syslog: Permission denied\n');
  });
  it('containers do not ship editors (except busybox vi)', () => {
    const t = makeShell();
    t.setup('docker pull nginx', 'docker run -d --name web nginx');
    expect(t.run('docker exec web nano /etc/hosts').code).toBe(126);
  });
});
