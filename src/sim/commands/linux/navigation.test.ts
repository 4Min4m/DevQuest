import { describe, expect, it } from 'vitest';
import { makeShell } from '../../testing';

describe('pwd / cd', () => {
  it('starts in home', () => {
    expect(makeShell().run('pwd').out).toBe('/home/student\n');
  });

  it('changes directory with relative, absolute, .., ~ and -', () => {
    const t = makeShell();
    t.run('cd projects');
    expect(t.run('pwd').out).toBe('/home/student/projects\n');
    t.run('cd ..');
    expect(t.run('pwd').out).toBe('/home/student\n');
    t.run('cd /var/log');
    expect(t.run('cd -').out).toBe('/home/student\n');
    expect(t.run('cd -').out).toBe('/var/log\n');
    t.run('cd');
    expect(t.run('pwd').out).toBe('/home/student\n');
    t.run('cd ~/projects');
    expect(t.run('echo $PWD $OLDPWD').out).toBe('/home/student/projects /home/student\n');
  });

  it('reports errors like bash', () => {
    const t = makeShell();
    expect(t.run('cd nope')).toEqual({ out: '', err: 'bash: cd: nope: No such file or directory\n', code: 1 });
    expect(t.run('cd notes.txt').err).toBe('bash: cd: notes.txt: Not a directory\n');
    expect(t.run('cd /root').err).toBe('bash: cd: /root: Permission denied\n');
    expect(t.run('cd a b').err).toBe('bash: cd: too many arguments\n');
    expect(t.run('pwd').out).toBe('/home/student\n');
  });

  it('cd - without OLDPWD fails', () => {
    expect(makeShell().run('cd -')).toMatchObject({ err: 'bash: cd: OLDPWD not set\n', code: 1 });
  });
});

describe('ls', () => {
  it('lists the current directory (grid on a terminal, one per line in a pipe)', () => {
    const t = makeShell();
    t.setup('touch b a');
    expect(t.run('ls').out).toBe('a  b  notes.txt  projects\n');
    expect(t.run('ls | cat').out).toBe('a\nb\nnotes.txt\nprojects\n');
    expect(t.run('ls -1').out).toBe('a\nb\nnotes.txt\nprojects\n');
  });

  it('wraps long listings into columns', () => {
    const t = makeShell();
    const names = Array.from({ length: 12 }, (_, i) => `file-number-${String(i).padStart(2, '0')}`);
    t.setup('mkdir many', `cd many`, `touch ${names.join(' ')}`);
    const lines = t.run('ls').out.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length <= 80)).toBe(true);
    expect(lines[0].startsWith('file-number-00  ')).toBe(true);
  });

  it('hides dotfiles unless -a / -A', () => {
    const t = makeShell();
    t.setup('touch .env');
    expect(t.run('ls').out).not.toContain('.env');
    expect(t.run('ls -A').out).toBe('.env  .gitconfig  notes.txt  projects\n');
    expect(t.run('ls -a').out).toBe('.  ..  .env  .gitconfig  notes.txt  projects\n');
  });

  it('long format', () => {
    const t = makeShell();
    t.setup('echo hello > hi.txt', 'chmod 600 hi.txt');
    expect(t.run('ls -l').out).toBe(
      'total 12\n' +
        '-rw------- 1 student student    6 Nov  3 09:00 hi.txt\n' +
        '-rw-r--r-- 1 student student   65 Nov  3 09:00 notes.txt\n' +
        'drwxr-xr-x 2 student student 4096 Nov  3 09:00 projects\n',
    );
  });

  it('long format aligns columns and supports -h', () => {
    const t = makeShell();
    const out = t.run('ls -lh /').out.split('\n');
    expect(out[0]).toMatch(/^total /);
    expect(out).toContain('drwxrwxrwt 2 root root 4.0K Nov  3 09:00 tmp');
    expect(out).toContain('drwx------ 2 root root 4.0K Nov  3 09:00 root');
  });

  it('shows the year for old files', () => {
    const t = makeShell();
    t.vfs().stat('/home/student/notes.txt').mtime = Date.UTC(2020, 0, 1);
    expect(t.run('ls -l notes.txt').out).toBe('-rw-r--r-- 1 student student 65 Jan  1  2020 notes.txt\n');
  });

  it('lists files, directories and multiple operands', () => {
    const t = makeShell();
    t.setup('touch projects/app.py');
    expect(t.run('ls notes.txt').out).toBe('notes.txt\n');
    expect(t.run('ls -d projects').out).toBe('projects\n');
    expect(t.run('ls projects /tmp notes.txt').out).toBe('notes.txt\n\n/tmp:\n\nprojects:\napp.py\n');
  });

  it('recurses with -R', () => {
    const t = makeShell();
    t.setup('mkdir -p r/a/b', 'touch r/a/b/f r/top');
    expect(t.run('ls -R r').out).toBe('r:\na  top\n\nr/a:\nb\n\nr/a/b:\nf\n');
  });

  it('sorts by time (-t), size (-S) and reverses (-r)', () => {
    const t = makeShell();
    t.setup('mkdir s', 'cd s', 'echo 1 > old', 'echo 1234567 > big', 'echo 12 > new');
    expect(t.run('ls -t').out).toBe('new  big  old\n');
    expect(t.run('ls -S').out).toBe('big  new  old\n');
    expect(t.run('ls -r').out).toBe('old  new  big\n');
  });

  it('errors: missing paths exit 2, unreadable dirs, invalid options', () => {
    const t = makeShell();
    expect(t.run('ls nope')).toEqual({ out: '', err: "ls: cannot access 'nope': No such file or directory\n", code: 2 });
    const r = t.run('ls nope notes.txt');
    expect(r.out).toBe('notes.txt\n');
    expect(r.code).toBe(2);
    expect(t.run('ls /root')).toMatchObject({ err: "ls: cannot open directory '/root': Permission denied\n", code: 2 });
    const bad = t.run('ls -Z');
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/^ls: invalid option -- 'Z'\nTry 'ls --help' for more information.\n\(devquest supports: -a -A -l/);
  });

  it('--help lists supported options', () => {
    const r = makeShell().run('ls --help');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Options supported in devquest: .*-l/);
  });
});
