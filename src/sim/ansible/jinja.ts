/** A Jinja2 subset for Ansible: expressions, filters, tests, {% if %} / {% for %} templates. */

export class Undefined {
  constructor(public readonly name: string) {}
}

export class TemplateError extends Error {}

export type Vars = Record<string, unknown>;

type Tok = { t: 'num' | 'str' | 'name' | 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[++j];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new TemplateError('unexpected end of template, expected end of string');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][\w]*/.exec(src.slice(i));
    if (name) {
      out.push({ t: 'name', v: name[0] });
      i += name[0].length;
      continue;
    }
    const op = /^(==|!=|<=|>=|\/\/|\*\*|[-+*/%<>|.,()[\]{}:~])/.exec(src.slice(i));
    if (!op) throw new TemplateError(`unexpected char '${c}'`);
    out.push({ t: 'op', v: op[0] });
    i += op[0].length;
  }
  return out;
}

const truthy = (v: unknown): boolean => {
  if (v instanceof Undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'string') return v.length > 0;
  return !!v;
};

export function toBool(v: unknown): boolean {
  if (typeof v === 'string') return ['yes', 'true', 'on', '1', 'y'].includes(v.toLowerCase());
  return truthy(v);
}

/** Python-ish string form (lists and dicts print like Python). */
export function pyStr(v: unknown): string {
  if (v instanceof Undefined) throw new TemplateError(`'${v.name}' is undefined`);
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (typeof v === 'object') return '{' + Object.entries(v as object).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ') + '}';
  return String(v);
}

function pyRepr(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : pyStr(v);
}

const strict = (v: unknown): unknown => {
  if (v instanceof Undefined) throw new TemplateError(`'${v.name}' is undefined`);
  return v;
};

const FILTERS: Record<string, (v: unknown, ...a: unknown[]) => unknown> = {
  default: (v, d = '', b = false) => (v instanceof Undefined || (b && !truthy(v)) ? d : v),
  upper: (v) => pyStr(v).toUpperCase(),
  lower: (v) => pyStr(v).toLowerCase(),
  title: (v) => pyStr(v).replace(/\b\w/g, (c) => c.toUpperCase()),
  capitalize: (v) => pyStr(v).charAt(0).toUpperCase() + pyStr(v).slice(1).toLowerCase(),
  trim: (v) => pyStr(v).trim(),
  replace: (v, a, b) => pyStr(v).split(String(a)).join(String(b)),
  join: (v, sep = '') => (strict(v) as unknown[]).map(pyStr).join(String(sep)),
  length: (v) => (Array.isArray(strict(v)) || typeof v === 'string' ? (v as string).length : Object.keys(v as object).length),
  int: (v) => parseInt(pyStr(v), 10) || 0,
  float: (v) => parseFloat(pyStr(v)) || 0,
  string: (v) => pyStr(v),
  bool: (v) => toBool(strict(v)),
  first: (v) => (strict(v) as unknown[])[0],
  last: (v) => (strict(v) as unknown[]).slice(-1)[0],
  list: (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [...v] : Object.keys(strict(v) as object)),
  unique: (v) => [...new Set(strict(v) as unknown[])],
  sort: (v) => [...(strict(v) as unknown[])].sort(),
  min: (v) => Math.min(...(strict(v) as number[])),
  max: (v) => Math.max(...(strict(v) as number[])),
  sum: (v) => (strict(v) as number[]).reduce((a, b) => a + b, 0),
  to_json: (v) => JSON.stringify(strict(v)),
  to_nice_json: (v) => JSON.stringify(strict(v), null, 4),
  to_yaml: (v) => pyStr(v),
  quote: (v) => `'${pyStr(v).replace(/'/g, `'"'"'`)}'`,
  b64encode: (v) => btoa(pyStr(v)),
  dict2items: (v) => Object.entries(strict(v) as object).map(([key, value]) => ({ key, value })),
  items2dict: (v) => Object.fromEntries((strict(v) as { key: string; value: unknown }[]).map((x) => [x.key, x.value])),
  regex_replace: (v, a, b = '') => pyStr(v).replace(new RegExp(String(a), 'g'), String(b).replace(/\\(\d)/g, '$$$1')),
  mandatory: (v) => strict(v),
};
FILTERS.d = FILTERS.default;
FILTERS.count = FILTERS.length;

