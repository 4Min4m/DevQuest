/** Terraform's human-readable plan output. */
import { isUnknown, Sensitive, unwrap } from './eval';
import type { Change, Drift } from './engine';
import { sameValue } from './engine';
import { PROVIDERS, providerOf } from './providers';
import type { Attrs, AttrSchema } from './providers';

const pad = (n: number) => ' '.repeat(n);

function scalar(v: unknown): string {
  if (v instanceof Sensitive) return '(sensitive value)';
  if (isUnknown(v)) return '(known after apply)';
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

const isEmpty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && v !== null && !isUnknown(v) && !(v instanceof Sensitive) && !Object.keys(v).length);

/** Render a value as Terraform shows it, `sign` prefixed to nested lines. */
export function renderVal(v: unknown, indent: number, sign: string): string {
  if (v instanceof Sensitive) return '(sensitive value)';
  if (isUnknown(v)) return '(known after apply)';
  if (typeof v === 'string' && v.includes('\n')) {
    const lines = v.replace(/\n$/, '').split('\n');
    return `<<-EOT\n${lines.map((l) => pad(indent + 4) + l).join('\n')}\n${pad(indent)}EOT`;
  }
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => `${pad(indent + 4)}${sign} ${renderVal(x, indent + 4, sign)},`).join('\n')}\n${pad(indent + 2)}]`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    const w = Math.max(...keys.map((k) => JSON.stringify(k).length));
    return `{\n${keys.map((k) => `${pad(indent + 4)}${sign} ${JSON.stringify(k).padEnd(w)} = ${renderVal((v as Attrs)[k], indent + 4, sign)}`).join('\n')}\n${pad(indent + 2)}}`;
  }
  return scalar(v);
}

function schemaOf(type: string, mode: string): Record<string, AttrSchema> {
  const p = PROVIDERS[providerOf(type)];
  return (mode === 'data' ? p?.data[type]?.schema : p?.resources[type]?.schema) ?? {};
}

/** Attribute lines for a whole object (create: "+", destroy: "-"). */
function allLines(attrs: Attrs, schema: Record<string, AttrSchema>, indent: number, sign: '+' | '-'): string[] {
  const keys = Object.keys(attrs).filter((k) => !schema[k]?.block && !isEmpty(attrs[k]) || (isUnknown(attrs[k]) && !schema[k]?.block)).sort();
  const w = Math.max(0, ...keys.map((k) => k.length));
  const out: string[] = [];
  const val = (k: string) => (schema[k]?.sensitive && !isUnknown(attrs[k]) ? '(sensitive value)' : renderVal(attrs[k], indent, sign));
  for (const k of keys) out.push(`${pad(indent)}${sign} ${k.padEnd(w)} = ${val(k)}${sign === '-' ? ' -> null' : ''}`);
  for (const [k, s] of Object.entries(schema).filter(([, s]) => s.block).sort()) {
    const blocks = attrs[k];
    if (isUnknown(blocks)) {
      out.push(`${pad(indent)}${sign} ${k} = (known after apply)`);
      continue;
    }
    for (const b of (blocks as Attrs[]) ?? []) {
      out.push(`${pad(indent)}${sign} ${k} {`);
      out.push(...allLines(b, s.block!, indent + 4, sign));
      out.push(`${pad(indent + 2)}}`);
    }
  }
  return out;
}

function mapDiff(before: Attrs, after: Attrs, indent: number): string[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  const w = Math.max(...keys.map((k) => JSON.stringify(k).length));
  const out: string[] = [];
  let same = 0;
  for (const k of keys) {
    const a = before?.[k];
    const b = after?.[k];
    const kk = JSON.stringify(k).padEnd(w);
    if (a === undefined) out.push(`${pad(indent)}+ ${kk} = ${scalar(b)}`);
    else if (b === undefined) out.push(`${pad(indent)}- ${kk} = ${scalar(a)} -> null`);
    else if (!sameValue(a, b)) out.push(`${pad(indent)}~ ${kk} = ${scalar(a)} -> ${scalar(b)}`);
    else same++;
  }
  if (same) out.push(`${pad(indent + 2)}# (${same} unchanged element${same === 1 ? '' : 's'} hidden)`);
  return out;
}

