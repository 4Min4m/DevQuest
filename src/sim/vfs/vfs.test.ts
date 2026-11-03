import { describe, expect, it } from 'vitest';
import { createDefaultFs } from '../state';
import { basename, dirname, isWithin, normalize, resolvePath, tildify } from './path';
import { VfsError } from './types';
import { Vfs } from './vfs';

const student = { name: 'student', groups: ['student', 'sudo'] };
const root = { name: 'root', groups: ['root'] };

function make(user = student) {
  let t = 1000;
  return new Vfs(createDefaultFs(), user, () => ++t);
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as VfsError).code;
  }
  return 'OK';
}

describe('path helpers', () => {
  it('normalizes . and .. and duplicate slashes', () => {
    expect(normalize('/a//b/./c/../d')).toBe('/a/b/d');
    expect(normalize('/../..')).toBe('/');
  });
  it('resolves relative and absolute paths', () => {
    expect(resolvePath('/home/student', 'x/../y')).toBe('/home/student/y');
    expect(resolvePath('/home/student', '/etc')).toBe('/etc');
    expect(resolvePath('/', '..')).toBe('/');
  });
  it('dirname / basename / tildify / isWithin', () => {
    expect(dirname('/a/b/c')).toBe('/a/b');
    expect(dirname('/a')).toBe('/');
    expect(basename('/a/b/')).toBe('b');
    expect(tildify('/home/student/x', '/home/student')).toBe('~/x');
    expect(tildify('/home/studentx', '/home/student')).toBe('/home/studentx');
    expect(isWithin('/a/b', '/a')).toBe(true);
    expect(isWithin('/ab', '/a')).toBe(false);
  });
});

describe('Vfs', () => {
  it('reads and writes files', () => {
    const v = make();
    v.writeFile('/home/student/a.txt', 'hello\n');
    expect(v.readFile('/home/student/a.txt')).toBe('hello\n');
    v.writeFile('/home/student/a.txt', 'more\n', { append: true });
    expect(v.readFile('/home/student/a.txt')).toBe('hello\nmore\n');
    const node = v.stat('/home/student/a.txt');
    expect(node.owner).toBe('student');
    expect(node.mode).toBe(0o644);
  });

  it('reports errno codes', () => {
    const v = make();
    expect(code(() => v.readFile('/nope'))).toBe('ENOENT');
    expect(code(() => v.readFile('/etc'))).toBe('EISDIR');
    expect(code(() => v.readFile('/etc/hostname/x'))).toBe('ENOTDIR');
    expect(code(() => v.mkdir('/home/student/projects'))).toBe('EEXIST');
    expect(code(() => v.mkdir('/home/student/a/b'))).toBe('ENOENT');
    expect(code(() => v.writeFile('/etc', 'x'))).toBe('EISDIR');
  });

  it('enforces permissions for normal users', () => {
    const v = make();
    expect(code(() => v.writeFile('/etc/new', 'x'))).toBe('EACCES');
    expect(code(() => v.writeFile('/etc/hostname', 'x'))).toBe('EACCES');
    expect(code(() => v.readdir('/root'))).toBe('EACCES');
    expect(code(() => v.lookup('/root/secret'))).toBe('EACCES');
    expect(code(() => v.readFile('/var/log/syslog'))).toBe('EACCES');
    expect(code(() => v.remove('/etc/hostname'))).toBe('EACCES');
  });

  it('lets root bypass permissions', () => {
    const v = make(root);
    v.writeFile('/etc/new', 'x');
    expect(v.readFile('/var/log/syslog')).toContain('sshd');
    expect(v.readdir('/root')).toEqual([]);
  });

  it('applies group permissions', () => {
    const v = make(root);
    v.writeFile('/srv.txt', 'x');
    v.chown('/srv.txt', 'root', 'sudo');
    v.chmod('/srv.txt', 0o640);
    const s = new Vfs(v.root, student);
    expect(s.readFile('/srv.txt')).toBe('x');
    const other = new Vfs(v.root, { name: 'www-data', groups: ['www-data'] });
    expect(code(() => other.readFile('/srv.txt'))).toBe('EACCES');
  });

  it('mkdir -p creates intermediate dirs and fails on files in the way', () => {
    const v = make();
    v.mkdir('/home/student/a/b/c', { parents: true });
    expect(v.isDir('/home/student/a/b/c')).toBe(true);
    v.mkdir('/home/student/a/b', { parents: true }); // no error when it exists
    v.writeFile('/home/student/f', '');
    expect(code(() => v.mkdir('/home/student/f/x', { parents: true }))).toBe('ENOTDIR');
    expect(code(() => v.mkdir('/home/student/f', { parents: true }))).toBe('EEXIST');
  });

  it('removes files and directories', () => {
    const v = make();
    v.mkdir('/home/student/d/e', { parents: true });
    v.writeFile('/home/student/d/e/f', 'x');
    expect(code(() => v.remove('/home/student/d'))).toBe('EISDIR');
    expect(code(() => v.remove('/home/student/d', { dirOnlyIfEmpty: true }))).toBe('ENOTEMPTY');
    v.remove('/home/student/d', { recursive: true });
    expect(v.exists('/home/student/d')).toBe(false);
    expect(code(() => v.remove('/home/student/d'))).toBe('ENOENT');
  });

  it('moves nodes and keeps content', () => {
    const v = make();
    v.writeFile('/home/student/a', 'A');
    v.move('/home/student/a', '/home/student/projects/b');
    expect(v.exists('/home/student/a')).toBe(false);
    expect(v.readFile('/home/student/projects/b')).toBe('A');
  });

  it('chmod/chown require ownership or root', () => {
    const v = make();
    expect(code(() => v.chmod('/etc/hostname', 0o777))).toBe('EPERM');
    expect(code(() => v.chown('/home/student/notes.txt', 'root', undefined))).toBe('EPERM');
    v.chown('/home/student/notes.txt', undefined, 'sudo'); // own file, own group: allowed
    expect(v.stat('/home/student/notes.txt').group).toBe('sudo');
    v.chmod('/home/student/notes.txt', 0o600);
    expect(v.stat('/home/student/notes.txt').mode).toBe(0o600);
  });

  it('touch creates files and bumps mtime', () => {
    const v = make();
    v.touch('/home/student/t');
    const m1 = v.stat('/home/student/t').mtime;
    v.touch('/home/student/t');
    expect(v.stat('/home/student/t').mtime).toBeGreaterThan(m1);
  });

  it('state is plain JSON-serializable data', () => {
    const v = make();
    v.writeFile('/home/student/x', 'y');
    const copy = JSON.parse(JSON.stringify(v.root));
    expect(new Vfs(copy, student).readFile('/home/student/x')).toBe('y');
  });
});