let depth = 0;

class Parser {
  private i = 0;
  constructor(private toks: Tok[], private vars: Vars) {}

  private peek(v?: string): boolean {
    const t = this.toks[this.i];
    return !!t && (v === undefined || t.v === v) && (t.t === 'op' || t.t === 'name');
  }
  private take(v: string): void {
    if (!this.peek(v)) throw new TemplateError(`expected '${v}'`);
    this.i++;
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }

  expr(): unknown {
    const v = this.or();
    if (this.peek('if')) {
      this.i++;
      const cond = this.or();
      let alt: unknown = new Undefined('else');
      if (this.peek('else')) {
        this.i++;
        alt = this.or();
      }
      return truthy(cond) ? v : alt;
    }
    return v;
  }
  private or(): unknown {
    let v = this.and();
    while (this.peek('or')) {
      this.i++;
      const r = this.and();
      v = truthy(v) ? v : r;
    }
    return v;
  }
  private and(): unknown {
    let v = this.not();
    while (this.peek('and')) {
      this.i++;
      const r = this.not();
      v = truthy(v) ? r : v;
    }
    return v;
  }
  private not(): unknown {
    if (this.peek('not')) {
      this.i++;
      return !truthy(this.not());
    }
    return this.cmp();
  }
  private cmp(): unknown {
    let v = this.add();
    for (;;) {
      const t = this.toks[this.i];
      if (!t) return v;
      if (t.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v)) {
        this.i++;
        const r = this.add();
        const a = strict(v) as number;
        const b = strict(r) as number;
        v = t.v === '==' ? eq(a, b) : t.v === '!=' ? !eq(a, b) : t.v === '<' ? a < b : t.v === '>' ? a > b : t.v === '<=' ? a <= b : a >= b;
      } else if (t.v === 'in' || (t.v === 'not' && this.toks[this.i + 1]?.v === 'in')) {
        const neg = t.v === 'not';
        this.i += neg ? 2 : 1;
        const r = strict(this.add());
        const has = Array.isArray(r) ? r.some((x) => eq(x, v)) : typeof r === 'string' ? r.includes(pyStr(v)) : !!r && typeof r === 'object' && pyStr(v) in r;
        v = neg ? !has : has;
      } else if (t.v === 'is') {
        this.i++;
        let neg = false;
        if (this.peek('not')) {
          this.i++;
          neg = true;
        }
        const name = this.toks[this.i++]?.v;
        let res: boolean;
        switch (name) {
          case 'defined':
            res = !(v instanceof Undefined);
            break;
          case 'undefined':
            res = v instanceof Undefined;
            break;
          case 'none':
            res = v === null;
            break;
          case 'true':
            res = v === true;
            break;
          case 'false':
            res = v === false;
            break;
          case 'string':
            res = typeof v === 'string';
            break;
          case 'number':
            res = typeof v === 'number';
            break;
          case 'failed':
            res = !!(strict(v) as { failed?: boolean }).failed;
            break;
          case 'succeeded':
          case 'success':
            res = !(strict(v) as { failed?: boolean }).failed;
            break;
          case 'changed':
            res = !!(strict(v) as { changed?: boolean }).changed;
            break;
          case 'skipped':
            res = !!(strict(v) as { skipped?: boolean }).skipped;
            break;
          default:
            throw new TemplateError(`no test named '${name}'`);
        }
        v = neg ? !res : res;
      } else return v;
    }
  }
  private applyFilters(v: unknown): unknown {
    while (this.peek('|')) {
      this.i++;
      const name = this.toks[this.i++]?.v ?? '';
      const args: unknown[] = [];
      if (this.peek('(')) {
        this.i++;
        while (!this.peek(')')) {
          args.push(this.expr());
          if (this.peek(',')) this.i++;
        }
        this.i++;
      }
      const f = FILTERS[name];
      if (!f) throw new TemplateError(`No filter named '${name}'.`);
      v = f(v, ...args);
    }
    return v;
  }
  private add(): unknown {
    let v = this.mul();
    while (this.peek('+') || this.peek('-') || this.peek('~')) {
      const op = this.toks[this.i++].v;
      const r = this.mul();
      if (op === '~') v = pyStr(v) + pyStr(r);
      else if (op === '+') v = Array.isArray(v) ? [...v, ...(r as unknown[])] : typeof strict(v) === 'string' ? (v as string) + pyStr(r) : (v as number) + (strict(r) as number);
      else v = (strict(v) as number) - (strict(r) as number);
    }
    return v;
  }
  private mul(): unknown {
    let v = this.unary();
    while (this.peek('*') || this.peek('/') || this.peek('%') || this.peek('//')) {
      const op = this.toks[this.i++].v;
      const a = strict(v) as number;
      const b = strict(this.unary()) as number;
      v = op === '*' ? a * b : op === '/' ? a / b : op === '//' ? Math.floor(a / b) : a % b;
    }
    return v;
  }
  private unary(): unknown {
    if (this.peek('-')) {
      this.i++;
      return -(strict(this.postfix()) as number);
    }
    return this.postfix();
  }
  private postfix(): unknown {
    let v = this.primary();
    for (;;) {
      if (this.peek('.')) {
        this.i++;
        const key = this.toks[this.i++].v;
        v = member(v, key);
      } else if (this.peek('[')) {
        this.i++;
        const key = this.expr();
        this.take(']');
        v = member(v, key as string);
      } else if (this.peek('|')) {
        v = this.applyFilters(v);
      } else return v;
    }
  }
  private primary(): unknown {
    const t = this.toks[this.i++];
    if (!t) throw new TemplateError('unexpected end of template');
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'str') return t.v;
    if (t.t === 'op' && t.v === '(') {
      const v = this.expr();
      this.take(')');
      return v;
    }
    if (t.t === 'op' && t.v === '[') {
      const items: unknown[] = [];
      while (!this.peek(']')) {
        items.push(this.expr());
        if (this.peek(',')) this.i++;
      }
      this.i++;
      return items;
    }
    if (t.t === 'op' && t.v === '{') {
      const obj: Record<string, unknown> = {};
      while (!this.peek('}')) {
        const k = pyStr(this.expr());
        this.take(':');
        obj[k] = this.expr();
        if (this.peek(',')) this.i++;
      }
      this.i++;
      return obj;
    }
    if (t.t === 'name') {
      if (t.v === 'true' || t.v === 'True') return true;
      if (t.v === 'false' || t.v === 'False') return false;
      if (t.v === 'none' || t.v === 'None') return null;
      if (t.v === 'range' && this.peek('(')) {
        this.i++;
        const a = Number(this.expr());
        let b: number | undefined;
        if (this.peek(',')) {
          this.i++;
          b = Number(this.expr());
        }
        this.take(')');
        const [lo, hi] = b === undefined ? [0, a] : [a, b];
        return Array.from({ length: Math.max(0, hi - lo) }, (_, k) => lo + k);
      }
      if (!(t.v in this.vars)) return new Undefined(t.v);
      const raw = this.vars[t.v];
      // Variables are lazy: one defined as "{{ other }}/x" is templated when used.
      if (depth < 20 && (typeof raw === 'string' ? raw.includes('{{') : raw && typeof raw === 'object')) {
        depth++;
        try {
          return templateValue(raw, this.vars);
        } finally {
          depth--;
        }
      }
      return raw;
    }
    throw new TemplateError(`unexpected '${t.v}'`);
  }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b) || String(a) === String(b) && typeof a === typeof b;
}

