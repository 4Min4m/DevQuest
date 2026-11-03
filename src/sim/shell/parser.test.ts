import { describe, expect, it } from 'vitest';
import { wordText } from './ast';
import { parse, ParseError } from './parser';

function words(input: string): string[][] {
  return parse(input).items.flatMap((i) => i.pipeline.commands.map((c) => c.words.map(wordText)));
}

function err(input: string): string {
  try {
    parse(input);
  } catch (e) {
    if (e instanceof ParseError) return e.message;
    throw e;
  }
  return 'no error';
}

describe('parser', () => {
  it('splits words on whitespace', () => {
    expect(words('ls  -la   /tmp')).toEqual([['ls', '-la', '/tmp']]);
  });

  it('handles single, double quotes and escapes', () => {
    expect(words(`echo 'a b' "c d" e\\ f`)).toEqual([['echo', 'a b', 'c d', 'e f']]);
    expect(words(`echo "it's" 'say "hi"'`)).toEqual([['echo', "it's", 'say "hi"']]);
    expect(words(`echo a"b"'c'd`)).toEqual([['echo', 'abcd']]);
    expect(words(`echo "" ''`)).toEqual([['echo', '', '']]);
  });

  it('records quote kinds per part', () => {
    const cmd = parse(`echo "$A" '$B' $C \\$D`).items[0].pipeline.commands[0];
    expect(cmd.words.slice(1).map((w) => w.parts.map((p) => p.quote))).toEqual([
      ['double'],
      ['literal'],
      ['none'],
      ['literal', 'none'],
    ]);
  });

  it('parses pipelines', () => {
    const s = parse('cat f | grep x | wc -l');
    expect(s.items).toHaveLength(1);
    expect(s.items[0].pipeline.commands.map((c) => wordText(c.words[0]))).toEqual(['cat', 'grep', 'wc']);
  });

  it('parses ; && || lists', () => {
    const s = parse('a; b && c || d');
    expect(s.items.map((i) => i.op)).toEqual([null, ';', '&&', '||']);
    expect(parse('a;').items).toHaveLength(1);
  });

  it('parses redirects with fds', () => {
    const c = parse('cmd > out 2>> err < in 2>&1 &> both').items[0].pipeline.commands[0];
    expect(c.words.map(wordText)).toEqual(['cmd']);
    expect(c.redirects.map((r) => [r.fd, r.op, wordText(r.target)])).toEqual([
      [1, '>', 'out'],
      [2, '>>', 'err'],
      [0, '<', 'in'],
      [2, '>&', '1'],
      [1, '&>', 'both'],
    ]);
  });

  it('allows redirect without spaces and before the command', () => {
    const c = parse('>out echo hi').items[0].pipeline.commands[0];
    expect(c.words.map(wordText)).toEqual(['echo', 'hi']);
    expect(wordText(c.redirects[0].target)).toBe('out');
    // A number that is not alone is a normal argument.
    expect(words('echo a2>f')).toEqual([['echo', 'a2']]);
  });

  it('parses prefix assignments', () => {
    const c = parse('FOO=bar BAZ="q x" env').items[0].pipeline.commands[0];
    expect(c.assignments.map((a) => [a.name, wordText(a.value)])).toEqual([
      ['FOO', 'bar'],
      ['BAZ', 'q x'],
    ]);
    expect(c.words.map(wordText)).toEqual(['env']);
    // After the command name, NAME=value is a plain argument.
    expect(words('echo A=1')).toEqual([['echo', 'A=1']]);
  });

  it('ignores comments', () => {
    expect(words('echo hi # comment')).toEqual([['echo', 'hi']]);
    expect(words('echo a#b')).toEqual([['echo', 'a#b']]);
  });

  it('reports syntax errors like bash', () => {
    expect(err('| ls')).toBe("bash: syntax error near unexpected token `|'");
    expect(err('ls ||| x')).toBe("bash: syntax error near unexpected token `|'");
    expect(err('ls >')).toBe("bash: syntax error near unexpected token `newline'");
    expect(err('ls && ')).toBe('bash: syntax error: unexpected end of file');
    expect(err("echo 'abc")).toBe("bash: unexpected EOF while looking for matching `''");
    expect(err('echo "abc')).toBe('bash: unexpected EOF while looking for matching `"\'');
    expect(err('; ls')).toBe("bash: syntax error near unexpected token `;'");
  });

  it('rejects unsupported features clearly', () => {
    expect(err('echo $(whoami)')).toMatch(/command substitution is not supported/);
    expect(err('echo `whoami`')).toMatch(/command substitution is not supported/);
    expect(err('sleep 10 &')).toMatch(/background jobs/);
    expect(err('cat <<EOF')).toMatch(/here-documents/);
  });

  it('parses empty input', () => {
    expect(parse('   ').items).toEqual([]);
  });
});
