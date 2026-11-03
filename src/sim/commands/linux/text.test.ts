import { describe, expect, it } from 'vitest';
import { makeShell } from '../../testing';
import { posixToJs } from './grep';

const nums = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join('\n') + '\n';

function withNums() {
  const t = makeShell();
  t.vfs().writeFile('/home/student/n.txt', nums);
  return t;
}

describe('head', () => {
  it('prints first 10 lines by default, -n N, -N', () => {
    const t = withNums();
    expect(t.run('head n.txt').out.split('\n')).toHaveLength(11);
    expect(t.run('head -n 2 n.txt').out).toBe('line1\nline2\n');
    expect(t.run('head -3 n.txt').out).toBe('line1\nline2\nline3\n');
    expect(t.run('head -n2 n.txt').out).toBe('line1\nline2\n');
    expect(t.run('head --lines=1 n.txt').out).toBe('line1\n');
    expect(t.run('head -n -13 n.txt').out).toBe('line1\nline2\n');
    expect(t.run('head -c 3 n.txt').out).toBe('lin');
  });
  it('reads stdin and prints headers for multiple files', () => {
    const t = withNums();
    expect(t.run('cat n.txt | head -n 1').out).toBe('line1\n');
    expect(t.run('head -n 1 n.txt notes.txt').out).toBe('==> n.txt <==\nline1\n\n==> notes.txt <==\nWelcome to DevOps Quest!\n');
    expect(t.run('head -q -n 1 n.txt n.txt').out).toBe('line1\nline1\n');
  });
  it('errors', () => {
    const t = withNums();
    expect(t.run('head nope')).toMatchObject({ err: "head: cannot open 'nope' for reading: No such file or directory\n", code: 1 });
    expect(t.run('head -n x n.txt')).toMatchObject({ err: "head: invalid number of lines: 'x'\n", code: 1 });
    expect(t.run('head /etc').err).toBe("head: error reading '/etc': Is a directory\n");
  });
});

describe('tail', () => {
  it('prints last lines, -n +N from a line', () => {
    const t = withNums();
    expect(t.run('tail -n 2 n.txt').out).toBe('line14\nline15\n');
    expect(t.run('tail -2 n.txt').out).toBe('line14\nline15\n');
    expect(t.run('tail -n +14 n.txt').out).toBe('line14\nline15\n');
    expect(t.run('tail n.txt').out.split('\n')[0]).toBe('line6');
    expect(t.run('tail -c 3 n.txt').out).toBe('15\n');
    expect(t.run('printf_missing 2>/dev/null; echo -n "a\nb" | tail -n 1').out).toBe('b');
  });
  it('-f is explained instead of hanging', () => {
    const t = withNums();
    const r = t.run('tail -f -n 1 n.txt');
    expect(r.out).toBe('line15\n');
    expect(r.err).toMatch(/-f \(follow\) is not supported/);
  });
  it('errors', () => {
    const t = withNums();
    expect(t.run('tail nope').err).toBe("tail: cannot open 'nope' for reading: No such file or directory\n");
    expect(t.run('tail /var/log/syslog').err).toBe("tail: cannot open '/var/log/syslog' for reading: Permission denied\n");
  });
});

