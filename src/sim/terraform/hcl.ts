/** An HCL2 parser: bodies (attributes and blocks) and the expression language. */

export interface Pos {
  line: number;
  col: number;
}

export type Expr = (
  | { t: 'lit'; v: unknown }
  | { t: 'tmpl'; parts: (string | Expr)[] }
  | { t: 'var'; name: string }
  | { t: 'get'; obj: Expr; key: string }
  | { t: 'index'; obj: Expr; idx: Expr }
  | { t: 'splat'; obj: Expr; rest: ((e: Expr) => Expr) | null; restSrc: { kind: 'get' | 'index'; key?: string; idx?: Expr }[] }
  | { t: 'list'; items: Expr[] }
  | { t: 'obj'; items: { key: Expr; value: Expr }[] }
  | { t: 'call'; name: string; args: Expr[]; expand: boolean }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'un'; op: string; e: Expr }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'for'; obj: boolean; k?: string; v: string; coll: Expr; key?: Expr; val: Expr; cond?: Expr; group?: boolean }
) & { pos: Pos; src?: string };

export interface Attr {
  name: string;
  expr: Expr;
  pos: Pos;
  /** Source text of the whole line (for error snippets). */
  line: string;
}

export interface Block {
  type: string;
  labels: string[];
  body: Body;
  pos: Pos;
  line: string;
}

export interface Body {
  attrs: Attr[];
  blocks: Block[];
}

export class HclError extends Error {
  constructor(public summary: string, public detail: string, public pos: Pos, public file = '') {
    super(summary);
  }
}

const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
const isId = (c: string) => /[\w-]/.test(c);

export class Parser {
  private i = 0;
  private lines: string[];
  constructor(private s: string, private file: string) {
    this.lines = s.split('\n');
  }

  private pos(at = this.i): Pos {
    let line = 1;
    let last = 0;
    for (let k = 0; k < at && k < this.s.length; k++) if (this.s[k] === '\n') {
      line++;
      last = k + 1;
    }
    return { line, col: at - last + 1 };
  }

  private err(summary: string, detail: string, at = this.i): never {
    throw new HclError(summary, detail, this.pos(at), this.file);
  }

