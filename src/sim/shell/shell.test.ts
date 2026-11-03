import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';

describe('shell execution', () => {
  it('runs a simple command', () => {
    const t = makeShell();
    expect(t.run('echo hello world')).toEqual({ out: 'hello world\n', err: '', code: 0 });
  });

  it('reports unknown commands with exit 127', () => {
    const t = makeShell();
    expect(t.run('frobnicate')).toEqual({ out: '', err: 'bash: frobnicate: command not found\n', code: 127 });
    expect(t.run('echo $?').out).toBe('127\n');
  });

  it('explains real-but-unsimulated commands', () => {
    const t = makeShell();
    const r = t.run('vim notes.txt');
    expect(r.code).toBe(127);
    expect(r.err).toMatch(/'vim' is a real command, but it is not available in this simulator/);
  });

  it('handles paths as commands', () => {
    const t = makeShell();
    expect(t.run('./missing.sh').err).toBe('bash: ./missing.sh: No such file or directory\n');
    expect(t.run('./notes.txt')).toMatchObject({ err: 'bash: ./notes.txt: Permission denied\n', code: 126 });
    expect(t.run('/etc')).toMatchObject({ err: 'bash: /etc: Is a directory\n', code: 126 });
  });

  it('syntax errors set $? to 2', () => {
    const t = makeShell();
    expect(t.run('ls |')).toMatchObject({ code: 2 });
    expect(t.run('echo $?').out).toBe('2\n');
  });

  it('pipes stdout into the next command', () => {
    const t = makeShell();
    expect(t.run('echo -e "b\\na\\nb" | sort | uniq').out).toBe('a\nb\n');
    expect(t.run('cat /etc/passwd | grep student | wc -l').out).toBe('1\n');
  });

  it('pipeline exit status is that of the last command', () => {
    const t = makeShell();
    expect(t.run('false | true').code).toBe(0);
    expect(t.run('true | false').code).toBe(1);
  });

  it('stderr is not piped', () => {
    const t = makeShell();
    const r = t.run('cat nope | wc -l');
    expect(r.err).toBe('cat: nope: No such file or directory\n');
    expect(r.out).toBe('0\n');
  });

  it('&& and || short-circuit, ; always runs', () => {
    const t = makeShell();
    expect(t.run('true && echo yes').out).toBe('yes\n');
    expect(t.run('false && echo yes').out).toBe('');
    expect(t.run('false || echo fallback').out).toBe('fallback\n');
    expect(t.run('true || echo no').out).toBe('');
    expect(t.run('false; echo always').out).toBe('always\n');
    expect(t.run('false && echo a || echo b').out).toBe('b\n');
    expect(t.run('mkdir d && cd d && pwd').out).toBe('/home/student/d\n');
  });

  it('> creates/truncates and >> appends', () => {
    const t = makeShell();
    t.run('echo one > f.txt');
    t.run('echo two >> f.txt');
    expect(t.read('/home/student/f.txt')).toBe('one\ntwo\n');
    t.run('echo three > f.txt');
    expect(t.read('/home/student/f.txt')).toBe('three\n');
  });

  it('a bare redirect truncates/creates a file', () => {
    const t = makeShell();
    t.run('> empty.txt');
    expect(t.read('/home/student/empty.txt')).toBe('');
  });

  it('< feeds a file to stdin', () => {
    const t = makeShell();
    expect(t.run('wc -l < /etc/passwd').out).toBe('3\n');
    expect(t.run('cat < nope')).toMatchObject({ err: 'bash: nope: No such file or directory\n', code: 1 });
  });

  it('2> and 2>&1 route stderr', () => {
    const t = makeShell();
    expect(t.run('ls nope 2> err.txt')).toMatchObject({ out: '', err: '', code: 2 });
    expect(t.read('/home/student/err.txt')).toBe("ls: cannot access 'nope': No such file or directory\n");
    expect(t.run('ls nope 2>/dev/null')).toMatchObject({ err: '', code: 2 });
    t.run('ls nope notes.txt > all.txt 2>&1');
    expect(t.read('/home/student/all.txt')).toBe("ls: cannot access 'nope': No such file or directory\nnotes.txt\n");
    expect(t.run('ls nope 2>&1 | wc -l')).toMatchObject({ out: '1\n', err: '' });
    t.run('ls nope &> both.txt');
    expect(t.read('/home/student/both.txt')).toContain('cannot access');
  });

  it('order of 2>&1 matters like in bash', () => {
    const t = makeShell();
    // stderr was duplicated onto the terminal's stdout *before* stdout moved to the file.
    const r = t.run('ls nope 2>&1 > out.txt');
    expect(r.out).toContain('cannot access');
    expect(t.read('/home/student/out.txt')).toBe('');
  });

  it('redirect errors prevent the command from running', () => {
    const t = makeShell();
    expect(t.run('echo hi > /etc/x')).toEqual({ out: '', err: 'bash: /etc/x: Permission denied\n', code: 1 });
    expect(t.run('echo hi > nodir/x')).toMatchObject({ err: 'bash: nodir/x: No such file or directory\n', code: 1 });
    expect(t.run('echo hi > /tmp')).toMatchObject({ err: 'bash: /tmp: Is a directory\n', code: 1 });
    expect(t.run('echo hi > $NOPE')).toMatchObject({ err: 'bash: $NOPE: ambiguous redirect\n', code: 1 });
  });

  it('logs executed commands for validators', () => {
    const t = makeShell();
    t.run('mkdir app && ls nope');
    expect(t.state.commandLog).toEqual([
      { argv: ['mkdir', 'app'], exitCode: 0 },
      { argv: ['ls', 'nope'], exitCode: 2 },
    ]);
    expect(t.state.history).toEqual(['mkdir app && ls nope']);
  });

  it('clear asks the UI to clear', () => {
    const t = makeShell();
    expect(t.shell.run('clear').clear).toBe(true);
    expect(t.shell.run('echo').clear).toBe(false);
  });
});