function member(v: unknown, key: string | number): unknown {
  if (v instanceof Undefined) throw new TemplateError(`'${v.name}' is undefined`);
  if (v && typeof v === 'object' && key in (v as object)) return (v as Record<string, unknown>)[key];
  if (v && typeof v === 'object') return new Undefined(`dict object' has no attribute '${key}`);
  return new Undefined(String(key));
}

export function evalExpr(src: string, vars: Vars): unknown {
  const p = new Parser(tokenize(src), vars);
  const v = p.expr();
  if (!p.done()) throw new TemplateError(`unexpected token in '${src}'`);
  return v;
}

/** A `when:` condition (a bare expression). */
export function evalCondition(src: unknown, vars: Vars): boolean {
  if (typeof src === 'boolean') return src;
  const s = String(src).trim().replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
  return truthy(evalExpr(s, vars));
}

type Node = { k: 'text'; v: string } | { k: 'out'; v: string } | { k: 'if'; branches: { cond: string | null; body: Node[] }[] } | { k: 'for'; name: string; iter: string; body: Node[] };

function parseTemplate(src: string): Node[] {
  const parts = src.split(/(\{\{[\s\S]*?\}\}|\{%-?[\s\S]*?-?%\}\n?|\{#[\s\S]*?#\}\n?)/);
  const root: Node[] = [];
  const stack: { node: Node | null; body: Node[] }[] = [{ node: null, body: root }];
  const cur = () => stack[stack.length - 1];
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('{#')) continue;
    if (part.startsWith('{{')) {
      cur().body.push({ k: 'out', v: part.slice(2, -2) });
      continue;
    }
    if (part.startsWith('{%')) {
      const tag = part.replace(/\n$/, '').replace(/^\{%-?\s*/, '').replace(/\s*-?%\}$/, '');
      const [kw, ...rest] = tag.split(/\s+/);
      const arg = rest.join(' ');
      if (kw === 'if') {
        const n: Node = { k: 'if', branches: [{ cond: arg, body: [] }] };
        cur().body.push(n);
        stack.push({ node: n, body: n.branches[0].body });
      } else if (kw === 'elif' || kw === 'else') {
        const top = cur().node;
        if (!top || top.k !== 'if') throw new TemplateError(`Encountered unknown tag '${kw}'.`);
        const b = { cond: kw === 'else' ? null : arg, body: [] as Node[] };
        top.branches.push(b);
        stack[stack.length - 1] = { node: top, body: b.body };
      } else if (kw === 'endif' || kw === 'endfor') {
        if (stack.length < 2) throw new TemplateError(`Encountered unknown tag '${kw}'.`);
        stack.pop();
      } else if (kw === 'for') {
        const m = /^(\w+)\s+in\s+(.+)$/.exec(arg);
        if (!m) throw new TemplateError('expected for x in y');
        const n: Node = { k: 'for', name: m[1], iter: m[2], body: [] };
        cur().body.push(n);
        stack.push({ node: n, body: n.body });
      } else throw new TemplateError(`Encountered unknown tag '${kw}'.`);
      continue;
    }
    cur().body.push({ k: 'text', v: part });
  }
  if (stack.length > 1) throw new TemplateError(`Unexpected end of template. Jinja was looking for the following tags: 'end${stack[stack.length - 1].node!.k}'.`);
  return root;
}

function renderNodes(nodes: Node[], vars: Vars): string {
  let out = '';
  for (const n of nodes) {
    if (n.k === 'text') out += n.v;
    else if (n.k === 'out') out += pyStr(evalExpr(n.v, vars));
    else if (n.k === 'if') {
      const b = n.branches.find((x) => x.cond === null || truthy(evalExpr(x.cond, vars)));
      if (b) out += renderNodes(b.body, vars);
    } else {
      const it = strict(evalExpr(n.iter, vars));
      const items = Array.isArray(it) ? it : Object.keys(it as object);
      items.forEach((item, idx) => {
        out += renderNodes(n.body, { ...vars, [n.name]: item, loop: { index: idx + 1, index0: idx, first: idx === 0, last: idx === items.length - 1, length: items.length } });
      });
    }
  }
  return out;
}

/** Render a template file (trim_blocks on, like Ansible's template module). */
export function renderTemplate(src: string, vars: Vars): string {
  return renderNodes(parseTemplate(src), vars);
}

/** Template a YAML value: a string that is only "{{ expr }}" keeps the expression's type. */
export function templateValue(v: unknown, vars: Vars): unknown {
  if (typeof v === 'string') {
    if (!v.includes('{{') && !v.includes('{%')) return v;
    const whole = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(v);
    if (whole && !whole[1].includes('}}')) {
      const r = evalExpr(whole[1], vars);
      return strict(r);
    }
    return renderTemplate(v, vars);
  }
  if (Array.isArray(v)) return v.map((x) => templateValue(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, templateValue(x, vars)]));
  return v;
}
