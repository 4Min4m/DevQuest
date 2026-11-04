/**
 * Parser for Go's text/template language, as Helm uses it: actions with trim markers,
 * comments, pipelines, variables, if/else if/range/with/define/template/block, break/continue.
 */

export type Arg =
  | { t: 'dot'; pos: Pos }
  | { t: 'field'; path: string[]; pos: Pos }
  | { t: 'var'; name: string; path: string[]; pos: Pos }
  | { t: 'str'; v: string; pos: Pos }
  | { t: 'num'; v: number; raw: string; pos: Pos }
  | { t: 'bool'; v: boolean; pos: Pos }
  | { t: 'nil'; pos: Pos }
  | { t: 'ident'; name: string; pos: Pos }
  | { t: 'pipe'; pipe: Pipe; path: string[]; pos: Pos };

export interface Cmd {
  args: Arg[];
  pos: Pos;
}

export interface Pipe {
  decl: string[];
  /** `=` (assign to existing variables) rather than `:=`. */
  assign: boolean;
  cmds: Cmd[];
  pos: Pos;
}

export interface Pos {
  line: number;
  col: number;
}

export type Node =
  | { k: 'text'; text: string }
  | { k: 'action'; pipe: Pipe }
  | { k: 'if' | 'with' | 'range'; pipe: Pipe; list: Node[]; elseList: Node[] | null; pos: Pos }
  | { k: 'template'; name: string; pipe: Pipe | null; pos: Pos }
  | { k: 'break' | 'continue'; pos: Pos };

export class TemplateError extends Error {}

/** A parse error, worded like Go's: `parse error at (chart/templates/x.yaml:3): unexpected "}" in operand`. */
function parseError(file: string, line: number, msg: string): TemplateError {
  return new TemplateError(`parse error at (${file}:${line}): ${msg}`);
}

const KEYWORDS = new Set(['if', 'else', 'end', 'range', 'with', 'define', 'template', 'block', 'break', 'continue']);

interface Tok {
  t: 'str' | 'num' | 'field' | 'var' | 'ident' | 'kw' | 'lparen' | 'rparen' | 'pipe' | 'decl' | 'assign' | 'comma' | 'dot' | 'bool' | 'nil' | 'fieldchain';
  v: string;
  pos: Pos;
}

/** Tokenize the inside of one `{{ … }}`. */
function lexAction(src: string, file: string, start: Pos): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = start.line;
  let col = start.col;
  const adv = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    const pos = { line, col };
    if (/\s/.test(c)) {
      adv(1);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\n') throw parseError(file, line, 'unterminated quoted string');
        if (src[j] === '\\') {
          const e = src[j + 1];
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '\\' ? '\\' : e === '"' ? '"' : '\\' + e;
          j += 2;
          continue;
        }
        v += src[j++];
      }
      if (j >= src.length) throw parseError(file, line, 'unterminated quoted string');
      toks.push({ t: 'str', v, pos });
      adv(j + 1 - i);
      continue;
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw parseError(file, line, 'unterminated raw quoted string');
      toks.push({ t: 'str', v: src.slice(i + 1, j), pos });
      adv(j + 1 - i);
      continue;
    }
    if (c === "'") {
      const m = /^'(\\.|[^'])'/.exec(src.slice(i));
      if (!m) throw parseError(file, line, 'unterminated character constant');
      toks.push({ t: 'num', v: String(m[1].replace(/^\\/, '').charCodeAt(0)), pos });
      adv(m[0].length);
      continue;
    }
    const num = /^[-+]?(0x[0-9a-fA-F]+|\d+(\.\d*)?([eE][-+]?\d+)?|\.\d+)/.exec(src.slice(i));
    if (num && (/\d/.test(c) || ((c === '-' || c === '+') && /[\d.]/.test(src[i + 1] ?? '')))) {
      toks.push({ t: 'num', v: num[0], pos });
      adv(num[0].length);
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z0-9_]*((\.[A-Za-z0-9_]+)*)/.exec(src.slice(i))!;
      toks.push({ t: 'var', v: m[0], pos });
      adv(m[0].length);
      continue;
    }
    if (c === '.') {
      const m = /^(\.[A-Za-z0-9_]+)+/.exec(src.slice(i));
      const prev = toks[toks.length - 1];
      // `(…).field` — a field chain right after a closing paren.
      if (m && prev?.t === 'rparen' && prev.pos.line === line && i > 0 && src[i - 1] === ')') {
        toks.push({ t: 'fieldchain', v: m[0], pos });
        adv(m[0].length);
        continue;
      }
      if (m) {
        toks.push({ t: 'field', v: m[0], pos });
        adv(m[0].length);
        continue;
      }
      toks.push({ t: 'dot', v: '.', pos });
      adv(1);
      continue;
    }
    if (c === '(') {
      toks.push({ t: 'lparen', v: c, pos });
      adv(1);
      continue;
    }
    if (c === ')') {
      toks.push({ t: 'rparen', v: c, pos });
      adv(1);
      continue;
    }
    if (c === '|') {
      toks.push({ t: 'pipe', v: c, pos });
      adv(1);
      continue;
    }
    if (c === ',') {
      toks.push({ t: 'comma', v: c, pos });
      adv(1);
      continue;
    }
    if (src.startsWith(':=', i)) {
      toks.push({ t: 'decl', v: ':=', pos });
      adv(2);
      continue;
    }
    if (c === '=') {
      toks.push({ t: 'assign', v: '=', pos });
      adv(1);
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      const w = id[0];
      toks.push({ t: KEYWORDS.has(w) ? 'kw' : w === 'true' || w === 'false' ? 'bool' : w === 'nil' ? 'nil' : 'ident', v: w, pos });
      adv(w.length);
      continue;
    }
    throw parseError(file, line, `unexpected "${c}" in command`);
  }
  return toks;
}