  /** Skip spaces and comments; newlines too when `nl`. */
  private ws(nl: boolean) {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\r' || (nl && c === '\n')) this.i++;
      else if (c === '#' || (c === '/' && this.s[this.i + 1] === '/')) {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      } else if (c === '/' && this.s[this.i + 1] === '*') {
        const j = this.s.indexOf('*/', this.i + 2);
        this.i = j < 0 ? this.s.length : j + 2;
      } else return;
    }
  }

  private peek(str: string): boolean {
    return this.s.startsWith(str, this.i);
  }

  private ident(): string {
    const st = this.i;
    if (!isIdStart(this.s[this.i] ?? '')) return '';
    while (this.i < this.s.length && isId(this.s[this.i])) this.i++;
    return this.s.slice(st, this.i);
  }

  parseBody(end?: string): Body {
    const body: Body = { attrs: [], blocks: [] };
    for (;;) {
      this.ws(true);
      if (this.i >= this.s.length) {
        if (end) this.err('Unclosed configuration block', 'There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.');
        return body;
      }
      if (end && this.peek(end)) {
        this.i++;
        return body;
      }
      const start = this.i;
      const p = this.pos();
      const name = this.ident();
      if (!name) this.err('Argument or block definition required', 'An argument or block definition is required here.');
      this.ws(false);
      if (this.peek('=') && !this.peek('==')) {
        this.i++;
        this.ws(false);
        const expr = this.expr(false);
        body.attrs.push({ name, expr, pos: p, line: this.lines[p.line - 1] });
        this.ws(false);
        if (this.i < this.s.length && this.s[this.i] !== '\n' && !(end && this.peek(end))) this.err('Missing newline after argument', 'An argument definition must end with a newline.');
        continue;
      }
      const labels: string[] = [];
      for (;;) {
        this.ws(false);
        if (this.peek('"')) labels.push(this.simpleString());
        else if (isIdStart(this.s[this.i] ?? '')) labels.push(this.ident());
        else break;
      }
      this.ws(false);
      if (!this.peek('{')) {
        if (this.peek(':')) this.err('Argument or block definition required', 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.');
        this.err(labels.length ? 'Invalid block definition' : 'Argument or block definition required', labels.length ? 'Either a quoted string block label or an opening brace ("{") is expected here.' : 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.');
      }
      this.i++;
      const inner = this.parseBody('}');
      body.blocks.push({ type: name, labels, body: inner, pos: p, line: this.lines[p.line - 1] });
      void start;
    }
  }

  private simpleString(): string {
    const st = this.i;
    this.i++;
    let out = '';
    while (this.i < this.s.length && this.s[this.i] !== '"') {
      if (this.s[this.i] === '\n') this.err('Invalid block definition', 'A block label must be a quoted string on the same line.', st);
      out += this.s[this.i++];
    }
    this.i++;
    return out;
  }

  // ---------------------------------------------------------------- expressions

  expr(nl: boolean): Expr {
    const p = this.pos();
    const st = this.i;
    const c = this.binary(0, nl);
    this.ws(nl);
    if (this.peek('?')) {
      this.i++;
      this.ws(true);
      const a = this.expr(true);
      this.ws(true);
      if (!this.peek(':')) this.err('Missing false expression in conditional', 'The conditional operator (...?...:...) requires a false expression, delimited by a colon.');
      this.i++;
      this.ws(true);
      const b = this.expr(nl);
      return { t: 'cond', c, a, b, pos: p, src: this.s.slice(st, this.i) };
    }
    return c;
  }

  private static PREC: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

  private binary(min: number, nl: boolean): Expr {
    let l = this.unary(nl);
    for (;;) {
      this.ws(nl);
      const op = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%'].find((o) => this.peek(o));
      if (!op || (op === '/' && (this.peek('//') || this.peek('/*')))) return l;
      const prec = Parser.PREC[op];
      if (prec <= min) return l;
      const p = this.pos();
      this.i += op.length;
      this.ws(true);
      const r = this.binary(prec, nl);
      l = { t: 'bin', op, l, r, pos: p };
    }
  }

  private unary(nl: boolean): Expr {
    const p = this.pos();
    if (this.peek('!') || (this.peek('-') && !/\d/.test(this.s[this.i + 1] ?? ''))) {
      const op = this.s[this.i++];
      this.ws(nl);
      return { t: 'un', op, e: this.unary(nl), pos: p };
    }
    return this.postfix(nl);
  }

  private postfix(nl: boolean): Expr {
    const st = this.i;
    let e = this.primary();
    for (;;) {
      const p = this.pos();
      if (this.peek('.') && !this.peek('..')) {
        this.i++;
        if (this.peek('*')) {
          this.i++;
          e = this.splat(e, p, true);
          continue;
        }
        if (/\d/.test(this.s[this.i] ?? '')) {
          const n = /^\d+/.exec(this.s.slice(this.i))![0];
          this.i += n.length;
          e = { t: 'index', obj: e, idx: { t: 'lit', v: Number(n), pos: p }, pos: p };
          continue;
        }
        const k = this.ident();
        if (!k) this.err('Invalid attribute name', 'An attribute name is required after a dot.');
        e = { t: 'get', obj: e, key: k, pos: p };
      } else if (this.peek('[')) {
        this.i++;
        this.ws(true);
        if (this.peek('*')) {
          this.i++;
          this.ws(true);
          if (!this.peek(']')) this.err('Invalid splat', 'Expected "]".');
          this.i++;
          e = this.splat(e, p, false);
          continue;
        }
        const idx = this.expr(true);
        this.ws(true);
        if (!this.peek(']')) this.err('Missing close bracket on index', 'The index operator must end with a closing bracket ("]").');
        this.i++;
        e = { t: 'index', obj: e, idx, pos: p };
      } else break;
    }
    void nl;
    if (e.t === 'get' || e.t === 'index' || e.t === 'var') e.src = this.s.slice(st, this.i);
    return e;
  }

  /** `list[*].attr` / `list.*.attr`: the attribute traversal after the splat applies per element. */
  private splat(obj: Expr, p: Pos, legacy: boolean): Expr {
    const restSrc: { kind: 'get' | 'index'; key?: string; idx?: Expr }[] = [];
    for (;;) {
      if (this.peek('.') && isIdStart(this.s[this.i + 1] ?? '')) {
        this.i++;
        restSrc.push({ kind: 'get', key: this.ident() });
      } else if (!legacy && this.peek('[')) {
        this.i++;
        const idx = this.expr(true);
        this.ws(true);
        this.i++;
        restSrc.push({ kind: 'index', idx });
      } else break;
    }
    return { t: 'splat', obj, rest: null, restSrc, pos: p };
  }

  private primary(): Expr {
    const p = this.pos();
    const c = this.s[this.i];
    if (c === undefined) this.err('Invalid expression', 'Expected the start of an expression, but found the end of the file.');
    if (c === '"') return this.template();
    if (this.peek('<<')) return this.heredoc();
    if (/\d/.test(c) || (c === '-' && /\d/.test(this.s[this.i + 1] ?? ''))) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i))!;
      this.i += m[0].length;
      return { t: 'lit', v: Number(m[0]), pos: p };
    }
    if (c === '(') {
      this.i++;
      this.ws(true);
      const e = this.expr(true);
      this.ws(true);
      if (!this.peek(')')) this.err('Unbalanced parentheses', 'Expected a closing parenthesis to terminate the expression.');
      this.i++;
      return e;
    }
    if (c === '[') return this.list();
    if (c === '{') return this.object();
    if (isIdStart(c)) {
      const name = this.ident();
      if (name === 'true' || name === 'false') return { t: 'lit', v: name === 'true', pos: p };
      if (name === 'null') return { t: 'lit', v: null, pos: p };
      if (this.peek('(')) {
        this.i++;
        const args: Expr[] = [];
        let expand = false;
        for (;;) {
          this.ws(true);
          if (this.peek(')')) {
            this.i++;
            break;
          }
          args.push(this.expr(true));
          this.ws(true);
          if (this.peek('...')) {
            expand = true;
            this.i += 3;
            this.ws(true);
          }
          if (this.peek(',')) this.i++;
          else if (!this.peek(')')) this.err('Missing argument separator', 'A comma is required to separate each function argument from the next.');
        }
        return { t: 'call', name, args, expand, pos: p };
      }
      return { t: 'var', name, pos: p };
    }
    this.err('Invalid expression', 'Expected the start of an expression, but found an invalid expression token.');
  }

  private list(): Expr {
    const p = this.pos();
    this.i++;
    this.ws(true);
    if (this.peek('for') && /\s/.test(this.s[this.i + 3] ?? '')) return this.forExpr(p, false);
    const items: Expr[] = [];
    for (;;) {
      this.ws(true);
      if (this.peek(']')) {
        this.i++;
        return { t: 'list', items, pos: p };
      }
      items.push(this.expr(true));
      this.ws(true);
      if (this.peek(',')) this.i++;
      else if (!this.peek(']')) this.err('Missing item separator', 'Expected a comma to mark the beginning of the next item.');
    }
  }

  private object(): Expr {
    const p = this.pos();
    this.i++;
    this.ws(true);
    if (this.peek('for') && /\s/.test(this.s[this.i + 3] ?? '')) return this.forExpr(p, true);
    const items: { key: Expr; value: Expr }[] = [];
    for (;;) {
      this.ws(true);
      if (this.peek('}')) {
        this.i++;
        return { t: 'obj', items, pos: p };
      }
      const kp = this.pos();
      let key: Expr;
      if (isIdStart(this.s[this.i] ?? '')) {
        const save = this.i;
        const id = this.ident();
        this.ws(false);
        if (this.peek('=') || this.peek(':')) key = { t: 'lit', v: id, pos: kp };
        else {
          this.i = save;
          key = this.expr(true);
        }
      } else key = this.expr(true);
      this.ws(false);
      if (!this.peek('=') && !this.peek(':')) this.err('Missing key/value separator', 'Expected an equals sign ("=") to mark the beginning of the attribute value.');
      this.i++;
      this.ws(true);
      const value = this.expr(true);
      items.push({ key, value });
      this.ws(false);
      if (this.peek(',')) this.i++;
      this.ws(true);
    }
  }

  private forExpr(p: Pos, obj: boolean): Expr {
    this.i += 3;
    this.ws(true);
    let k: string | undefined;
    let v = this.ident();
    this.ws(true);
    if (this.peek(',')) {
      this.i++;
      this.ws(true);
      k = v;
      v = this.ident();
      this.ws(true);
    }
    if (!this.peek('in')) this.err('Invalid "for" expression', 'The "for" keyword must be followed by one or two variable names and then the "in" keyword.');
    this.i += 2;
    this.ws(true);
    const coll = this.expr(true);
    this.ws(true);
    if (!this.peek(':')) this.err('Invalid "for" expression', 'The "in" clause must be followed by a colon.');
    this.i++;
    this.ws(true);
    let key: Expr | undefined;
    let val: Expr;
    if (obj) {
      key = this.expr(true);
      this.ws(true);
      if (!this.peek('=>')) this.err('Invalid "for" expression', 'In an object "for" expression, the key expression must be followed by "=>".');
      this.i += 2;
      this.ws(true);
      val = this.expr(true);
    } else val = this.expr(true);
    this.ws(true);
    let group = false;
    if (this.peek('...')) {
      group = true;
      this.i += 3;
      this.ws(true);
    }
    let cond: Expr | undefined;
    if (this.peek('if') && /\s/.test(this.s[this.i + 2] ?? '')) {
      this.i += 2;
      this.ws(true);
      cond = this.expr(true);
      this.ws(true);
    }
    const close = obj ? '}' : ']';
    if (!this.peek(close)) this.err('Invalid "for" expression', `Expected "${close}".`);
    this.i++;
    return { t: 'for', obj, k, v, coll, key, val, cond, group, pos: p };
  }

  private template(): Expr {
    const p = this.pos();
    this.i++;
    const parts: (string | Expr)[] = [];
    let buf = '';
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined || c === '\n') this.err('Unterminated template string', 'No closing marker was found for the string.', this.i);
      if (c === '"') {
        this.i++;
        break;
      }
      if (c === '\\') {
        const n = this.s[this.i + 1];
        buf += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        this.i += 2;
        continue;
      }
      if (this.peek('$${')) {
        buf += '${';
        this.i += 3;
        continue;
      }
      if (this.peek('${')) {
        if (buf) parts.push(buf);
        buf = '';
        this.i += 2;
        this.ws(true);
        parts.push(this.expr(true));
        this.ws(true);
        if (!this.peek('}')) this.err('Extra characters after interpolation expression', 'Expected a closing brace to end the interpolation expression, but found extra characters.');
        this.i++;
        continue;
      }
      buf += c;
      this.i++;
    }
    if (buf || !parts.length) parts.push(buf);
    if (parts.length === 1 && typeof parts[0] === 'string') return { t: 'lit', v: parts[0], pos: p };
    return { t: 'tmpl', parts, pos: p };
  }

  private heredoc(): Expr {
    const p = this.pos();
    this.i += 2;
    const strip = this.peek('-');
    if (strip) this.i++;
    const marker = this.ident();
    if (!marker) this.err('Invalid heredoc', 'Expected an identifier after <<.');
    const nl = this.s.indexOf('\n', this.i);
    this.i = nl + 1;
    const lines: string[] = [];
    for (;;) {
      if (this.i >= this.s.length) this.err('Unterminated template string', `No closing marker "${marker}" was found for the heredoc.`, this.i);
      const e = this.s.indexOf('\n', this.i);
      const line = this.s.slice(this.i, e < 0 ? this.s.length : e);
      this.i = e < 0 ? this.s.length : e + 1;
      if (line.trim() === marker) break;
      lines.push(line);
    }
    // The closing marker's line break belongs to the attribute.
    this.i--;
    if (this.s[this.i] !== '\n') this.i++;
    let text = lines;
    if (strip) {
      const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
      text = lines.map((l) => l.slice(Math.min(ind, /^\s*/.exec(l)![0].length)));
    }
    const sub = new Parser('"' + text.join('\n').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '\\n"', this.file);
    const e = sub.template();
    e.pos = p;
    return e;
  }
}

