import type {
  Assignment,
  ListItem,
  ListOp,
  Pipeline,
  Redirect,
  RedirectOp,
  Script,
  SimpleCommand,
  Word,
  WordPart,
} from './ast';

/** Raised for syntax errors. `message` is already formatted the way bash prints it. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

type Token =
  | { kind: 'word'; word: Word }
  | { kind: 'op'; op: string; fd?: number };

const REDIRECT_OPS = new Set(['>', '>>', '<', '>&', '&>', '&>>']);

function unsupported(feature: string): ParseError {
  return new ParseError(`devquest: ${feature} is not supported in this simulator`);
}

function nearToken(tok: string): ParseError {
  return new ParseError(`bash: syntax error near unexpected token \`${tok}'`);
}

// ---------------------------------------------------------------- lexer

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let parts: WordPart[] | null = null;
  let i = 0;

  const push = (text: string, quote: WordPart['quote']) => {
    if (!parts) parts = [];
    const last = parts[parts.length - 1];
    if (last && last.quote === quote) last.text += text;
    else parts.push({ text, quote });
  };
  const endWord = () => {
    if (parts) tokens.push({ kind: 'word', word: { parts } });
    parts = null;
  };
  const op = (o: string, fd?: number) => {
    endWord();
    tokens.push(fd === undefined ? { kind: 'op', op: o } : { kind: 'op', op: o, fd });
  };
  /** If the word so far is a bare number (e.g. the `2` in `2>`), consume it as an fd. */
  const takeFd = (): number | undefined => {
    const p = parts as WordPart[] | null;
    if (p && p.length === 1 && p[0].quote === 'none' && /^\d+$/.test(p[0].text)) {
      parts = null;
      return Number(p[0].text);
    }
    return undefined;
  };

  while (i < input.length) {
    const c = input[i];
    const next = input[i + 1];

    if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (c === '\n') {
      op(';');
      i++;
    } else if (c === '#' && !parts) {
      while (i < input.length && input[i] !== '\n') i++;
    } else if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new ParseError("bash: unexpected EOF while looking for matching `''");
      push(input.slice(i + 1, end), 'literal');
      i = end + 1;
    } else if (c === '"') {
      i++;
      if (!parts) parts = [];
      // An empty "" must still produce an (empty) argument.
      push('', 'double');
      let closed = false;
      while (i < input.length) {
        const d = input[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\\' && i + 1 < input.length && '$`"\\\n'.includes(input[i + 1])) {
          if (input[i + 1] !== '\n') push(input[i + 1], 'literal');
          i += 2;
          continue;
        }
        if (d === '`' || (d === '$' && input[i + 1] === '(')) throw unsupported('command substitution');
        push(d, 'double');
        i++;
      }
      if (!closed) throw new ParseError('bash: unexpected EOF while looking for matching `"\'');
    } else if (c === '\\') {
      if (next !== undefined && next !== '\n') push(next, 'literal');
      i += 2;
    } else if (c === '`' || (c === '$' && next === '(')) {
      throw unsupported('command substitution');
    } else if (c === '|') {
      if (next === '|') {
        op('||');
        i += 2;
      } else if (next === '&') {
        throw unsupported("'|&'");
      } else {
        op('|');
        i++;
      }
    } else if (c === '&') {
      if (next === '&') {
        op('&&');
        i += 2;
      } else if (next === '>') {
        if (input[i + 2] === '>') {
          op('&>>');
          i += 3;
        } else {
          op('&>');
          i += 2;
        }
      } else {
        throw unsupported("background jobs ('&')");
      }
    } else if (c === ';') {
      op(';');
      i++;
    } else if (c === '>') {
      const fd = takeFd();
      if (next === '>') {
        op('>>', fd ?? 1);
        i += 2;
      } else if (next === '&') {
        op('>&', fd ?? 1);
        i += 2;
      } else {
        op('>', fd ?? 1);
        i += next === '|' ? 2 : 1;
      }
    } else if (c === '<') {
      const fd = takeFd();
      if (next === '<') throw unsupported("here-documents ('<<')");
      op('<', fd ?? 0);
      i++;
    } else if (c === '(' || c === ')') {
      op(c);
      i++;
    } else {
      push(c, 'none');
      i++;
    }
  }
  endWord();
  return tokens;
}

// ---------------------------------------------------------------- parser

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function asAssignment(word: Word): Assignment | null {
  const first = word.parts[0];
  if (!first || first.quote !== 'none') return null;
  const m = ASSIGN_RE.exec(first.text);
  if (!m) return null;
  const rest = first.text.slice(m[0].length);
  const parts = [...(rest ? [{ text: rest, quote: 'none' as const }] : []), ...word.parts.slice(1)];
  return { name: m[1], value: { parts } };
}

export function parse(input: string): Script {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];

  const parseCommand = (): SimpleCommand => {
    const cmd: SimpleCommand = { assignments: [], words: [], redirects: [] };
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.kind === 'word') {
        const asg = cmd.words.length === 0 ? asAssignment(tok.word) : null;
        if (asg) cmd.assignments.push(asg);
        else cmd.words.push(tok.word);
        pos++;
      } else if (REDIRECT_OPS.has(tok.op)) {
        pos++;
        const target = tokens[pos];
        if (!target) throw nearToken('newline');
        if (target.kind !== 'word') throw nearToken(target.op);
        cmd.redirects.push({ fd: tok.fd ?? 1, op: tok.op as RedirectOp, target: target.word } as Redirect);
        pos++;
      } else {
        break;
      }
    }
    if (!cmd.words.length && !cmd.assignments.length && !cmd.redirects.length) {
      const tok = peek();
      throw nearToken(tok ? (tok.kind === 'op' ? tok.op : 'newline') : 'newline');
    }
    return cmd;
  };

  const parsePipeline = (): Pipeline => {
    const commands = [parseCommand()];
    while (peek()?.kind === 'op' && (peek() as { op: string }).op === '|') {
      pos++;
      if (pos >= tokens.length) throw new ParseError('bash: syntax error: unexpected end of file');
      commands.push(parseCommand());
    }
    return { commands };
  };

  const items: ListItem[] = [];
  let op: ListOp | null = null;
  while (pos < tokens.length) {
    // Allow empty statements like a leading or doubled `;` only at the very end.
    items.push({ op, pipeline: parsePipeline() });
    const tok = peek();
    if (!tok) break;
    if (tok.kind !== 'op' || !(tok.op === ';' || tok.op === '&&' || tok.op === '||')) {
      throw nearToken(tok.kind === 'op' ? tok.op : 'newline');
    }
    pos++;
    op = tok.op as ListOp;
    if (pos >= tokens.length) {
      if (op === ';') break;
      throw new ParseError('bash: syntax error: unexpected end of file');
    }
  }
  return { items };
}