interface RawAction {
  body: string;
  pos: Pos;
  /** Position just after `{{` (for token positions). */
  inner: Pos;
}

type Piece = { text: string } | { action: RawAction };

/** Split source into text and actions, applying `{{-` / `-}}` whitespace trimming and dropping comments. */
function split(src: string, file: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const posAt = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (src[k] === '\n') {
        line++;
        col = 1;
      } else col++;
    }
  };
  let trimNext = false;
  while (i < src.length) {
    const open = src.indexOf('{{', i);
    let text = open < 0 ? src.slice(i) : src.slice(i, open);
    if (trimNext) text = text.replace(/^\s+/, '');
    trimNext = false;
    if (open < 0) {
      if (text) out.push({ text });
      break;
    }
    posAt(i, open);
    const pos = { line, col };
    let bodyStart = open + 2;
    const trimLeft = src[bodyStart] === '-' && /\s/.test(src[bodyStart + 1] ?? '');
    if (trimLeft) {
      text = text.replace(/\s+$/, '');
      bodyStart += 2;
    }
    if (text) out.push({ text });
    // Find the closing `}}` outside of string literals and comments.
    let j = bodyStart;
    let close = -1;
    while (j < src.length) {
      const ch = src[j];
      if (src.startsWith('/*', j)) {
        const end = src.indexOf('*/', j + 2);
        if (end < 0) throw parseError(file, pos.line, 'unclosed comment');
        j = end + 2;
        continue;
      }
      if (ch === '"') {
        j++;
        while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        j++;
        continue;
      }
      if (ch === '`') {
        const end = src.indexOf('`', j + 1);
        j = end < 0 ? src.length : end + 1;
        continue;
      }
      if (src.startsWith('}}', j)) {
        close = j;
        break;
      }
      j++;
    }
    if (close < 0) {
      const stray = src.indexOf('}', bodyStart);
      if (stray >= 0) throw parseError(file, pos.line, "unrecognized character in action: U+007D '}'");
      throw parseError(file, pos.line, 'unclosed action');
    }
    let bodyEnd = close;
    const trimRight = src[close - 1] === '-' && /\s/.test(src[close - 2] ?? '');
    if (trimRight) bodyEnd = close - 2;
    const body = src.slice(bodyStart, bodyEnd);
    posAt(open, bodyStart);
    const inner = { line, col };
    posAt(bodyStart, close + 2);
    i = close + 2;
    trimNext = trimRight;
    if (/^\s*\/\*[\s\S]*\*\/\s*$/.test(body)) continue;
    out.push({ action: { body, pos, inner } });
  }
  return out;
}

