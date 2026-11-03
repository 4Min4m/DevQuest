import { describe, expect, it } from 'vitest';
import { makeShell } from '../../testing';

describe('echo', () => {
  it('prints arguments joined by spaces', () => {
    const t = makeShell();
    expect(t.run('echo a   b "c  d"').out).toBe('a b c  d\n');
    expect(t.run('echo').out).toBe('\n');
  });
  it('supports -n, -e and literal unknown flags', () => {
    const t = makeShell();
    expect(t.run('echo -n hi').out).toBe('hi');
    expect(t.run('echo -e "a\\tb\\nc"').out).toBe('a\tb\nc\n');
    expect(t.run('echo "a\\nb"').out).toBe('a\\nb\n');
    expect(t.run('echo -x hi').out).toBe('-x hi\n');
    expect(t.run('echo -e "stop\\cnever"').out).toBe('stop');
  });
});

describe('cat', () => {
  it('prints and concatenates files', () => {
    const t = makeShell();
    t.setup('echo one > a', 'echo two > b');
    expect(t.run('cat a b')).toEqual({ out: 'one\ntwo\n', err: '', code: 0 });
  });
  it('numbers lines with -n across files', () => {
    const t = makeShell();
    t.setup('echo one > a', 'echo two > b');
    expect(t.run('cat -n a b').out).toBe('     1\tone\n     2\ttwo\n');
  });
  it('reads stdin with no args or -', () => {
    const t = makeShell();
    expect(t.run('echo piped | cat').out).toBe('piped\n');
    t.setup('echo file > f');
    expect(t.run('echo in | cat f - f').out).toBe('file\nin\nfile\n');
  });
  it('reports errors but keeps going', () => {
    const t = makeShell();
    const r = t.run('cat nope notes.txt /etc /var/log/syslog');
    expect(r.out).toContain('Welcome');
    expect(r.err).toBe(
      'cat: nope: No such file or directory\ncat: /etc: Is a directory\ncat: /var/log/syslog: Permission denied\n',
    );
    expect(r.code).toBe(1);
  });
});

describe('touch', () => {
  it('creates empty files and updates times', () => {
    const t = makeShell();
    expect(t.run('touch a b')).toEqual({ out: '', err: '', code: 0 });
    expect(t.read('/home/student/a')).toBe('');
    const before = t.vfs().stat('/home/student/a').mtime;
    t.run('touch a');
    expect(t.vfs().stat('/home/student/a').mtime).toBeGreaterThan(before);
  });
  it('-c does not create', () => {
    const t = makeShell();
    t.run('touch -c ghost');
    expect(t.vfs().exists('/home/student/ghost')).toBe(false);
  });
  it('errors', () => {
    const t = makeShell();
    expect(t.run('touch')).toMatchObject({ err: "touch: missing file operand\nTry 'touch --help' for more information.\n", code: 1 });
    expect(t.run('touch nodir/x').err).toBe("touch: cannot touch 'nodir/x': No such file or directory\n");
    expect(t.run('touch /etc/x').err).toBe("touch: cannot touch '/etc/x': Permission denied\n");
  });
});

describe('mkdir', () => {
  it('creates directories, -p creates parents, -v reports', () => {
    const t = makeShell();
    expect(t.run('mkdir a b').code).toBe(0);
    expect(t.vfs().isDir('/home/student/b')).toBe(true);
    expect(t.run('mkdir -pv x/y').out).toBe("mkdir: created directory 'x/y'\n");
    expect(t.vfs().isDir('/home/student/x/y')).toBe(true);
    expect(t.run('mkdir -p x/y').code).toBe(0);
  });
  it('errors', () => {
    const t = makeShell();
    expect(t.run('mkdir')).toMatchObject({ err: "mkdir: missing operand\nTry 'mkdir --help' for more information.\n", code: 1 });
    expect(t.run('mkdir projects').err).toBe("mkdir: cannot create directory 'projects': File exists\n");
    expect(t.run('mkdir a/b').err).toBe("mkdir: cannot create directory 'a/b': No such file or directory\n");
    expect(t.run('mkdir /opt').err).toBe("mkdir: cannot create directory '/opt': Permission denied\n");
  });
});

describe('rm', () => {
  it('removes files, -v reports', () => {
    const t = makeShell();
    t.setup('touch a b');
    expect(t.run('rm -v a').out).toBe("removed 'a'\n");
    expect(t.vfs().exists('/home/student/a')).toBe(false);
  });
  it('needs -r for directories', () => {
    const t = makeShell();
    t.setup('mkdir -p d/e', 'touch d/e/f');
    expect(t.run('rm d')).toMatchObject({ err: "rm: cannot remove 'd': Is a directory\n", code: 1 });
    expect(t.run('rm -d d').err).toBe("rm: cannot remove 'd': Directory not empty\n");
    expect(t.run('rm -r d').code).toBe(0);
    expect(t.vfs().exists('/home/student/d')).toBe(false);
    t.setup('mkdir empty');
    expect(t.run('rm -d empty').code).toBe(0);
  });
  it('-f ignores missing files', () => {
    const t = makeShell();
    expect(t.run('rm -f ghost')).toEqual({ out: '', err: '', code: 0 });
    expect(t.run('rm -f')).toEqual({ out: '', err: '', code: 0 });
  });
  it('errors and safety rails', () => {
    const t = makeShell();
    expect(t.run('rm')).toMatchObject({ err: "rm: missing operand\nTry 'rm --help' for more information.\n", code: 1 });
    expect(t.run('rm ghost').err).toBe("rm: cannot remove 'ghost': No such file or directory\n");
    expect(t.run('rm /etc/hostname').err).toBe("rm: cannot remove '/etc/hostname': Permission denied\n");
    expect(t.run('rm -rf .').err).toBe("rm: refusing to remove '.' or '..' directory: skipping '.'\n");
    expect(t.run('rm -rf /').err).toBe(
      "rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n",
    );
  });
});