function listDiff(before: unknown[], after: unknown[], indent: number): string[] {
  const enc = (x: unknown) => JSON.stringify(unwrap(x));
  const bs = (before ?? []).map(enc);
  const as = (after ?? []).map(enc);
  const out: string[] = [];
  let same = 0;
  for (const x of before ?? []) if (!as.includes(enc(x))) out.push(`${pad(indent)}- ${scalar(x)},`);
  for (const x of after ?? []) {
    if (!bs.includes(enc(x))) out.push(`${pad(indent)}+ ${scalar(x)},`);
    else same++;
  }
  if (same) out.push(`${pad(indent + 2)}# (${same} unchanged element${same === 1 ? '' : 's'} hidden)`);
  return out;
}

/** Attribute lines for an update / replacement. */
function changeLines(before: Attrs, after: Attrs, schema: Record<string, AttrSchema>, forces: Set<string>, indent: number): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !schema[k]?.block).sort();
  const changed = keys.filter((k) => !sameValue(before[k], after[k], schema[k]) || isUnknown(after[k]) && !isUnknown(before[k]) && before[k] !== undefined);
  const shownSame = keys.filter((k) => !changed.includes(k) && (k === 'id' || k === 'name' || k === 'tags') && !isEmpty(before[k]));
  const visible = [...new Set([...changed, ...shownSame])].sort();
  const w = Math.max(0, ...visible.map((k) => k.length));
  const out: string[] = [];
  for (const k of visible) {
    const a = before[k];
    const b = after[k];
    const name = k.padEnd(w);
    const force = forces.has(k) ? ' # forces replacement' : '';
    if (!changed.includes(k)) {
      if (k === 'tags' && a && typeof a === 'object') continue;
      out.push(`${pad(indent + 2)}${name} = ${scalar(a)}`);
      continue;
    }
    const sens = schema[k]?.sensitive;
    if (isEmpty(a) && !isUnknown(b)) out.push(`${pad(indent)}+ ${name} = ${sens ? '(sensitive value)' : renderVal(b, indent, '+')}${force}`);
    else if (isEmpty(b) && !isUnknown(b)) out.push(`${pad(indent)}- ${name} = ${sens ? '(sensitive value)' : renderVal(a, indent, '-')} -> null${force}`);
    else if (!isUnknown(b) && a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      out.push(`${pad(indent)}~ ${name} = {${force}`, ...mapDiff(a as Attrs, b as Attrs, indent + 4), `${pad(indent + 2)}}`);
    } else if (!isUnknown(b) && Array.isArray(a) && Array.isArray(b)) {
      out.push(`${pad(indent)}~ ${name} = [${force}`, ...listDiff(a, b, indent + 4), `${pad(indent + 2)}]`);
    } else out.push(`${pad(indent)}~ ${name} = ${sens ? '(sensitive value)' : scalar(a)} -> ${sens && !isUnknown(b) ? '(sensitive value)' : scalar(b)}${force}`);
  }
  for (const [k, s] of Object.entries(schema).filter(([, s]) => s.block).sort()) {
    const a = ((before[k] as Attrs[]) ?? []).map((x) => x);
    const bRaw = after[k];
    if (isUnknown(bRaw)) {
      if (a.length) out.push(`${pad(indent)}~ ${k} = (known after apply)`);
      continue;
    }
    const b = (bRaw as Attrs[]) ?? [];
    const enc = (x: Attrs) => JSON.stringify(Object.keys(x).sort().map((kk) => [kk, x[kk]]));
    for (const x of a) if (!b.some((y) => sameValue(x, y))) out.push(`${pad(indent)}- ${k} {${forces.has(k) ? ' # forces replacement' : ''}`, ...allLines(x, s.block!, indent + 4, '-'), `${pad(indent + 2)}}`);
    for (const y of b) if (!a.some((x) => sameValue(x, y))) out.push(`${pad(indent)}+ ${k} {`, ...allLines(y, s.block!, indent + 4, '+'), `${pad(indent + 2)}}`);
    void enc;
  }
  const hidden = keys.filter((k) => !visible.includes(k) && !isEmpty(before[k])).length;
  if (hidden) out.push(`${pad(indent + 2)}# (${hidden} unchanged attribute${hidden === 1 ? '' : 's'} hidden)`);
  return out;
}

const headerAddr = (c: { addr: string }) => c.addr;

