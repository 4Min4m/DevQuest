/** Executes parsed Go templates with Go's semantics (truthiness, nil handling, printing). */
import { FUNCS, goString, isEmpty } from './funcs';
import { Arg, Cmd, Node, parseTemplate, Pipe, Pos, TemplateError } from './parse';

type Control = { k: 'if' | 'with' | 'range'; pipe: Pipe; list: Node[]; elseList: Node[] | null; pos: Pos };

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

class Break {}
class Continue {}

/** The set of templates a chart renders with (files plus every {{define}} in them). */
export class TemplateSet {
  files: Record<string, Node[]> = {};
  defines: Record<string, { file: string; nodes: Node[] }> = {};

  add(file: string, src: string): void {
    const p = parseTemplate(src, file);
    this.files[file] = p.root;
    for (const [n, nodes] of Object.entries(p.defines)) this.defines[n] = { file, nodes };
  }

  /** Render one file. Missing values print as Helm does (empty, not "<no value>"). */
  render(file: string, data: V): string {
    const ex = new Executor(this, file, data);
    return ex.run(this.files[file], data).replace(/<no value>/g, '');
  }

  include(name: string, data: V, from: string): string {
    const d = this.defines[name];
    if (!d) throw new TemplateError(`template: ${from}: no template "${name}" associated with template "gotpl"`);
    return new Executor(this, d.file, data).run(d.nodes, data);
  }
}

export interface ExecEnv {
  set: TemplateSet;
  file: string;
  root: V;
  /** Render an arbitrary string as a template (Helm's `tpl`). */
  tpl: (src: string, data: V) => string;
  err: (pos: Pos, msg: string, kind?: 'execution' | 'executing', at?: string) => TemplateError;
}

class Executor {
  vars: { name: string; value: V }[][] = [];
  constructor(
    private set: TemplateSet,
    private file: string,
    private root: V,
  ) {}

  env(): ExecEnv {
    return {
      set: this.set,
      file: this.file,
      root: this.root,
      tpl: (src, data) => {
        const s = new TemplateSet();
        s.defines = this.set.defines;
        s.add(this.file, src);
        return s.render(this.file, data);
      },
      err: (pos, msg, kind = 'executing', at) => this.error(pos, msg, kind, at),
    };
  }

  error(pos: Pos, msg: string, kind: 'execution' | 'executing' = 'executing', at?: string): TemplateError {
    if (kind === 'execution') return new TemplateError(`execution error at (${this.file}:${pos.line}:${pos.col}): ${msg}`);
    return new TemplateError(`template: ${this.file}:${pos.line}:${pos.col}: executing "${this.file}" at <${at ?? ''}>: ${msg}`);
  }

  run(nodes: Node[], dot: V): string {
    this.vars.push([{ name: '$', value: dot }]);
    try {
      return this.list(nodes, dot);
    } finally {
      this.vars.pop();
    }
  }

  lookupVar(name: string, pos: Pos): V {
    for (let i = this.vars.length - 1; i >= 0; i--) {
      const f = this.vars[i];
      for (let j = f.length - 1; j >= 0; j--) if (f[j].name === name) return f[j].value;
      if (name !== '$') continue;
    }
    throw new TemplateError(`parse error at (${this.file}:${pos.line}): undefined variable "${name}"`);
  }

  setVar(name: string, value: V, declare: boolean, pos: Pos): void {
    if (declare) {
      this.vars[this.vars.length - 1].push({ name, value });
      return;
    }
    for (let i = this.vars.length - 1; i >= 0; i--) {
      const f = this.vars[i];
      for (let j = f.length - 1; j >= 0; j--) {
        if (f[j].name === name) {
          f[j].value = value;
          return;
        }
      }
    }
    throw new TemplateError(`parse error at (${this.file}:${pos.line}): undefined variable "${name}"`);
  }

  scoped<T>(fn: () => T): T {
    this.vars.push([]);
    try {
      return fn();
    } finally {
      this.vars.pop();
    }
  }

  list(nodes: Node[], dot: V): string {
    let out = '';
    for (const n of nodes) out += this.node(n, dot);
    return out;
  }

  node(n: Node, dot: V): string {
    switch (n.k) {
      case 'text':
        return n.text;
      case 'action': {
        const v = this.pipe(n.pipe, dot);
        return n.pipe.decl.length ? '' : goString(v);
      }
      case 'if':
        return this.scoped(() => (isTruthy(this.pipe(n.pipe, dot)) ? this.list(n.list, dot) : n.elseList ? this.list(n.elseList, dot) : ''));
      case 'with':
        return this.scoped(() => {
          const v = this.pipe(n.pipe, dot);
          return isTruthy(v) ? this.list(n.list, v) : n.elseList ? this.list(n.elseList, dot) : '';
        });
      case 'range':
        return this.scoped(() => this.range(n, dot));
      case 'template': {
        const d = this.set.defines[n.name];
        if (!d) throw new TemplateError(`template: ${this.file}:${n.pos.line}:${n.pos.col}: executing "${this.file}" at <{{template "${n.name}" ${n.pipe ? '.' : ''}}}>: template "${n.name}" not defined`);
        const data = n.pipe ? this.pipe(n.pipe, dot) : undefined;
        return new Executor(this.set, d.file, this.root).run(d.nodes, data);
      }
      case 'break':
        throw new Break();
      case 'continue':
        throw new Continue();
    }
  }