describe('expansion', () => {
  it('expands variables, $? and ${VAR}', () => {
    const t = makeShell();
    expect(t.run('echo $HOME ${USER}x $?').out).toBe('/home/student studentx 0\n');
    expect(t.run('echo "$HOME" \'$HOME\' \\$HOME').out).toBe('/home/student $HOME $HOME\n');
    expect(t.run('echo ${NOPE:-default} [$NOPE]').out).toBe('default []\n');
    expect(t.run('echo $ "a$"').out).toBe('$ a$\n');
  });

  it('sets shell variables and prefix assignments', () => {
    const t = makeShell();
    t.run('GREETING="hi there"');
    expect(t.run('echo $GREETING').out).toBe('hi there\n');
    // not exported: env does not show it
    expect(t.run('env').out).not.toContain('GREETING');
    // prefix assignment only affects that command's environment
    expect(t.run('APP_ENV=prod env').out).toContain('APP_ENV=prod\n');
    expect(t.run('echo [$APP_ENV]').out).toBe('[]\n');
  });

  it('word-splits unquoted variables but not quoted ones', () => {
    const t = makeShell();
    t.run('FILES="a b c"');
    t.run('touch $FILES');
    expect(t.run('ls').out).toBe('a  b  c  notes.txt  projects\n');
    t.run('touch "$FILES"');
    expect(t.vfs().exists('/home/student/a b c')).toBe(true);
    expect(t.run('echo "[$EMPTY]" [$EMPTY]').out).toBe('[] []\n');
  });

  it('expands ~', () => {
    const t = makeShell();
    t.run('cd /tmp');
    expect(t.run('echo ~ ~/x "~"').out).toBe('/home/student /home/student/x ~\n');
  });

  it('expands globs, sorted, skipping hidden files', () => {
    const t = makeShell();
    t.setup('mkdir logs', 'touch logs/b.log logs/a.log logs/c.txt logs/.hidden.log');
    expect(t.run('echo logs/*.log').out).toBe('logs/a.log logs/b.log\n');
    expect(t.run('cd logs && echo *').out).toBe('a.log b.log c.txt\n');
    expect(t.run('echo ?.txt [ab].log').out).toBe('c.txt a.log b.log\n');
    expect(t.run('echo .*.log').out).toBe('.hidden.log\n');
    expect(t.run('echo [!a]*').out).toBe('b.log c.txt\n');
    expect(t.run('echo /etc/host*').out).toBe('/etc/hostname\n');
  });

  it('leaves unmatched or quoted globs literal', () => {
    const t = makeShell();
    expect(t.run('echo *.nothing "*" \\*').out).toBe('*.nothing * *\n');
    expect(t.run('ls *.nothing').err).toBe("ls: cannot access '*.nothing': No such file or directory\n");
  });

  it('globs across directories', () => {
    const t = makeShell();
    t.setup('mkdir -p a/x b/y', 'touch a/x/f b/y/f');
    expect(t.run('echo */*/f').out).toBe('a/x/f b/y/f\n');
    expect(t.run('echo */').out).toBe('a/ b/ projects/\n');
  });
});