export function parseHcl(src: string, file: string): Body {
  return new Parser(src, file).parseBody();
}

/** The traversal path of a reference (`aws_instance.web[0].id` → ["aws_instance", "web", 0, "id"]), or null. */
export function refPath(e: Expr): (string | number | Expr)[] | null {
  if (e.t === 'var') return [e.name];
  if (e.t === 'get') {
    const b = refPath(e.obj);
    return b ? [...b, e.key] : null;
  }
  if (e.t === 'index') {
    const b = refPath(e.obj);
    if (!b) return null;
    return [...b, e.idx.t === 'lit' && (typeof e.idx.v === 'number' || typeof e.idx.v === 'string') ? e.idx.v : e.idx];
  }
  if (e.t === 'splat') return refPath(e.obj);
  return null;
}

/** Every reference (variable traversal) inside an expression. */
export function references(e: Expr | undefined, out: { path: (string | number | Expr)[]; pos: Pos; src: string }[] = []): typeof out {
  if (!e) return out;
  switch (e.t) {
    case 'var':
    case 'get':
    case 'index': {
      const p = refPath(e);
      if (p) {
        out.push({ path: p, pos: e.pos, src: e.src ?? '' });
        for (const seg of p) if (typeof seg === 'object') references(seg, out);
        return out;
      }
      if (e.t === 'get') references(e.obj, out);
      if (e.t === 'index') {
        references(e.obj, out);
        references(e.idx, out);
      }
      return out;
    }
    case 'splat':
      references(e.obj, out);
      for (const r of e.restSrc) if (r.idx) references(r.idx, out);
      return out;
    case 'tmpl':
      for (const part of e.parts) if (typeof part !== 'string') references(part, out);
      return out;
    case 'list':
      e.items.forEach((x) => references(x, out));
      return out;
    case 'obj':
      e.items.forEach((x) => {
        if (x.key.t !== 'lit' && x.key.t !== 'var') references(x.key, out);
        references(x.value, out);
      });
      return out;
    case 'call':
      e.args.forEach((x) => references(x, out));
      return out;
    case 'bin':
      references(e.l, out);
      references(e.r, out);
      return out;
    case 'un':
      return references(e.e, out);
    case 'cond':
      references(e.c, out);
      references(e.a, out);
      references(e.b, out);
      return out;
    case 'for': {
      const inner: typeof out = [];
      references(e.coll, out);
      references(e.key, inner);
      references(e.val, inner);
      references(e.cond, inner);
      for (const r of inner) if (r.path[0] !== e.v && r.path[0] !== e.k) out.push(r);
      return out;
    }
  }
  return out;
}