describe('cp', () => {
  it('copies a file to a new name or into a directory', () => {
    const t = makeShell();
    expect(t.run('cp notes.txt copy.txt').code).toBe(0);
    expect(t.read('/home/student/copy.txt')).toContain('Welcome');
    expect(t.run('cp -v notes.txt projects').out).toBe("'notes.txt' -> 'projects/notes.txt'\n");
    expect(t.vfs().exists('/home/student/projects/notes.txt')).toBe(true);
  });
  it('copies multiple files into a directory', () => {
    const t = makeShell();
    t.setup('touch a b', 'cp a b projects/');
    expect(t.run('ls projects').out).toBe('a  b\n');
  });
  it('preserves the source mode for new files', () => {
    const t = makeShell();
    t.setup('touch s.sh', 'chmod 755 s.sh', 'cp s.sh t.sh');
    expect(t.vfs().stat('/home/student/t.sh').mode).toBe(0o755);
  });
  it('copies directories recursively with -r', () => {
    const t = makeShell();
    t.setup('mkdir -p src/lib', 'echo x > src/lib/f');
    expect(t.run('cp src dst')).toMatchObject({ err: "cp: -r not specified; omitting directory 'src'\n", code: 1 });
    expect(t.run('cp -r src dst').code).toBe(0);
    expect(t.read('/home/student/dst/lib/f')).toBe('x\n');
    t.run('cp -r src dst');
    expect(t.read('/home/student/dst/src/lib/f')).toBe('x\n');
  });
  it('errors', () => {
    const t = makeShell();
    expect(t.run('cp').err).toBe("cp: missing file operand\nTry 'cp --help' for more information.\n");
    expect(t.run('cp a').err).toBe("cp: missing destination file operand after 'a'\nTry 'cp --help' for more information.\n");
    expect(t.run('cp ghost x')).toMatchObject({ err: "cp: cannot stat 'ghost': No such file or directory\n", code: 1 });
    expect(t.run('cp notes.txt notes.txt').err).toBe("cp: 'notes.txt' and 'notes.txt' are the same file\n");
    expect(t.run('touch a b && cp a b notes.txt').err).toBe("cp: target 'notes.txt' is not a directory\n");
    expect(t.run('cp -r projects projects/inner').err).toBe(
      "cp: cannot copy a directory, 'projects', into itself, 'projects/inner'\n",
    );
    expect(t.run('cp /var/log/syslog .').err).toBe("cp: cannot open '/var/log/syslog' for reading: Permission denied\n");
    expect(t.run('cp notes.txt /etc/').err).toBe("cp: cannot create regular file '/etc/notes.txt': Permission denied\n");
  });
});

describe('mv', () => {
  it('renames and moves into directories', () => {
    const t = makeShell();
    t.setup('touch a');
    expect(t.run('mv a b').code).toBe(0);
    expect(t.vfs().exists('/home/student/a')).toBe(false);
    expect(t.run('mv -v b projects').out).toBe("renamed 'b' -> 'projects/b'\n");
    expect(t.vfs().exists('/home/student/projects/b')).toBe(true);
  });
  it('moves directories and overwrites files', () => {
    const t = makeShell();
    t.setup('mkdir d', 'echo new > x', 'echo old > y');
    t.run('mv d projects/d2');
    expect(t.vfs().isDir('/home/student/projects/d2')).toBe(true);
    t.run('mv x y');
    expect(t.read('/home/student/y')).toBe('new\n');
  });
  it('errors', () => {
    const t = makeShell();
    expect(t.run('mv').err).toBe("mv: missing file operand\nTry 'mv --help' for more information.\n");
    expect(t.run('mv ghost x')).toMatchObject({ err: "mv: cannot stat 'ghost': No such file or directory\n", code: 1 });
    expect(t.run('mv projects projects/sub').err).toBe(
      "mv: cannot move 'projects' to a subdirectory of itself, 'projects/sub'\n",
    );
    expect(t.run('mv notes.txt /etc/').err).toBe("mv: cannot move 'notes.txt' to '/etc/notes.txt': Permission denied\n");
    expect(t.run('mv notes.txt notes.txt').err).toBe("mv: 'notes.txt' and 'notes.txt' are the same file\n");
  });
});