  range(n: Control, dot: V): string {
    const val = this.pipe({ ...n.pipe, decl: [] }, dot);
    let entries: [V, V][] = [];
    if (Array.isArray(val)) entries = val.map((v, i) => [i, v]);
    else if (val && typeof val === 'object') entries = Object.keys(val).sort().map((k) => [k, val[k]]);
    else if (typeof val === 'number') entries = Array.from({ length: Math.max(0, Math.floor(val)) }, (_, i) => [i, i]);
    else if (val !== undefined && val !== null && val !== '') throw this.error(n.pos, `range can't iterate over ${goString(val)}`, 'executing', 'range');
    if (!entries.length) return n.elseList ? this.list(n.elseList, dot) : '';
    let out = '';
    for (const [k, v] of entries) {
      if (n.pipe.decl.length === 1) this.setVar(n.pipe.decl[0], v, true, n.pos);
      if (n.pipe.decl.length === 2) {
        this.setVar(n.pipe.decl[0], k, true, n.pos);
        this.setVar(n.pipe.decl[1], v, true, n.pos);
      }
      try {
        out += this.list(n.list, v);
      } catch (e) {
        if (e instanceof Break) break;
        if (e instanceof Continue) continue;
        throw e;
      }
    }
    return out;
  }

  pipe(p: Pipe, dot: V): V {
    let val: V = undefined;
    let hasVal = false;
    for (const c of p.cmds) {
      val = this.cmd(c, dot, hasVal ? [val] : []);
      hasVal = true;
    }
    if (p.decl.length) for (const name of p.decl) this.setVar(name, val, !p.assign, p.pos);
    return val;
  }

  argText(a: Arg): string {
    switch (a.t) {
      case 'field':
        return '.' + a.path.join('.');
      case 'var':
        return [a.name, ...a.path].join('.');
      case 'ident':
        return a.name;
      case 'dot':
        return '.';
      case 'str':
        return JSON.stringify(a.v);
      default:
        return '';
    }
  }

  cmd(c: Cmd, dot: V, piped: V[]): V {
    const [head, ...rest] = c.args;
    if (head.t === 'ident') {
      const name = head.name;
      if (name === 'and' || name === 'or') {
        const args = [...rest.map((a) => () => this.arg(a, dot)), ...piped.map((v) => () => v)];
        let last: V;
        for (const get of args) {
          last = get();
          if (name === 'and' ? !isTruthy(last) : isTruthy(last)) return last;
        }
        return last;
      }
      const fn = FUNCS[name];
      if (!fn) throw new TemplateError(`parse error at (${this.file}:${head.pos.line}): function "${name}" not defined`);
      const args = [...rest.map((a) => this.arg(a, dot)), ...piped];
      try {
        return fn(this.env(), head.pos, ...args);
      } catch (e) {
        if (e instanceof TemplateError) throw e;
        throw this.error(head.pos, `error calling ${name}: ${(e as Error).message}`, 'executing', this.argText(head));
      }
    }
    if ((head.t === 'field' || head.t === 'var') && (rest.length || piped.length)) {
      // Methods on built-in objects: .Capabilities.APIVersions.Has "x", .Files.Get "x".
      const fn = this.arg(head, dot);
      if (typeof fn === 'function') return fn(...rest.map((a) => this.arg(a, dot)), ...piped);
    }
    if (rest.length || piped.length) {
      if (head.t === 'field' || head.t === 'var') throw this.error(head.pos, `${this.argText(head).split('.').pop()} has arguments but cannot be invoked as function`, 'executing', this.argText(head));
      throw this.error(head.pos, `can't give argument to non-function ${this.argText(head)}`, 'executing', this.argText(head));
    }
    return this.arg(head, dot);
  }

  arg(a: Arg, dot: V): V {
    switch (a.t) {
      case 'dot':
        return dot;
      case 'str':
      case 'num':
      case 'bool':
        return a.v;
      case 'nil':
        return null;
      case 'field':
        return this.walk(dot, a.path, a.pos, '.' + a.path.join('.'));
      case 'var':
        return this.walk(this.lookupVar(a.name, a.pos), a.path, a.pos, [a.name, ...a.path].join('.'));
      case 'pipe':
        return this.walk(this.scoped(() => this.pipe(a.pipe, dot)), a.path, a.pos, '(...).' + a.path.join('.'));
      case 'ident': {
        const fn = FUNCS[a.name];
        if (!fn) throw new TemplateError(`parse error at (${this.file}:${a.pos.line}): function "${a.name}" not defined`);
        return fn(this.env(), a.pos);
      }
    }
  }

  walk(v: V, path: string[], pos: Pos, text: string): V {
    let cur = v;
    for (let i = 0; i < path.length; i++) {
      const key = path[i];
      if (cur === undefined || cur === null) throw this.error(pos, `nil pointer evaluating interface {}.${key}`, 'executing', text);
      if (typeof cur !== 'object' || Array.isArray(cur)) throw this.error(pos, `can't evaluate field ${key} in type ${goType(cur)}`, 'executing', text);
      cur = cur[key];
    }
    return cur;
  }
}

export function isTruthy(v: V): boolean {
  return !isEmpty(v);
}

function goType(v: V): string {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float64';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return '[]interface {}';
  return 'interface {}';
}
