/** kubectl patch (merge / strategic / json) and kubectl set selector. */
import { parse } from 'yaml';
import { qualified } from '../cluster';
import { admit, AdmissionError } from '../manifest';
import { clean } from '../printers';
import type { J } from '../types';
import { authorize, findOne, KCtx, KubectlError, namespaceOf, parseFlags, targets } from './common';

/** JSON merge patch (RFC 7386); `strategic` also merges lists of named objects by name. */
export function mergePatch(target: J, patch: J, strategic: boolean): J {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    if (strategic && Array.isArray(patch) && Array.isArray(target) && patch.every((p) => p && typeof p === 'object' && 'name' in p)) {
      const out = [...target];
      for (const p of patch) {
        const i = out.findIndex((t) => t?.name === p.name);
        if (p.$patch === 'delete') {
          if (i >= 0) out.splice(i, 1);
        } else if (i >= 0) out[i] = mergePatch(out[i], p, true);
        else out.push(p);
      }
      return out;
    }
    return patch;
  }
  const out: J = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v, strategic);
  }
  return out;
}

function jsonPatch(doc: J, ops: J[]): J {
  const out = JSON.parse(JSON.stringify(doc));
  for (const op of ops) {
    const parts = String(op.path ?? '').split('/').slice(1).map((p: string) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = parts.pop();
    let node = out;
    for (const p of parts) {
      if (node[p] === undefined) throw new KubectlError(`error: unable to apply patch: replace operation does not apply: doc is missing path: ${op.path}: missing value`);
      node = node[p];
    }
    if (last === undefined) throw new KubectlError('error: unable to apply patch: invalid path');
    if (op.op === 'remove') {
      if (Array.isArray(node)) node.splice(Number(last), 1);
      else delete node[last];
    } else if (op.op === 'add' || op.op === 'replace') {
      if (op.op === 'replace' && !(last in node)) throw new KubectlError(`error: unable to apply patch: replace operation does not apply: doc is missing key: ${op.path}: missing value`);
      if (Array.isArray(node) && last === '-') node.push(op.value);
      else if (Array.isArray(node) && op.op === 'add') node.splice(Number(last), 0, op.value);
      else node[last] = op.value;
    } else throw new KubectlError(`error: unable to apply patch: unsupported operation "${op.op}"`);
  }
  return out;
}

export function kubectlPatch(k: KCtx, argv: string[]): number {
  const f = parseFlags('patch', argv, { value: ['p', 'patch', 'type', 'o', 'output', 'dry-run', 'patch-file'], alias: { p: 'patch', o: 'output' } });
  const ns = namespaceOf(k, f);
  const t = targets(f.args)[0];
  if (!t || !t.names.length) throw new KubectlError("error: must specify -p to patch\nSee 'kubectl patch -h' for help and examples");
  const raw = typeof f.flags.patch === 'string' ? f.flags.patch : typeof f.flags['patch-file'] === 'string' ? k.ctx.vfs.readFile(k.ctx.resolve(f.flags['patch-file'] as string)) : null;
  if (raw === null) throw new KubectlError("error: must specify --patch or --patch-file containing the contents of the patch\nSee 'kubectl patch -h' for help and examples");
  const type = (f.flags.type as string | undefined) ?? 'strategic';
  if (!['strategic', 'merge', 'json'].includes(type)) throw new KubectlError(`error: --type must be one of [json merge strategic], not "${type}"`);
  let patch: J;
  try {
    patch = parse(raw);
  } catch (e) {
    throw new KubectlError(`error: unable to parse "${raw}": yaml: ${(e as Error).message.split('\n')[0].replace(/ at line.*/, '').toLowerCase()}`);
  }
  authorize(k, 'patch', t.res, ns, t.names[0]);
  const obj = findOne(k, t.res, ns, t.names[0]);
  const before = clean(obj);
  let next: J;
  if (type === 'json') {
    if (!Array.isArray(patch)) throw new KubectlError(`Error from server (BadRequest): json: cannot unmarshal object into Go value of type jsonpatch.Patch`);
    next = jsonPatch(before, patch);
  } else {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new KubectlError('error: unable to parse patch: the patch must be a JSON object');
    next = mergePatch(before, patch, type === 'strategic');
  }
  const q = qualified(obj.kind, obj.metadata.name);
  if (JSON.stringify(next) === JSON.stringify(before)) {
    k.out(`${q} patched (no change)\n`);
    return 0;
  }
  if (f.flags['dry-run']) {
    k.out(`${q} patched (${f.flags['dry-run'] === 'server' ? 'server' : 'client'} dry run)\n`);
    return 0;
  }
  try {
    admit(k.ks, next, k.now, { source: 'patch', mode: 'replace', namespace: obj.metadata.namespace });
  } catch (e) {
    if (e instanceof AdmissionError) throw new KubectlError(e.message.startsWith('The ') ? `Error from server (Invalid): ${e.message}` : e.message);
    throw e;
  }
  k.out(`${q} patched\n`);
  return 0;
}

/** kubectl set selector (resource) NAME 'k=v,k2=v2' */
export function kubectlSetSelector(k: KCtx, argv: string[]): number {
  const f = parseFlags('set selector', argv, { bool: ['all', 'local'], value: ['o', 'output', 'dry-run', 'resource-version'], alias: { o: 'output' } });
  const ns = namespaceOf(k, f);
  const expr = f.args.find((a) => a.includes('=')) ?? (f.args.length >= 3 ? f.args[f.args.length - 1] : undefined);
  const resArgs = f.args.filter((a) => a !== expr);
  if (!expr) throw new KubectlError("error: one selector is required\nSee 'kubectl set selector -h' for help and examples");
  const t = targets(resArgs)[0];
  if (!t || !t.names.length) throw new KubectlError("error: you must specify the type of resource to update\nSee 'kubectl set selector -h' for help and examples");
  const selector: Record<string, string> = {};
  for (const part of expr.split(',').filter(Boolean)) {
    const m = /^([\w./-]+)=([\w.-]*)$/.exec(part.trim());
    if (!m) throw new KubectlError(`error: invalid selector: "${part}"`);
    selector[m[1]] = m[2];
  }
  authorize(k, 'patch', t.res, ns, t.names[0]);
  const obj = findOne(k, t.res, ns, t.names[0]);
  if (obj.kind !== 'Service') throw new KubectlError(`error: the ${obj.kind.toLowerCase()} "${obj.metadata.name}" cannot be updated: selector is immutable or not supported (devquest: set selector works on Services)`);
  obj.spec.selector = selector;
  k.out(`${qualified(obj.kind, obj.metadata.name)} selector updated\n`);
  return 0;
}