export function renderChange(c: Change): string {
  const schema = schemaOf(c.type, c.mode);
  const kind = c.mode === 'data' ? 'data' : 'resource';
  const head = (sign: string) => `${sign} ${kind} "${c.type}" "${c.name}" {`;
  const lines: string[] = [];
  switch (c.action) {
    case 'create':
      lines.push(`  # ${headerAddr(c)} will be created`, `  ${head('+')}`, ...allLines(c.after!, schema, 6, '+'), '    }');
      break;
    case 'delete':
      lines.push(`  # ${headerAddr(c)} will be destroyed`);
      if (c.reason) lines.push(`  # (${c.reason})`);
      lines.push(`  ${head('-')}`, ...allLines(c.before!, schema, 6, '-'), '    }');
      break;
    case 'update':
      lines.push(`  # ${headerAddr(c)} will be updated in-place`, `  ${head('~')}`, ...changeLines(c.before!, c.after!, schema, new Set(), 6), '    }');
      break;
    case 'replace': {
      const cbd = c.rc?.lifecycle.createBeforeDestroy;
      lines.push(`  # ${headerAddr(c)} ${c.reason === 'tainted' ? 'is tainted, so must be replaced' : c.requested ? 'will be replaced, as requested' : 'must be replaced'}`, `${cbd ? '+/-' : '-/+'} ${kind} "${c.type}" "${c.name}" {`, ...changeLines(c.before!, c.after!, schema, c.forces, 6), '    }');
      break;
    }
    case 'read':
      lines.push(`  # ${headerAddr(c)} will be read during apply`, `  # (config refers to values not yet known)`, ` <= data "${c.type}" "${c.name}" {`, ...allLines(c.after!, schema, 6, '+').map((l) => l.replace(/\+ /, '+ ')), '    }');
      break;
  }
  return lines.join('\n') + '\n';
}

export function renderDrift(d: Drift[]): string {
  if (!d.length) return '';
  const blocks = d.map((x) => {
    const schema = schemaOf(x.type, 'managed');
    const [type, name] = x.addr.replace(/^(module\.[^.]+\.)+/, '').replace(/\[.*$/, '').split('.');
    if (!x.after) return [`  # ${x.addr} has been deleted`, `  - resource "${type}" "${name}" {`, ...allLines(x.before, schema, 6, '-').filter((l) => /\b(id|bucket|name|arn)\s+=/.test(l)), '    }'].join('\n');
    return [`  # ${x.addr} has changed`, `  ~ resource "${type}" "${name}" {`, ...changeLines(x.before, x.after, schema, new Set(), 6), '    }'].join('\n');
  });
  return `\nNote: Objects have changed outside of Terraform\n\nTerraform detected the following changes made outside of Terraform since the\nlast "terraform apply" which may have affected this plan:\n\n${blocks.join('\n\n')}\n\n\nUnless you have made equivalent changes to your configuration, or ignored the\nrelevant attributes using ignore_changes, the following plan may include\nactions to undo or respond to these changes.\n\n${'─'.repeat(77)}\n`;
}

export function legend(changes: Change[]): string {
  const acts = new Set(changes.map((c) => (c.action === 'replace' && c.rc?.lifecycle.createBeforeDestroy ? 'cbd' : c.action)));
  const l: string[] = [];
  if (acts.has('create')) l.push('  + create');
  if (acts.has('update')) l.push('  ~ update in-place');
  if (acts.has('delete')) l.push('  - destroy');
  if (acts.has('replace')) l.push('-/+ destroy and then create replacement');
  if (acts.has('cbd')) l.push('+/- create replacement and then destroy');
  if (acts.has('read')) l.push(' <= read (data resources)');
  return `\nTerraform used the selected providers to generate the following execution\nplan. Resource actions are indicated with the following symbols:\n${l.join('\n')}\n\nTerraform will perform the following actions:\n\n`;
}

/** `name = value` as terraform output / apply prints it. */
export function renderOutputValue(v: unknown, indent = 0): string {
  v = v instanceof Sensitive ? v.v : v;
  if (isUnknown(v)) return '(known after apply)';
  if (typeof v === 'string' && v.includes('\n')) return `<<EOT\n${v.replace(/\n$/, '')}\nEOT`;
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${pad(indent + 2)}${renderOutputValue(x, indent + 2)},`).join('\n')}\n${pad(indent)}]` : '[]';
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    const w = Math.max(...keys.map((k) => JSON.stringify(k).length));
    return `{\n${keys.map((k) => `${pad(indent + 2)}${JSON.stringify(k).padEnd(w)} = ${renderOutputValue((v as Attrs)[k], indent + 2)}`).join('\n')}\n${pad(indent)}}`;
  }
  return scalar(v);
}