class TokStream {
  i = 0;
  constructor(
    public toks: Tok[],
    public file: string,
    public line: number,
  ) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  next(): Tok | undefined {
    return this.toks[this.i++];
  }
  err(msg: string): TemplateError {
    return parseError(this.file, this.line, msg);
  }
}

function parsePipe(ts: TokStream, end: (t: Tok | undefined) => boolean): Pipe {
  const pos = ts.peek()?.pos ?? { line: ts.line, col: 0 };
  const pipe: Pipe = { decl: [], assign: false, cmds: [], pos };
  // Variable declarations: `$x :=`, `$i, $v :=`, `$x =`
  const save = ts.i;
  const vars: string[] = [];
  while (ts.peek()?.t === 'var' && !ts.peek()!.v.includes('.', 1)) {
    vars.push(ts.next()!.v);
    if (ts.peek()?.t === 'comma') {
      ts.next();
      continue;
    }
    break;
  }
  if (vars.length && (ts.peek()?.t === 'decl' || ts.peek()?.t === 'assign')) {
    pipe.assign = ts.next()!.t === 'assign';
    pipe.decl = vars;
  } else ts.i = save;
  let cmd: Cmd = { args: [], pos: ts.peek()?.pos ?? pos };
  for (;;) {
    const t = ts.peek();
    if (end(t)) break;
    ts.next();
    if (t!.t === 'pipe') {
      if (!cmd.args.length) throw ts.err('missing command');
      pipe.cmds.push(cmd);
      cmd = { args: [], pos: ts.peek()?.pos ?? t!.pos };
      continue;
    }
    cmd.args.push(operand(ts, t!));
  }
  if (cmd.args.length) pipe.cmds.push(cmd);
  else if (pipe.cmds.length) throw ts.err('missing command');
  return pipe;
}

function operand(ts: TokStream, t: Tok): Arg {
  const fields = (s: string) => s.split('.').filter(Boolean);
  switch (t.t) {
    case 'str':
      return { t: 'str', v: t.v, pos: t.pos };
    case 'num': {
      const v = t.v.startsWith('0x') || t.v.startsWith('-0x') ? parseInt(t.v, 16) : Number(t.v);
      if (Number.isNaN(v)) throw ts.err(`illegal number syntax: "${t.v}"`);
      return { t: 'num', v, raw: t.v, pos: t.pos };
    }
    case 'bool':
      return { t: 'bool', v: t.v === 'true', pos: t.pos };
    case 'nil':
      return { t: 'nil', pos: t.pos };
    case 'dot':
      return { t: 'dot', pos: t.pos };
    case 'field':
      return { t: 'field', path: fields(t.v), pos: t.pos };
    case 'var': {
      const [name, ...rest] = t.v.split('.');
      return { t: 'var', name, path: rest, pos: t.pos };
    }
    case 'ident':
      return { t: 'ident', name: t.v, pos: t.pos };
    case 'lparen': {
      const inner = parsePipe(ts, (x) => !x || x.t === 'rparen');
      if (ts.next()?.t !== 'rparen') throw ts.err('unclosed left paren');
      let path: string[] = [];
      if (ts.peek()?.t === 'fieldchain') path = fields(ts.next()!.v);
      return { t: 'pipe', pipe: inner, path, pos: t.pos };
    }
    case 'kw':
      throw ts.err(`unexpected <${t.v}> in operand`);
    default:
      throw ts.err(`unexpected "${t.v}" in operand`);
  }
}

export interface Parsed {
  root: Node[];
  defines: Record<string, Node[]>;
}

