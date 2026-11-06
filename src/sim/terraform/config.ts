/** Loading a Terraform module (*.tf files) into a configuration, and Terraform-style diagnostics. */
import { Vfs } from '../vfs/vfs';
import { Attr, Block, Body, Expr, HclError, parseHcl, Pos } from './hcl';

export interface Diag {
  severity?: 'error' | 'warning';
  summary: string;
  detail?: string;
  file?: string;
  pos?: Pos;
  /** Source line shown under "on FILE line N". */
  line?: string;
  /** "in resource \"aws_instance\" \"web\"". */
  context?: string;
  /** "with aws_instance.web," */
  addr?: string;
}

export class TfError extends Error {
  constructor(public diags: Diag[]) {
    super(diags[0]?.summary ?? 'error');
  }
}

export function renderDiag(d: Diag): string {
  const lines = [`${d.severity === 'warning' ? 'Warning' : 'Error'}: ${d.summary}`, ''];
  if (d.addr) lines.push(`  with ${d.addr},`);
  if (d.file && d.pos) {
    lines.push(`  on ${d.file} line ${d.pos.line}${d.context ? `, in ${d.context}` : ''}:`);
    if (d.line !== undefined) lines.push(`${String(d.pos.line).padStart(4)}: ${d.line}`);
    lines.push('');
  }
  if (d.detail) lines.push(...d.detail.split('\n'));
  while (lines[lines.length - 1] === '') lines.pop();
  return '╷\n' + lines.map((l) => (l ? `│ ${l}` : '│ ')).join('\n') + '\n╵\n';
}

export interface Lifecycle {
  preventDestroy: boolean;
  createBeforeDestroy: boolean;
  ignoreChanges: string[] | 'all';
}

export interface ResourceCfg {
  mode: 'managed' | 'data';
  type: string;
  name: string;
  body: Body;
  block: Block;
  file: string;
  count?: Attr;
  forEach?: Attr;
  dependsOn: Expr[];
  lifecycle: Lifecycle;
}

export interface VariableCfg {
  name: string;
  block: Block;
  file: string;
  default?: Attr;
  type?: string;
  sensitive: boolean;
  description?: string;
  validations: { condition: Attr; message: Attr; block: Block }[];
}

export interface OutputCfg {
  name: string;
  value?: Attr;
  sensitive: boolean;
  block: Block;
  file: string;
}

export interface ModuleCall {
  name: string;
  source: string;
  block: Block;
  file: string;
  args: Attr[];
}

export interface ModuleCfg {
  dir: string;
  files: Record<string, string>;
  variables: Record<string, VariableCfg>;
  locals: Record<string, { attr: Attr; file: string }>;
  outputs: Record<string, OutputCfg>;
  resources: ResourceCfg[];
  modules: Record<string, ModuleCall>;
  providers: Record<string, { block: Block; file: string }>;
  required: Record<string, { source: string; version?: string }>;
  requiredVersion?: string;
  backend?: { type: string; block: Block; file: string };
}

const attr = (b: Body, name: string) => b.attrs.find((a) => a.name === name);

/** Source text of a type constraint expression (list(string), number...). */
function typeSrc(e: Expr): string {
  if (e.t === 'var') return e.name;
  if (e.t === 'call') return `${e.name}(${e.args.map(typeSrc).join(', ')})`;
  if (e.t === 'obj') return `object({${e.items.map((i) => `${(i.key as { v?: string }).v}=${typeSrc(i.value)}`).join(', ')}})`;
  return 'any';
}

function strLit(a: Attr | undefined): string | undefined {
  return a && a.expr.t === 'lit' && typeof a.expr.v === 'string' ? a.expr.v : undefined;
}

function boolLit(a: Attr | undefined): boolean {
  return !!a && a.expr.t === 'lit' && a.expr.v === true;
}