describe('grep', () => {
  const log = 'INFO start\nERROR disk full\nwarn: low memory\nERROR timeout\ninfo done\n';
  function withLog() {
    const t = makeShell();
    t.vfs().writeFile('/home/student/app.log', log);
    return t;
  }

  it('matches lines; exit 0 on match, 1 on none', () => {
    const t = withLog();
    expect(t.run('grep ERROR app.log')).toEqual({ out: 'ERROR disk full\nERROR timeout\n', err: '', code: 0 });
    expect(t.run('grep nothing app.log')).toEqual({ out: '', err: '', code: 1 });
  });

  it('supports -i -v -n -c -o -w -x', () => {
    const t = withLog();
    expect(t.run('grep -i info app.log').out).toBe('INFO start\ninfo done\n');
    expect(t.run('grep -v ERROR app.log').out).toBe('INFO start\nwarn: low memory\ninfo done\n');
    expect(t.run('grep -n ERROR app.log').out).toBe('2:ERROR disk full\n4:ERROR timeout\n');
    expect(t.run('grep -c ERROR app.log').out).toBe('2\n');
    expect(t.run('grep -o "disk [a-z]*" app.log').out).toBe('disk full\n');
    expect(t.run('grep -w low app.log').out).toBe('warn: low memory\n');
    expect(t.run('grep -w lo app.log').code).toBe(1);
    expect(t.run('grep -x "info done" app.log').out).toBe('info done\n');
    expect(t.run('grep -ic error app.log').out).toBe('2\n');
  });

  it('BRE vs ERE vs fixed strings', () => {
    const t = withLog();
    expect(t.run('grep "ERROR\\|warn" app.log').out).toBe('ERROR disk full\nwarn: low memory\nERROR timeout\n');
    expect(t.run('grep -E "ERROR|warn" app.log').out).toBe('ERROR disk full\nwarn: low memory\nERROR timeout\n');
    expect(t.run('grep "ERROR|warn" app.log').code).toBe(1); // | is literal in BRE
    expect(t.run('grep -F "low m" app.log').out).toBe('warn: low memory\n');
    expect(t.run('grep "^ERROR.*out$" app.log').out).toBe('ERROR timeout\n');
    expect(t.run('grep "[[:upper:]]\\{4,\\} " app.log').out).toBe('INFO start\nERROR disk full\nERROR timeout\n');
    expect(posixToJs('a\\(b\\)\\+', false)).toBe('a(b)+');
    expect(posixToJs('a(b)+', false)).toBe('a\\(b\\)\\+');
  });

  it('reads stdin, multiple files get prefixes, -h/-H, -l/-L, -q', () => {
    const t = withLog();
    expect(t.run('cat app.log | grep timeout').out).toBe('ERROR timeout\n');
    expect(t.run('grep -H timeout app.log').out).toBe('app.log:ERROR timeout\n');
    expect(t.run('grep Welcome app.log notes.txt').out).toBe('notes.txt:Welcome to DevOps Quest!\n');
    expect(t.run('grep -h Welcome app.log notes.txt').out).toBe('Welcome to DevOps Quest!\n');
    expect(t.run('grep -l ERROR app.log notes.txt').out).toBe('app.log\n');
    expect(t.run('grep -L ERROR app.log notes.txt').out).toBe('notes.txt\n');
    expect(t.run('grep -c ERROR app.log notes.txt').out).toBe('app.log:2\nnotes.txt:0\n');
    expect(t.run('grep -q ERROR app.log')).toEqual({ out: '', err: '', code: 0 });
  });

  it('searches recursively with -r', () => {
    const t = withLog();
    t.setup('mkdir -p src/lib', 'echo "TODO fix" > src/a.py', 'echo "# TODO later" > src/lib/b.py');
    expect(t.run('grep -r TODO src').out).toBe('src/a.py:TODO fix\nsrc/lib/b.py:# TODO later\n');
    expect(t.run('cd src && grep -rl TODO').out).toBe('./a.py\n./lib/b.py\n');
  });

  it('errors exit 2', () => {
    const t = withLog();
    expect(t.run('grep x nope')).toEqual({ out: '', err: 'grep: nope: No such file or directory\n', code: 2 });
    expect(t.run('grep x projects').err).toBe('grep: projects: Is a directory\n');
    expect(t.run('grep -s x nope')).toEqual({ out: '', err: '', code: 2 });
    expect(t.run('grep')).toMatchObject({ err: "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n", code: 2 });
    expect(t.run('grep -E "(" app.log')).toMatchObject({ code: 2 });
    expect(t.run('grep -Z x app.log').code).toBe(2);
  });
});

describe('find', () => {
  function tree() {
    const t = makeShell();
    t.setup('mkdir -p app/src app/logs', 'touch app/src/main.py app/src/util.py app/README.md', 'echo data > app/logs/a.log');
    return t;
  }

  it('lists everything below a path', () => {
    const t = tree();
    expect(t.run('find app').out).toBe(
      'app\napp/README.md\napp/logs\napp/logs/a.log\napp/src\napp/src/main.py\napp/src/util.py\n',
    );
    expect(t.run('cd app && find').out.split('\n')[0]).toBe('.');
  });

  it('filters by -name, -iname, -type, -path', () => {
    const t = tree();
    expect(t.run('find app -name "*.py"').out).toBe('app/src/main.py\napp/src/util.py\n');
    expect(t.run('find app -iname "readme*"').out).toBe('app/README.md\n');
    expect(t.run('find app -type d').out).toBe('app\napp/logs\napp/src\n');
    expect(t.run('find app -type f -name "*.log"').out).toBe('app/logs/a.log\n');
    expect(t.run('find app -path "*src/m*"').out).toBe('app/src/main.py\n');
    expect(t.run('find app -not -name "*.py" -type f').out).toBe('app/README.md\napp/logs/a.log\n');
    expect(t.run('find app ! -type d -name "*.md"').out).toBe('app/README.md\n');
  });

  it('respects -maxdepth / -mindepth, -empty, -size, -user', () => {
    const t = tree();
    expect(t.run('find app -maxdepth 1').out).toBe('app\napp/README.md\napp/logs\napp/src\n');
    expect(t.run('find app -mindepth 2 -type d').out).toBe('');
    expect(t.run('find app -empty').out).toBe('app/README.md\napp/src/main.py\napp/src/util.py\n');
    expect(t.run('find app -type f -size +0').out).toBe('app/logs/a.log\n');
    expect(t.run('find /etc -user student').out).toBe('');
  });

  it('-delete removes matches', () => {
    const t = tree();
    expect(t.run('find app -name "*.log" -delete').out).toBe('');
    expect(t.vfs().exists('/home/student/app/logs/a.log')).toBe(false);
  });

  it('reports errors', () => {
    const t = tree();
    expect(t.run('find nope')).toMatchObject({ err: "find: 'nope': No such file or directory\n", code: 1 });
    expect(t.run('find app -bogus').err).toBe("find: unknown predicate '-bogus'\n");
    expect(t.run('find app -name').err).toBe("find: missing argument to '-name'\n");
    expect(t.run('find app -type x').err).toBe('find: Unknown argument to -type: x\n');
    expect(t.run('find app -exec rm {} ;').err).toMatch(/'-exec' is not supported in devquest/);
    const r = t.run('find / -maxdepth 1 -name root');
    expect(r.out).toBe('/root\n');
    const deep = t.run('find /root');
    expect(deep).toMatchObject({ out: '/root\n', err: "find: '/root': Permission denied\n", code: 1 });
  });
});