/** Parse a template file. `file` is its name in error messages (e.g. "mychart/templates/svc.yaml"). */
export function parseTemplate(src: string, file: string): Parsed {
  const pieces = split(src, file);
  const defines: Record<string, Node[]> = {};
  let idx = 0;

  type Stop = { kw: 'end' | 'else'; elsePipe?: { kw: string; ts: TokStream } };

  const parseList = (inBlock: string | null): { list: Node[]; stop: Stop | null } => {
    const list: Node[] = [];
    while (idx < pieces.length) {
      const p = pieces[idx++];
      if ('text' in p) {
        list.push({ k: 'text', text: p.text });
        continue;
      }
      const a = p.action;
      const toks = lexAction(a.body, file, a.inner);
      const ts = new TokStream(toks, file, a.pos.line);
      const first = toks[0];
      if (!first) throw parseError(file, a.pos.line, 'missing value for command');
      if (first.t === 'kw') {
        ts.next();
        switch (first.v) {
          case 'end':
            if (!inBlock) throw parseError(file, a.pos.line, 'unexpected {{end}}');
            if (ts.peek()) throw parseError(file, a.pos.line, `unexpected "${ts.peek()!.v}" in end`);
            return { list, stop: { kw: 'end' } };
          case 'else':
            if (!inBlock || inBlock === 'define') throw parseError(file, a.pos.line, 'unexpected {{else}}');
            return { list, stop: { kw: 'else', elsePipe: ts.peek() ? { kw: ts.peek()!.v, ts } : undefined } };
          case 'if':
          case 'with':
          case 'range':
            list.push(parseControl(first.v, ts, a.pos));
            continue;
          case 'define':
          case 'block': {
            const nameTok = ts.next();
            if (nameTok?.t !== 'str') throw parseError(file, a.pos.line, `unexpected "${nameTok?.v ?? ''}" in ${first.v} clause`);
            const pipe = first.v === 'block' ? parsePipe(ts, (x) => !x) : null;
            const body = parseList('define');
            if (body.stop?.kw !== 'end') throw parseError(file, a.pos.line, `unexpected EOF`);
            defines[nameTok.v] = body.list;
            if (first.v === 'block') list.push({ k: 'template', name: nameTok.v, pipe, pos: a.pos });
            continue;
          }
          case 'template': {
            const nameTok = ts.next();
            if (nameTok?.t !== 'str') throw parseError(file, a.pos.line, `unexpected "${nameTok?.v ?? ''}" in template clause`);
            const pipe = ts.peek() ? parsePipe(ts, (x) => !x) : null;
            list.push({ k: 'template', name: nameTok.v, pipe, pos: a.pos });
            continue;
          }
          case 'break':
          case 'continue':
            list.push({ k: first.v, pos: a.pos });
            continue;
        }
      }
      const pipe = parsePipe(ts, (x) => !x);
      if (!pipe.cmds.length) throw parseError(file, a.pos.line, 'missing value for command');
      list.push({ k: 'action', pipe });
    }
    if (inBlock) throw parseError(file, pieces.length ? lastLine() : 1, 'unexpected EOF');
    return { list, stop: null };
  };

  const lastLine = () => src.split('\n').length;

  const parseControl = (kw: string, ts: TokStream, pos: Pos): Node => {
    const pipe = parsePipe(ts, (x) => !x);
    if (!pipe.cmds.length) throw parseError(file, pos.line, `missing value for ${kw}`);
    const body = parseList(kw);
    let elseList: Node[] | null = null;
    if (body.stop?.kw === 'else') {
      if (body.stop.elsePipe && (body.stop.elsePipe.kw === 'if' || body.stop.elsePipe.kw === 'with')) {
        // `else if` / `else with`: a nested control node that consumes the shared {{end}}.
        const ets = body.stop.elsePipe.ts;
        const k2 = ets.next()!.v;
        elseList = [parseControl(k2, ets, pos)];
      } else {
        const rest = parseList(kw);
        if (rest.stop?.kw !== 'end') throw parseError(file, pos.line, 'expected end; found else');
        elseList = rest.list;
      }
    }
    return { k: kw as 'if' | 'with' | 'range', pipe, list: body.list, elseList, pos };
  };

  const top = parseList(null);
  return { root: top.list, defines };
}
