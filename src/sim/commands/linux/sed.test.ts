import { describe, expect, it } from 'vitest';
import { makeShell } from '../../testing';

function withFile(content = 'alpha one\nbeta two\ngamma three\n') {
  const t = makeShell();
  t.vfs().writeFile('/home/student/f.txt', content);
  return t;
}

describe('sed', () => {
  it('substitutes the first match per line, or all with g', () => {
    const t = makeShell();
    expect(t.run("echo 'a-a-a' | sed 's/a/b/'").out).toBe('b-a-a\n');
    expect(t.run("echo 'a-a-a' | sed 's/a/b/g'").out).toBe('b-b-b\n');
    expect(t.run("echo 'a-a-a' | sed 's/a/b/2'").out).toBe('a-b-a\n');
    expect(t.run("echo 'Hello' | sed 's/hello/bye/I'").out).toBe('bye\n');
  });

  it('supports other delimiters, & and groups', () => {
    const t = makeShell();
    expect(t.run("echo /usr/bin | sed 's#/usr#/opt#'").out).toBe('/opt/bin\n');
    expect(t.run("echo port=80 | sed 's/[0-9]*$/[&]/'").out).toBe('port=[80]\n');
    expect(t.run("echo 'john smith' | sed 's/\\(\\w*\\) \\(\\w*\\)/\\2 \\1/'").out).toBe('smith john\n');
    expect(t.run("echo 'john smith' | sed -E 's/(\\w+) (\\w+)/\\2, \\1/'").out).toBe('smith, john\n');
    expect(t.run("echo a | sed 's/a/x\\ny/'").out).toBe('x\ny\n');
  });

  it('deletes and prints by address', () => {
    const t = withFile();
    expect(t.run("sed '/beta/d' f.txt").out).toBe('alpha one\ngamma three\n');
    expect(t.run("sed '2d' f.txt").out).toBe('alpha one\ngamma three\n');
    expect(t.run("sed '$d' f.txt").out).toBe('alpha one\nbeta two\n');
    expect(t.run("sed -n '2p' f.txt").out).toBe('beta two\n');
    expect(t.run("sed -n '1,2p' f.txt").out).toBe('alpha one\nbeta two\n');
    expect(t.run("sed -n '/alpha/,/beta/p' f.txt").out).toBe('alpha one\nbeta two\n');
    expect(t.run("sed '/beta/!d' f.txt").out).toBe('beta two\n');
    expect(t.run("sed 2q f.txt").out).toBe('alpha one\nbeta two\n');
    expect(t.run("sed -n 's/one/ONE/p' f.txt").out).toBe('alpha ONE\n');
  });

  it('runs several expressions in order', () => {
    const t = withFile();
    expect(t.run("sed -e 's/alpha/A/' -e '/gamma/d' f.txt").out).toBe('A one\nbeta two\n');
    expect(t.run("sed 's/alpha/A/; s/beta/B/' f.txt").out).toBe('A one\nB two\ngamma three\n');
  });

  it('-i edits files in place (optionally keeping a backup)', () => {
    const t = withFile();
    expect(t.run("sed -i 's/two/2/' f.txt")).toMatchObject({ out: '', code: 0 });
    expect(t.read('/home/student/f.txt')).toBe('alpha one\nbeta 2\ngamma three\n');
    t.setup("sed -i.bak '1d' f.txt");
    expect(t.read('/home/student/f.txt.bak')).toBe('alpha one\nbeta 2\ngamma three\n');
    expect(t.read('/home/student/f.txt')).toBe('beta 2\ngamma three\n');
  });

  it('needs permission to edit root files in place', () => {
    const t = makeShell();
    expect(t.run("sed -i 's/a/b/' /etc/hosts")).toMatchObject({ err: "sed: can't read /etc/hosts: Permission denied\n", code: 2 });
    expect(t.run("sudo sed -i '/ip6/d' /etc/hosts").code).toBe(0);
    expect(t.run('grep -c ip6 /etc/hosts').out).toBe('0\n');
  });

  it('reports errors like GNU sed', () => {
    const t = withFile();
    expect(t.run("sed 's/a/b' f.txt")).toMatchObject({ code: 1 });
    expect(t.run("sed 's/a/b' f.txt").err).toMatch(/^sed: -e expression #1, char \d+: unterminated `s' command\n$/);
    expect(t.run("sed 'y/a/b/' f.txt").err).toMatch(/unknown command: `y'/);
    expect(t.run("sed p nope.txt")).toMatchObject({ err: "sed: can't read nope.txt: No such file or directory\n", code: 2 });
    expect(t.run('sed').code).toBe(1);
    expect(t.run("sed -i 's/a/b/'").err).toBe('sed: no input files\n');
  });
});

describe('tee', () => {
  it('copies stdin to stdout and files', () => {
    const t = makeShell();
    expect(t.run('echo hi | tee a.txt b.txt').out).toBe('hi\n');
    expect(t.read('/home/student/a.txt')).toBe('hi\n');
    expect(t.read('/home/student/b.txt')).toBe('hi\n');
    t.setup('echo again | tee -a a.txt > /dev/null');
    expect(t.read('/home/student/a.txt')).toBe('hi\nagain\n');
  });

  it('works through sudo for root-owned files', () => {
    const t = makeShell();
    expect(t.run('echo x | tee /etc/motd')).toMatchObject({ err: 'tee: /etc/motd: Permission denied\n', code: 1 });
    expect(t.run('echo "10.0.0.5 db" | sudo tee -a /etc/hosts')).toMatchObject({ out: '10.0.0.5 db\n', code: 0 });
    expect(t.read('/etc/hosts')).toMatch(/10\.0\.0\.5 db\n$/);
  });
});