describe('wc', () => {
  it('counts lines, words, bytes with GNU spacing', () => {
    const t = makeShell();
    t.setup('echo "hello world" > a', 'echo "one two three" >> a');
    expect(t.run('wc a').out).toBe(' 2  5 26 a\n');
    expect(t.run('wc -l a').out).toBe('2 a\n');
    expect(t.run('wc -w < a').out).toBe('5\n');
    expect(t.run('cat a | wc').out).toBe('      2       5      26\n');
    expect(t.run('wc -l a notes.txt').out).toBe(' 2 a\n 2 notes.txt\n 4 total\n');
    expect(t.run('echo héllo | wc -m').out).toBe('6\n');
    expect(t.run('echo héllo | wc -c').out).toBe('7\n');
  });
  it('errors', () => {
    const t = makeShell();
    expect(t.run('wc nope')).toMatchObject({ err: 'wc: nope: No such file or directory\n', code: 1 });
    expect(t.run('wc projects').err).toBe('wc: projects: Is a directory\n');
  });
});

describe('sort', () => {
  it('sorts lines (byte order), -r, -n, -u, -f', () => {
    const t = makeShell();
    t.vfs().writeFile('/home/student/s', 'banana\nApple\ncherry\napple\n');
    expect(t.run('sort s').out).toBe('Apple\napple\nbanana\ncherry\n');
    expect(t.run('sort -r s').out).toBe('cherry\nbanana\napple\nApple\n');
    expect(t.run('sort -f s').out).toBe('Apple\napple\nbanana\ncherry\n');
    expect(t.run('echo -e "10\\n9\\n100" | sort').out).toBe('10\n100\n9\n');
    expect(t.run('echo -e "10\\n9\\n100" | sort -n').out).toBe('9\n10\n100\n');
    expect(t.run('echo -e "b\\na\\nb" | sort -u').out).toBe('a\nb\n');
    expect(t.run('echo -e "2K\\n1M\\n512" | sort -h').out).toBe('512\n2K\n1M\n');
  });
  it('sorts by key with -k and -t', () => {
    const t = makeShell();
    expect(t.run('echo -e "bob 30\\nann 25\\ncid 41" | sort -k2 -n').out).toBe('ann 25\nbob 30\ncid 41\n');
    expect(t.run('sort -t: -k3 -n /etc/passwd | head -n 1').out).toBe('root:x:0:0:root:/root:/bin/bash\n');
  });
  it('-o writes to a file; errors exit 2', () => {
    const t = makeShell();
    t.run('echo -e "b\\na" | sort -o out.txt');
    expect(t.read('/home/student/out.txt')).toBe('a\nb\n');
    expect(t.run('sort nope')).toMatchObject({ err: 'sort: cannot read: nope: No such file or directory\n', code: 2 });
  });
});

describe('uniq', () => {
  it('collapses adjacent duplicates, -c, -d, -u, -i', () => {
    const t = makeShell();
    t.vfs().writeFile('/home/student/u', 'a\na\nb\nA\na\n');
    expect(t.run('uniq u').out).toBe('a\nb\nA\na\n');
    expect(t.run('uniq -c u').out).toBe('      2 a\n      1 b\n      1 A\n      1 a\n');
    expect(t.run('uniq -d u').out).toBe('a\n');
    expect(t.run('uniq -u u').out).toBe('b\nA\na\n');
    expect(t.run('uniq -i u').out).toBe('a\nb\nA\n');
    expect(t.run('sort u | uniq -c | sort -rn | head -n 1').out).toBe('      3 a\n');
  });
  it('errors', () => {
    expect(makeShell().run('uniq nope')).toMatchObject({ err: 'uniq: nope: No such file or directory\n', code: 1 });
  });
});