export function loadModule(vfs: Vfs, dir: string): ModuleCfg {
  let names: string[] = [];
  try {
    names = vfs.readdir(dir).filter((f) => f.endsWith('.tf') && !f.startsWith('.')).sort();
  } catch {
    throw new TfError([{ summary: 'Unreadable module directory', detail: `Unable to evaluate directory symlink: lstat ${dir}: no such file or directory` }]);
  }
  const m: ModuleCfg = { dir, files: {}, variables: {}, locals: {}, outputs: {}, resources: [], modules: {}, providers: {}, required: {} };
  const diags: Diag[] = [];
  for (const f of names) {
    const text = vfs.readFile(`${dir}/${f}`);
    m.files[f] = text;
    let body: Body;
    try {
      body = parseHcl(text, f);
    } catch (e) {
      if (e instanceof HclError) {
        diags.push({ summary: e.summary, detail: e.detail, file: f, pos: e.pos, line: text.split('\n')[e.pos.line - 1] });
        continue;
      }
      throw e;
    }
    for (const a of body.attrs) diags.push({ summary: 'Unsupported argument', detail: `An argument named "${a.name}" is not expected here.`, file: f, pos: a.pos, line: a.line });
    for (const b of body.blocks) {
      const where = { file: f, pos: b.pos, line: b.line };
      const need = (n: number, what: string) => {
        if (b.labels.length !== n) {
          diags.push({ ...where, summary: `Missing name for ${b.type}`, detail: `All ${b.type} blocks must have ${n} label${n === 1 ? '' : 's'} (${what}).` });
          return false;
        }
        return true;
      };
      switch (b.type) {
        case 'terraform': {
          for (const rp of b.body.blocks.filter((x) => x.type === 'required_providers')) {
            for (const a of rp.body.attrs) {
              if (a.expr.t === 'obj') {
                const o: Record<string, string> = {};
                for (const it of a.expr.items) if (it.key.t === 'lit' && it.value.t === 'lit') o[String(it.key.v)] = String(it.value.v);
                m.required[a.name] = { source: o.source ?? `hashicorp/${a.name}`, version: o.version };
              } else if (a.expr.t === 'lit') m.required[a.name] = { source: `hashicorp/${a.name}`, version: String(a.expr.v) };
            }
          }
          const be = b.body.blocks.find((x) => x.type === 'backend');
          if (be) m.backend = { type: be.labels[0], block: be, file: f };
          m.requiredVersion = strLit(attr(b.body, 'required_version'));
          break;
        }
        case 'provider':
          if (need(1, 'provider name')) m.providers[b.labels[0]] = { block: b, file: f };
          break;
        case 'variable': {
          if (!need(1, 'variable name')) break;
          const name = b.labels[0];
          if (m.variables[name]) diags.push({ ...where, summary: 'Duplicate variable declaration', detail: `A variable named "${name}" was already declared at ${m.variables[name].file}:${m.variables[name].block.pos.line},1-${name.length + 13}. Variable names must be unique within a module.` });
          const t = attr(b.body, 'type');
          m.variables[name] = {
            name,
            block: b,
            file: f,
            default: attr(b.body, 'default'),
            type: t ? typeSrc(t.expr) : undefined,
            sensitive: boolLit(attr(b.body, 'sensitive')),
            description: strLit(attr(b.body, 'description')),
            validations: b.body.blocks.filter((x) => x.type === 'validation').map((v) => ({ condition: attr(v.body, 'condition')!, message: attr(v.body, 'error_message')!, block: v })),
          };
          break;
        }
        case 'locals':
          for (const a of b.body.attrs) {
            if (m.locals[a.name]) diags.push({ file: f, pos: a.pos, line: a.line, summary: 'Duplicate local value definition', detail: `A local value named "${a.name}" was already defined. Local value names must be unique within a module.` });
            m.locals[a.name] = { attr: a, file: f };
          }
          break;
        case 'output':
          if (need(1, 'output name')) m.outputs[b.labels[0]] = { name: b.labels[0], value: attr(b.body, 'value'), sensitive: boolLit(attr(b.body, 'sensitive')), block: b, file: f };
          if (b.labels[0] && !attr(b.body, 'value')) diags.push({ ...where, summary: 'Missing required argument', detail: 'The argument "value" is required, but no definition was found.' });
          break;
        case 'resource':
        case 'data': {
          if (!need(2, b.type === 'data' ? 'data source type and name' : 'resource type and name')) break;
          const [type, name] = b.labels;
          const mode = b.type === 'data' ? 'data' : 'managed';
          const dup = m.resources.find((r) => r.mode === mode && r.type === type && r.name === name);
          if (dup) {
            diags.push({ ...where, summary: `Duplicate ${mode === 'data' ? 'data' : 'resource'} "${type}" configuration`, detail: `A ${mode === 'data' ? 'data' : ''}${mode === 'data' ? ' ' : ''}${type} ${mode === 'data' ? 'data source' : 'resource'} named "${name}" was already declared at ${dup.file}:${dup.block.pos.line},1-${b.line.trimEnd().length}. Resource names must be unique per type in each module.`.replace(/^A aws/, 'A aws') });
            break;
          }
          const lc = b.body.blocks.find((x) => x.type === 'lifecycle');
          const ign = lc ? attr(lc.body, 'ignore_changes') : undefined;
          const deps = attr(b.body, 'depends_on');
          m.resources.push({
            mode,
            type,
            name,
            body: b.body,
            block: b,
            file: f,
            count: attr(b.body, 'count'),
            forEach: attr(b.body, 'for_each'),
            dependsOn: deps && deps.expr.t === 'list' ? deps.expr.items : [],
            lifecycle: {
              preventDestroy: lc ? boolLit(attr(lc.body, 'prevent_destroy')) : false,
              createBeforeDestroy: lc ? boolLit(attr(lc.body, 'create_before_destroy')) : false,
              ignoreChanges: !ign ? [] : ign.expr.t === 'var' && ign.expr.name === 'all' ? 'all' : ign.expr.t === 'list' ? ign.expr.items.map((x) => (x.t === 'var' ? x.name : x.t === 'get' ? (x.src ?? '') : '')).filter(Boolean) : [],
            },
          });
          break;
        }
        case 'module': {
          if (!need(1, 'module name')) break;
          const src = strLit(attr(b.body, 'source'));
          if (!src) {
            diags.push({ ...where, summary: 'Missing required argument', detail: 'The argument "source" is required, but no definition was found.' });
            break;
          }
          m.modules[b.labels[0]] = { name: b.labels[0], source: src, block: b, file: f, args: b.body.attrs.filter((a) => !['source', 'version', 'count', 'for_each', 'depends_on', 'providers'].includes(a.name)) };
          break;
        }
        case 'moved':
        case 'import':
        case 'check':
          break;
        default:
          diags.push({ ...where, summary: 'Unsupported block type', detail: `Blocks of type "${b.type}" are not expected here.` });
      }
    }
  }
  if (!names.length) diags.push({ summary: 'No configuration files', detail: 'Plan requires configuration to be present. Planning without a configuration would\nmark everything for destruction, which is normally not what is desired. If you\nwould like to destroy everything, run plan with the -destroy option. Otherwise,\ncreate a Terraform configuration file (.tf file) and try again.' });
  if (diags.length) throw new TfError(diags);
  return m;
}
