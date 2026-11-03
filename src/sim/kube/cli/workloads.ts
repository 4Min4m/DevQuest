import { parseAllDocuments } from 'yaml';
import { joinPath, resolvePath } from '../../vfs/path';
import { isVfsError } from '../../vfs/types';
import { getObj, listObjs, ownedBy, putObj, qualified, removeObj, ResourceInfo } from '../cluster';
import { advance, isTerminating, templateHash } from '../controllers';
import { admit, AdmissionError } from '../manifest';
import { clean, kyaml } from '../printers';
import type { J, KObj } from '../types';
import { findOne, Flags, groupResource, KCtx, KubectlError, listFor, namespaceOf, parseFlags, resolveResource, targets } from './common';



// ------------------------------------------------------------------ reading manifests

interface Doc {
  source: string;
  doc: J;
}

function readManifests(k: KCtx, files: string[], recursive: boolean): Doc[] {
  const out: Doc[] = [];
  const vfs = k.ctx.vfs;
  const parse = (source: string, text: string) => {
    for (const d of parseAllDocuments(text)) {
      if (d.errors.length) {
        const e = d.errors[0];
        const line = (e.linePos?.[0]?.line ?? 1) - 0;
        const what = /Implicit map keys|Nested mappings|mapping/.test(e.message) ? 'mapping values are not allowed in this context' : /tab/i.test(e.message) ? 'found character that cannot start any token' : /seq|sequence/i.test(e.message) ? 'did not find expected \'-\' indicator' : 'did not find expected key';
        throw new KubectlError(`error: error parsing ${source}: error converting YAML to JSON: yaml: line ${line}: ${what}`);
      }
      const v = d.toJS();
      if (v === null || v === undefined) continue;
      if (v.kind === 'List' && Array.isArray(v.items)) for (const it of v.items) out.push({ source, doc: it });
      else out.push({ source, doc: v });
    }
  };
  for (const f of files) {
    if (f === '-') {
      parse('STDIN', k.ctx.stdin);
      continue;
    }
    if (/^https?:\/\//.test(f)) throw new KubectlError(`devquest: applying manifests from URLs is not simulated (no network) — save the YAML to a file first`);
    const abs = resolvePath(k.ctx.state.cwd, f);
    if (!vfs.exists(abs)) throw new KubectlError(`error: the path "${f}" does not exist`);
    if (vfs.isDir(abs)) {
      const walk = (dir: string, rel: string) => {
        for (const name of vfs.readdir(dir).sort()) {
          const p = joinPath(dir, name);
          if (vfs.isDir(p)) {
            if (recursive) walk(p, `${rel}/${name}`);
          } else if (/\.(ya?ml|json)$/.test(name)) parse(`${rel}/${name}`, vfs.readFile(p));
        }
      };
      walk(abs, f.replace(/\/$/, ''));
    } else {
      try {
        parse(f, vfs.readFile(abs));
      } catch (e) {
        if (isVfsError(e)) throw new KubectlError(`error: open ${f}: ${e.message.toLowerCase()}`);
        throw e;
      }
    }
  }
  if (!out.length) throw new KubectlError('error: no objects passed to apply');
  return out;
}

function dryRun(f: Flags): boolean {
  const d = f.flags['dry-run'];
  if (d === undefined || d === 'none') return false;
  if (d === true || d === 'client' || d === 'server') return true;
  throw new KubectlError(`error: Invalid dry-run value (${d}). Must be "none", "server", or "client".`);
}

function applyDocs(k: KCtx, f: Flags, mode: 'apply' | 'create' | 'replace'): number {
  const docs = readManifests(k, f.multi.filename ?? [], !!f.flags.recursive);
  let code = 0;
  const ns = f.flags.namespace as string | undefined;
  const printed: KObj[] = [];
  for (const { source, doc } of docs) {
    try {
      const shadow = dryRun(f) ? JSON.parse(JSON.stringify(k.ks)) : k.ks;
      const r = admit(shadow, doc, k.now, { source, mode, namespace: ns, lastApplied: mode === 'apply' });
      if (!dryRun(f) && r.action === 'created') putObj(k.ks, r.obj);
      if (f.flags.output) printed.push(r.obj);
      else k.out(`${qualified(r.obj.kind, r.obj.metadata.name)} ${r.action}${dryRun(f) ? ` (${f.flags['dry-run'] === 'server' ? 'server' : 'client'} dry run)` : ''}\n`);
    } catch (e) {
      if (!(e instanceof AdmissionError)) throw e;
      k.err(e.message + '\n');
      code = 1;
    }
  }
  if (printed.length) printObjs(k, f, printed);
  return code;
}

function printObjs(k: KCtx, f: Flags, objs: KObj[]): void {
  const o = f.flags.output;
  const body = objs.length === 1 ? clean(objs[0]) : { apiVersion: 'v1', items: objs.map(clean), kind: 'List', metadata: { resourceVersion: '' } };
  if (o === 'yaml') k.out(kyaml(body));
  else if (o === 'json') k.out(JSON.stringify(body, null, 4) + '\n');
  else if (o === 'name') k.out(objs.map((x) => qualified(x.kind, x.metadata.name) + '\n').join(''));
  else throw new KubectlError(`error: unable to match a printer suitable for the output format "${o}", allowed formats are: json,name,yaml`);
}

export function kubectlApply(k: KCtx, argv: string[]): number {
  const f = parseFlags('apply', argv, { bool: ['R', 'recursive', 'force'], value: ['f', 'filename', 'o', 'output', 'dry-run', 'l', 'selector', 'k', 'kustomize'], alias: { f: 'filename', o: 'output', R: 'recursive', l: 'selector', k: 'kustomize' } });
  if (f.flags.kustomize) throw new KubectlError('devquest: kustomize (-k) arrives in a later step; apply the YAML files with -f');
  if (!f.multi.filename?.length) throw new KubectlError("error: must specify one of -f and -k\n\nSee 'kubectl apply -h' for help and examples");
  if (f.flags['dry-run'] === true) f.flags['dry-run'] = 'client';
  return applyDocs(k, f, 'apply');
}

// ------------------------------------------------------------------ create

function dumpOrCreate(k: KCtx, f: Flags, manifest: J): number {
  if (dryRun(f)) {
    if (f.flags.output === 'yaml') k.out(kyaml(manifest));
    else if (f.flags.output === 'json') k.out(JSON.stringify(manifest, null, 4) + '\n');
    else k.out(`${qualified(manifest.kind, manifest.metadata.name)} created (${f.flags['dry-run'] === 'server' ? 'server' : 'client'} dry run)\n`);
    return 0;
  }
  try {
    const r = admit(k.ks, manifest, k.now, { source: 'STDIN', mode: 'create', namespace: f.flags.namespace as string | undefined });
    putObj(k.ks, r.obj);
    if (f.flags.output) printObjs(k, f, [r.obj]);
    else k.out(`${qualified(r.obj.kind, r.obj.metadata.name)} created\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof AdmissionError)) throw e;
    throw new KubectlError(e.message.replace(/error when creating "STDIN": /, ''));
  }
}

const imageName = (img: string) => img.replace(/@.*$/, '').replace(/:[^/:]*$/, '').split('/').pop()!;

function literalPairs(k: KCtx, f: Flags, decode: boolean): Record<string, string> {
  const data: Record<string, string> = {};
  for (const lit of f.multi['from-literal'] ?? []) {
    const eq = lit.indexOf('=');
    if (eq <= 0) throw new KubectlError(`error: invalid literal source ${lit}, expected key=value`);
    data[lit.slice(0, eq)] = lit.slice(eq + 1);
  }
  for (const spec of f.multi['from-file'] ?? []) {
    const eq = spec.indexOf('=');
    const [key, path] = eq > 0 ? [spec.slice(0, eq), spec.slice(eq + 1)] : [spec.split('/').pop()!, spec];
    const abs = resolvePath(k.ctx.state.cwd, path);
    try {
      if (k.ctx.vfs.isDir(abs)) for (const n of k.ctx.vfs.readdir(abs)) data[n] = k.ctx.vfs.readFile(joinPath(abs, n));
      else data[key] = k.ctx.vfs.readFile(abs);
    } catch {
      throw new KubectlError(`error: error reading ${path}: no such file or directory`);
    }
  }
  for (const path of f.multi['from-env-file'] ?? []) {
    let text: string;
    try {
      text = k.ctx.vfs.readFile(resolvePath(k.ctx.state.cwd, path));
    } catch {
      throw new KubectlError(`error: error reading ${path}: no such file or directory`);
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) data[t.slice(0, eq)] = t.slice(eq + 1);
    }
  }
  void decode;
  return data;
}

export function kubectlCreate(k: KCtx, argv: string[]): number {
  const f = parseFlags('create', argv, {
    bool: ['R', 'recursive', 'save-config'],
    value: ['f', 'filename', 'o', 'output', 'dry-run', 'image', 'replicas', 'port', 'from-literal', 'from-file', 'from-env-file', 'tcp', 'node-port', 'type', 'schedule', 'restart'],
    alias: { f: 'filename', o: 'output', R: 'recursive', r: 'replicas' },
  });
  if (f.flags['dry-run'] === true) f.flags['dry-run'] = 'client';
  if (f.multi.filename?.length) return applyDocs(k, f, 'create');
  const [what, a1, a2] = f.args;
  const nsMeta = (name: string) => ({ name, ...(f.flags.namespace ? { namespace: f.flags.namespace } : {}) });
  switch (what) {
    case 'deployment':
    case 'deploy': {
      const name = a1;
      if (!name || !f.flags.image) throw new KubectlError('error: required flag(s) "image" not set');
      const image = f.flags.image as string;
      const container: J = { image, name: imageName(image), resources: {} };
      if (f.rest?.length) container.command = f.rest;
      if (f.flags.port) container.ports = [{ containerPort: Number(f.flags.port) }];
      const labels = { app: name };
      return dumpOrCreate(k, f, {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { creationTimestamp: null, labels, ...nsMeta(name) },
        spec: { replicas: Number(f.flags.replicas ?? 1), selector: { matchLabels: labels }, strategy: {}, template: { metadata: { creationTimestamp: null, labels }, spec: { containers: [container] } } },
        status: {},
      });
    }
    case 'configmap':
    case 'cm': {
      if (!a1) throw new KubectlError('error: exactly one NAME is required, got 0');
      return dumpOrCreate(k, f, { apiVersion: 'v1', data: literalPairs(k, f, false), kind: 'ConfigMap', metadata: { creationTimestamp: null, ...nsMeta(a1) } });
    }
    case 'secret': {
      if (a1 !== 'generic') throw new KubectlError(a1 === 'docker-registry' || a1 === 'tls' ? `devquest: kubectl create secret ${a1} is not simulated; use "generic"` : 'error: you must specify the type of secret (generic, docker-registry, tls)');
      if (!a2) throw new KubectlError('error: exactly one NAME is required, got 0');
      const data = Object.fromEntries(Object.entries(literalPairs(k, f, false)).map(([key, v]) => [key, btoa(unescape(encodeURIComponent(v)))]));
      return dumpOrCreate(k, f, { apiVersion: 'v1', data, kind: 'Secret', metadata: { creationTimestamp: null, ...nsMeta(a2) } });
    }
    case 'namespace':
    case 'ns':
      if (!a1) throw new KubectlError('error: exactly one NAME is required, got 0');
      return dumpOrCreate(k, f, { apiVersion: 'v1', kind: 'Namespace', metadata: { creationTimestamp: null, name: a1 }, spec: {}, status: {} });
    case 'service':
    case 'svc': {
      const type = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer' }[a1 ?? ''];
      if (!type || !a2) throw new KubectlError('error: create service requires a type: clusterip, nodeport or loadbalancer, and a NAME');
      const ports = (f.multi.tcp ?? []).map((t) => {
        const [port, target] = t.split(':');
        return { name: `${port}-${target ?? port}`, port: Number(port), protocol: 'TCP', targetPort: Number(target ?? port), ...(f.flags['node-port'] ? { nodePort: Number(f.flags['node-port']) } : {}) };
      });
      if (!ports.length) throw new KubectlError('error: at least one tcp port specifier must be provided');
      return dumpOrCreate(k, f, { apiVersion: 'v1', kind: 'Service', metadata: { creationTimestamp: null, labels: { app: a2 }, ...nsMeta(a2) }, spec: { ports, selector: { app: a2 }, type }, status: { loadBalancer: {} } });
    }
    case 'job': {
      if (!a1 || !f.flags.image) throw new KubectlError('error: required flag(s) "image" not set');
      const container: J = { image: f.flags.image, name: a1, resources: {} };
      if (f.rest?.length) container.command = f.rest;
      return dumpOrCreate(k, f, { apiVersion: 'batch/v1', kind: 'Job', metadata: { creationTimestamp: null, ...nsMeta(a1) }, spec: { template: { metadata: { creationTimestamp: null }, spec: { containers: [container], restartPolicy: 'Never' } } }, status: {} });
    }
    case undefined:
      throw new KubectlError("error: must specify one of -f and -k\n\nSee 'kubectl create -h' for help and examples");
    default:
      throw new KubectlError(`devquest: kubectl create ${what} is not simulated (try deployment, configmap, secret generic, namespace, service, job, or -f FILE)`);
  }
}

// ------------------------------------------------------------------ run

export function kubectlRun(k: KCtx, argv: string[]): number {
  const f = parseFlags('run', argv, {
    bool: ['rm', 'i', 'stdin', 't', 'tty', 'command', 'quiet', 'q'],
    value: ['image', 'port', 'env', 'labels', 'l', 'restart', 'o', 'output', 'dry-run', 'image-pull-policy'],
    alias: { o: 'output', i: 'stdin', t: 'tty', l: 'labels', q: 'quiet' },
  });
  if (f.flags['dry-run'] === true) f.flags['dry-run'] = 'client';
  const name = f.args[0];
  if (!name) throw new KubectlError('error: NAME is required for run\nSee \'kubectl run -h\' for help and examples');
  if (!f.flags.image) throw new KubectlError('error: required flag(s) "image" not set');
  const labels: Record<string, string> = {};
  for (const l of ((f.flags.labels as string) ?? `run=${name}`).split(',')) {
    const [a, b] = l.split('=');
    labels[a] = b ?? '';
  }
  const restart = (f.flags.restart as string) ?? (f.flags.rm ? 'Never' : 'Always');
  const container: J = { image: f.flags.image, name, resources: {} };
  if (f.flags['image-pull-policy']) container.imagePullPolicy = f.flags['image-pull-policy'];
  if (f.rest?.length) {
    if (f.flags.command) container.command = f.rest;
    else container.args = f.rest;
  }
  if (f.flags.stdin) container.stdin = true;
  if (f.flags.tty) container.tty = true;
  if (f.multi.env?.length) container.env = f.multi.env.map((e) => ({ name: e.split('=')[0], value: e.split('=').slice(1).join('=') }));
  if (f.flags.port) container.ports = [{ containerPort: Number(f.flags.port) }];
  const manifest: J = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { creationTimestamp: null, labels, name, ...(f.flags.namespace ? { namespace: f.flags.namespace } : {}) },
    spec: { containers: [container], dnsPolicy: 'ClusterFirst', restartPolicy: restart },
    status: {},
  };
  if (dryRun(f)) return dumpOrCreate(k, f, manifest);
  if (f.flags.rm && !f.flags.stdin) throw new KubectlError('error: --rm should only be used for attached containers');
  const ns = namespaceOf(k, f);
  if (getObj(k.ks, 'Pod', ns, name)) throw new KubectlError(`Error from server (AlreadyExists): pods "${name}" already exists`);
  try {
    putObj(k.ks, admit(k.ks, manifest, k.now, { source: 'STDIN', mode: 'create', namespace: ns }).obj);
  } catch (e) {
    if (e instanceof AdmissionError) throw new KubectlError(e.message);
    throw e;
  }
  if (!f.flags.stdin) {
    k.out(`pod/${name} created\n`);
    return 0;
  }
  // Attached: wait for the container to run, then show its output (or attach a shell).
  let pod = getObj(k.ks, 'Pod', ns, name)!;
  for (let i = 0; i < 30; i++) {
    advance(k.ctx.state, 1000);
    pod = getObj(k.ks, 'Pod', ns, name)!;
    const st = pod.status?.containerStatuses?.[0]?.state;
    if (st?.running || st?.terminated || st?.waiting?.reason === 'CrashLoopBackOff' || /Err|BackOff|Error/.test(st?.waiting?.reason ?? '')) break;
  }
  const st = pod.status?.containerStatuses?.[0]?.state;
  if (st?.waiting && /Image|Err/.test(st.waiting.reason)) {
    k.err(`error: timed out waiting for the condition\n`);
    return 1;
  }
  const rt = k.ks.runtime[pod.metadata.uid];
  const runs = rt?.containers[name]?.runs ?? [];
  const shellCmd = (f.rest ?? []).length === 1 && ['sh', '/bin/sh', 'bash', '/bin/bash', 'ash'].includes(f.rest![0]);
  if (!f.rest?.length || shellCmd) {
    if (!f.flags.tty) {
      k.err('error: the shell needs a terminal; use -it\n');
      return 1;
    }
    k.note("If you don't see a command prompt, try pressing enter.\n");
    return attachShell(k, pod, name, f.rest?.[0] ?? 'sh', !!f.flags.rm, ns);
  }
  const logs = runs[0]?.logs ?? [];
  k.out(logs.map((l) => l.text + '\n').join(''));
  const exit = runs[0]?.exitCode ?? 0;
  if (f.flags.rm) {
    removeObj(k.ks, pod);
    k.out(`pod "${name}" deleted from ${ns} namespace\n`);
  }
  if (exit !== 0) {
    k.err(`pod ${ns}/${name} terminated (Error)\n`);
    return 1;
  }
  return 0;
}

/** Replaced by pods.ts (kept here to avoid a cycle). */
let attachShell: (k: KCtx, pod: KObj, container: string, shell: string, rm: boolean, ns: string) => number = () => 1;
export function setAttach(fn: typeof attachShell): void {
  attachShell = fn;
}

// ------------------------------------------------------------------ delete

export function kubectlDelete(k: KCtx, argv: string[]): number {
  const f = parseFlags('delete', argv, {
    bool: ['all', 'force', 'now', 'ignore-not-found', 'R', 'recursive', 'wait'],
    value: ['f', 'filename', 'l', 'selector', 'grace-period', 'field-selector', 'cascade', 'o', 'output', 'dry-run'],
    alias: { f: 'filename', l: 'selector', R: 'recursive', o: 'output' },
  });
  const ns = namespaceOf(k, f);
  const victims: { res: ResourceInfo | null; obj: KObj }[] = [];
  let code = 0;
  if (f.multi.filename?.length) {
    for (const { doc } of readManifests(k, f.multi.filename, !!f.flags.recursive)) {
      const res = resolveResource(doc.kind);
      const o = getObj(k.ks, doc.kind, doc.metadata?.namespace ?? ns, doc.metadata?.name);
      if (!o) {
        if (!f.flags['ignore-not-found']) {
          k.err(`Error from server (NotFound): error when deleting "${f.multi.filename[0]}": ${groupResource(res)} "${doc.metadata?.name}" not found\n`);
          code = 1;
        }
        continue;
      }
      victims.push({ res, obj: o });
    }
  } else {
    if (!f.args.length) throw new KubectlError('error: You must provide one or more resources by argument or filename.\nExample resource specifications include:\n   \'-f rsrc.yaml\'\n   \'--filename=rsrc.json\'\n   \'<resource> <name>\'\n   \'<resource>\'');
    for (const { res, names } of targets(f.args)) {
      if (names.length) {
        for (const n of names) {
          const o = getObj(k.ks, res.kind, ns, n);
          if (!o) {
            if (!f.flags['ignore-not-found']) {
              k.err(`Error from server (NotFound): ${groupResource(res)} "${n}" not found\n`);
              code = 1;
            }
            continue;
          }
          victims.push({ res, obj: o });
        }
      } else if (f.flags.all || f.flags.selector || f.flags['field-selector']) {
        for (const o of listFor(k, res, f)) victims.push({ res, obj: o });
        if (!victims.length) k.err(`No resources found\n`);
      } else throw new KubectlError(`error: resource(s) were provided, but no name was specified`);
    }
  }
  for (const { obj } of victims) {
    if (obj.kind === 'Namespace' && ['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(obj.metadata.name)) {
      k.err(`Error from server (Forbidden): namespaces "${obj.metadata.name}" is forbidden: this namespace may not be deleted\n`);
      code = 1;
      continue;
    }
    k.out(`${qualified(obj.kind, obj.metadata.name).replace(/\/(.*)$/, ' "$1"')} deleted${obj.kind === 'Pod' || obj.kind === 'Namespace' ? '' : ''}\n`);
    deleteObject(k, obj, f.flags.force === true && f.flags['grace-period'] === '0');
  }
  // `kubectl delete` waits until the objects are gone.
  if (victims.some((v) => v.obj.kind === 'Pod') && f.flags.wait !== 'false') advance(k.ctx.state, 2000);
  return code;
}

export function deleteObject(k: KCtx, obj: KObj, force = false): void {
  if (obj.kind === 'Pod') {
    if (force) removeObj(k.ks, obj);
    else if (!isTerminating(obj)) obj.metadata.deletionTimestamp = new Date(k.now).toISOString().replace(/\.\d+Z$/, 'Z');
    return;
  }
  if (obj.kind === 'Namespace') {
    for (const kind of Object.keys(k.ks.objects)) for (const o of listObjs(k.ks, kind, obj.metadata.name)) deleteObject(k, o, true);
    k.ks.events = k.ks.events.filter((e) => e.namespace !== obj.metadata.name);
    removeObj(k.ks, obj);
    return;
  }
  if (obj.kind === 'Service') {
    const ep = getObj(k.ks, 'Endpoints', obj.metadata.namespace, obj.metadata.name);
    if (ep) removeObj(k.ks, ep);
  }
  removeObj(k.ks, obj);
}

// ------------------------------------------------------------------ edit

export function kubectlEdit(k: KCtx, argv: string[]): number {
  const f = parseFlags('edit', argv, { value: ['o', 'output'], alias: { o: 'output' } });
  const ns = namespaceOf(k, f);
  const t = targets(f.args);
  if (!t.length || !t[0].names.length) throw new KubectlError('error: edit needs a resource and a name, e.g. kubectl edit deployment/web');
  const obj = findOne(k, t[0].res, ns, t[0].names[0]);
  const shown = clean(obj);
  const header = `# Please edit the object below. Lines beginning with a '#' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n`;
  const ks = k.ks;
  const now = k.now;
  k.ctx.shell.edit({
    display: `/tmp/kubectl-edit-${t[0].names[0]}.yaml`,
    editor: 'vi',
    content: header + kyaml(shown),
    save(text: string): string | null {
      try {
        const docs = parseAllDocuments(text);
        if (docs[0]?.errors.length) return `error: ${docs[0].errors[0].message.split('\n')[0]}`;
        const doc = docs[0]?.toJS();
        if (!doc) return 'Edit cancelled, no changes made.';
        if (doc.metadata?.name !== obj.metadata.name || doc.kind !== obj.kind) return 'error: the name and kind of the object can not be changed';
        admit(ks, doc, now, { source: 'edit', mode: 'replace', namespace: obj.metadata.namespace });
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
  });
  return 0;
}

// ------------------------------------------------------------------ expose / scale / set / label

function selectorOf(o: KObj): Record<string, string> {
  if (o.kind === 'Pod') return { ...(o.metadata.labels ?? {}) };
  if (o.kind === 'Service') return { ...(o.spec.selector ?? {}) };
  return { ...(o.spec.selector?.matchLabels ?? {}) };
}

export function kubectlExpose(k: KCtx, argv: string[]): number {
  const f = parseFlags('expose', argv, { value: ['port', 'target-port', 'type', 'name', 'protocol', 'o', 'output', 'dry-run', 'selector', 'labels', 'l'], alias: { o: 'output', l: 'labels' } });
  if (f.flags['dry-run'] === true) f.flags['dry-run'] = 'client';
  const ns = namespaceOf(k, f);
  const t = targets(f.args)[0];
  if (!t || !t.names.length) throw new KubectlError('error: You must provide one or more resources by argument or filename.');
  const src = findOne(k, t.res, ns, t.names[0]);
  if (!['Pod', 'Deployment', 'ReplicaSet', 'Service'].includes(src.kind)) throw new KubectlError(`error: cannot expose a ${src.kind}`);
  const containers = src.kind === 'Pod' ? src.spec.containers : src.spec.template?.spec?.containers ?? [];
  const introspected = containers.flatMap((c: J) => c.ports ?? [])[0]?.containerPort;
  const port = f.flags.port ? Number(f.flags.port) : introspected;
  if (!port) throw new KubectlError(`error: couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples`);
  const target = f.flags['target-port'] ? (/^\d+$/.test(f.flags['target-port'] as string) ? Number(f.flags['target-port']) : f.flags['target-port']) : port;
  const name = (f.flags.name as string) ?? src.metadata.name;
  const manifest: J = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { creationTimestamp: null, ...(src.metadata.labels ? { labels: src.metadata.labels } : {}), name },
    spec: { ports: [{ port, protocol: (f.flags.protocol as string) ?? 'TCP', targetPort: target }], selector: selectorOf(src), ...(f.flags.type ? { type: f.flags.type } : {}) },
    status: { loadBalancer: {} },
  };
  if (dryRun(f)) {
    if (f.flags.output === 'yaml') k.out(kyaml(manifest));
    else k.out(`service/${name} exposed (dry run)\n`);
    return 0;
  }
  try {
    const r = admit(k.ks, manifest, k.now, { source: 'STDIN', mode: 'create', namespace: ns });
    putObj(k.ks, r.obj);
  } catch (e) {
    if (e instanceof AdmissionError) throw new KubectlError(e.message.replace(/error when creating "STDIN": /, ''));
    throw e;
  }
  k.out(`service/${name} exposed\n`);
  return 0;
}

function workload(k: KCtx, f: Flags, verb: string): KObj[] {
  const ns = namespaceOf(k, f);
  if (!f.args.length && !f.flags.selector) throw new KubectlError(`error: required resource not specified\nSee 'kubectl ${verb} -h' for help and examples`);
  const out: KObj[] = [];
  for (const { res, names } of targets(f.args)) {
    if (names.length) for (const n of names) out.push(findOne(k, res, ns, n));
    else out.push(...listFor(k, res, f));
  }
  return out;
}

export function kubectlScale(k: KCtx, argv: string[]): number {
  const f = parseFlags('scale', argv, { bool: ['all'], value: ['replicas', 'current-replicas', 'l', 'selector', 'timeout'], alias: { l: 'selector' } });
  if (f.flags.replicas === undefined) throw new KubectlError('error: required flag(s) "replicas" not set');
  const n = Number(f.flags.replicas);
  if (!Number.isInteger(n) || n < 0) throw new KubectlError('error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0');
  for (const o of workload(k, f, 'scale')) {
    if (!['Deployment', 'ReplicaSet'].includes(o.kind)) throw new KubectlError(`error: no objects passed to scale ${o.kind.toLowerCase()} "${o.metadata.name}"`);
    if (o.spec.replicas !== n) {
      o.spec.replicas = n;
      o.metadata.generation = (o.metadata.generation ?? 1) + 1;
    }
    k.out(`${qualified(o.kind, o.metadata.name)} scaled\n`);
  }
  return 0;
}

function templateOf(o: KObj): J {
  if (o.kind === 'Pod') return { spec: o.spec };
  if (!o.spec.template) throw new KubectlError(`error: ${o.kind.toLowerCase()} "${o.metadata.name}" has no pod template`);
  return o.spec.template;
}

function changed(o: KObj, cause?: string): void {
  o.metadata.generation = (o.metadata.generation ?? 1) + 1;
  if (cause) o.metadata.annotations = { ...(o.metadata.annotations ?? {}), 'kubernetes.io/change-cause': cause };
}

export function kubectlSet(k: KCtx, argv: string[]): number {
  const [what, ...rest] = argv;
  if (what === 'image') {
    const f = parseFlags('set image', rest, { bool: ['record', 'all'], value: ['l', 'selector'], alias: { l: 'selector' } });
    const assigns = f.args.filter((a) => a.includes('='));
    f.args = f.args.filter((a) => !a.includes('='));
    if (!assigns.length) throw new KubectlError('error: at least one image update is required');
    for (const o of workload(k, f, 'set image')) {
      const t = templateOf(o);
      for (const a of assigns) {
        const [cname, image] = a.split('=');
        const cs = (t.spec.containers as J[]).filter((c) => cname === '*' || c.name === cname);
        if (!cs.length) throw new KubectlError(`error: unable to find container named "${cname}"`);
        for (const c of cs) c.image = image;
      }
      if (o.kind !== 'Pod') changed(o);
      k.out(`${qualified(o.kind, o.metadata.name)} image updated\n`);
    }
    return 0;
  }
  if (what === 'env') {
    const f = parseFlags('set env', rest, { bool: ['list', 'all', 'overwrite'], value: ['c', 'containers', 'from', 'l', 'selector', 'e', 'env'], alias: { c: 'containers', l: 'selector', e: 'env' } });
    const assigns = [...f.args.filter((a) => /^[A-Za-z_][\w]*=|^[A-Za-z_][\w]*-$/.test(a)), ...(f.multi.env ?? [])];
    f.args = f.args.filter((a) => !/^[A-Za-z_][\w]*=|^[A-Za-z_][\w]*-$/.test(a));
    for (const o of workload(k, f, 'set env')) {
      const t = templateOf(o);
      if (f.flags.list) {
        for (const c of t.spec.containers) {
          k.out(`# ${o.kind.toLowerCase()}s/${o.metadata.name}, container ${c.name}\n`);
          for (const e of c.env ?? []) k.out(e.value !== undefined ? `${e.name}=${e.value}\n` : `# ${e.name} from ${e.valueFrom?.configMapKeyRef ? `configmap ${e.valueFrom.configMapKeyRef.name}, key ${e.valueFrom.configMapKeyRef.key}` : e.valueFrom?.secretKeyRef ? `secret ${e.valueFrom.secretKeyRef.name}, key ${e.valueFrom.secretKeyRef.key}` : 'field'}\n`);
        }
        continue;
      }
      for (const c of t.spec.containers as J[]) {
        if (f.flags.containers && f.flags.containers !== c.name && f.flags.containers !== '*') continue;
        c.env ??= [];
        for (const a of assigns) {
          if (a.endsWith('-')) c.env = c.env.filter((e: J) => e.name !== a.slice(0, -1));
          else {
            const [key, ...v] = a.split('=');
            const ex = c.env.find((e: J) => e.name === key);
            if (ex) {
              ex.value = v.join('=');
              delete ex.valueFrom;
            } else c.env.push({ name: key, value: v.join('=') });
          }
        }
        if (f.flags.from) {
          // Like kubectl: one env var per key, each referencing the ConfigMap / Secret.
          const [type, name] = (f.flags.from as string).split('/');
          const secret = type.startsWith('secret');
          const src = getObj(k.ks, secret ? 'Secret' : 'ConfigMap', o.metadata.namespace, name);
          if (!src) throw new KubectlError(`error: ${secret ? 'secrets' : 'configmaps'} "${name}" not found`);
          for (const key of Object.keys(src.data ?? {})) {
            const envName = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
            c.env = c.env.filter((e: J) => e.name !== envName);
            c.env.push({ name: envName, valueFrom: { [secret ? 'secretKeyRef' : 'configMapKeyRef']: { key, name } } });
          }
        }
        if (!c.env.length) delete c.env;
      }
      changed(o);
      k.out(`${qualified(o.kind, o.metadata.name)} env updated\n`);
    }
    return 0;
  }
  if (what === 'resources') {
    const f = parseFlags('set resources', rest, { bool: ['all'], value: ['c', 'containers', 'limits', 'requests', 'l', 'selector'], alias: { c: 'containers', l: 'selector' } });
    const parse = (s: string | true | undefined) => Object.fromEntries(String(s ?? '').split(',').filter(Boolean).map((p) => p.split('=')));
    for (const o of workload(k, f, 'set resources')) {
      for (const c of templateOf(o).spec.containers as J[]) {
        if (f.flags.containers && f.flags.containers !== c.name && f.flags.containers !== '*') continue;
        c.resources ??= {};
        if (f.flags.limits) c.resources.limits = { ...(c.resources.limits ?? {}), ...parse(f.flags.limits) };
        if (f.flags.requests) c.resources.requests = { ...(c.resources.requests ?? {}), ...parse(f.flags.requests) };
      }
      changed(o);
      k.out(`${qualified(o.kind, o.metadata.name)} resource requirements updated\n`);
    }
    return 0;
  }
  throw new KubectlError(`devquest: kubectl set ${what ?? ''} is not simulated (try image, env, resources)`);
}

export function kubectlLabel(k: KCtx, argv: string[], annotate = false): number {
  const verb = annotate ? 'annotate' : 'label';
  const f = parseFlags(verb, argv, { bool: ['overwrite', 'all', 'list'], value: ['l', 'selector'], alias: { l: 'selector' } });
  const changes = f.args.filter((a) => /^[\w./-]+=|^[\w./-]+-$/.test(a));
  f.args = f.args.filter((a) => !changes.includes(a));
  if (!changes.length && !f.flags.list) throw new KubectlError(`error: at least one ${verb} update is required`);
  for (const o of workload(k, f, verb)) {
    const field = annotate ? 'annotations' : 'labels';
    const cur: Record<string, string> = { ...(o.metadata[field] ?? {}) };
    let did = false;
    for (const c of changes) {
      if (c.endsWith('-')) {
        if (c.slice(0, -1) in cur) did = true;
        delete cur[c.slice(0, -1)];
        continue;
      }
      const [key, ...v] = c.split('=');
      const val = v.join('=');
      if (key in cur && cur[key] !== val && !f.flags.overwrite) throw new KubectlError(`error: '${key}' already has a value (${cur[key]}), and --overwrite is false`);
      if (cur[key] !== val) did = true;
      cur[key] = val;
    }
    o.metadata[field] = cur;
    if (!Object.keys(cur).length) delete o.metadata[field];
    k.out(`${qualified(o.kind, o.metadata.name)} ${did ? (annotate ? 'annotated' : 'labeled') : 'not ' + (annotate ? 'annotated' : 'labeled')}\n`);
  }
  return 0;
}

// ------------------------------------------------------------------ rollout

function revisions(k: KCtx, d: KObj): { rev: number; rs: KObj }[] {
  return ownedBy(k.ks, 'ReplicaSet', d)
    .map((rs) => ({ rev: Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0), rs }))
    .sort((a, b) => a.rev - b.rev);
}

function rolloutState(d: KObj): { done: boolean; msg: string; failed?: boolean } {
  const s = d.status ?? {};
  const desired = d.spec.replicas ?? 1;
  const name = d.metadata.name;
  if ((s.conditions ?? []).some((c: J) => c.type === 'Progressing' && c.reason === 'ProgressDeadlineExceeded')) return { done: false, failed: true, msg: `error: deployment "${name}" exceeded its progress deadline` };
  if ((s.updatedReplicas ?? 0) < desired) return { done: false, msg: `Waiting for deployment "${name}" rollout to finish: ${s.updatedReplicas ?? 0} out of ${desired} new replicas have been updated...` };
  if ((s.replicas ?? 0) > (s.updatedReplicas ?? 0)) return { done: false, msg: `Waiting for deployment "${name}" rollout to finish: ${(s.replicas ?? 0) - (s.updatedReplicas ?? 0)} old replicas are pending termination...` };
  if ((s.availableReplicas ?? 0) < (s.updatedReplicas ?? 0)) return { done: false, msg: `Waiting for deployment "${name}" rollout to finish: ${s.availableReplicas ?? 0} of ${s.updatedReplicas} updated replicas are available...` };
  return { done: true, msg: `deployment "${name}" successfully rolled out` };
}

export function kubectlRollout(k: KCtx, argv: string[]): number {
  const [sub, ...rest] = argv;
  const f = parseFlags(`rollout ${sub}`, rest, { bool: ['w', 'watch'], value: ['to-revision', 'revision', 'timeout'], alias: { w: 'watch' } });
  const ns = namespaceOf(k, f);
  const t = targets(f.args)[0];
  if (!t?.names.length) throw new KubectlError(`error: required resource not specified\nSee 'kubectl rollout ${sub} -h' for help and examples`);
  if (t.res.kind !== 'Deployment' && t.res.kind !== 'DaemonSet') throw new KubectlError(`error: no rollout${sub === 'history' ? ' history' : ''} support for ${t.res.kind.toLowerCase()}s`);
  const d = findOne(k, t.res, ns, t.names[0]);
  const q = qualified(d.kind, d.metadata.name);
  switch (sub) {
    case 'status': {
      if (d.kind === 'DaemonSet') {
        k.out(`daemon set "${d.metadata.name}" successfully rolled out\n`);
        return 0;
      }
      let last = '';
      for (let i = 0; i <= 120; i++) {
        const cur = getObj(k.ks, 'Deployment', ns, d.metadata.name);
        if (!cur) throw new KubectlError(`error: deployment "${d.metadata.name}" not found`);
        const st = rolloutState(cur);
        if (st.failed) throw new KubectlError(st.msg);
        if (st.msg !== last) {
          if (st.done) {
            k.out(st.msg + '\n');
            return 0;
          }
          k.out(st.msg + '\n');
          last = st.msg;
        }
        advance(k.ctx.state, 1000);
      }
      k.note('devquest: stopped waiting after 2 minutes. A real `rollout status` keeps waiting until the progress deadline (10 minutes) — something is blocking this rollout; check `kubectl get pods` and `kubectl describe`.\n');
      return 1;
    }
    case 'history': {
      const revs = revisions(k, d);
      if (f.flags.revision) {
        const r = revs.find((x) => x.rev === Number(f.flags.revision));
        if (!r) throw new KubectlError(`error: unable to find the specified revision`);
        k.out(`${q} with revision #${r.rev}\nPod Template:\n${kyaml(clean(r.rs.spec.template)).replace(/^/gm, '  ')}`);
        return 0;
      }
      k.out(`${q} \nREVISION  CHANGE-CAUSE\n${revs.map((r) => `${String(r.rev).padEnd(10)}${r.rs.metadata.annotations?.['kubernetes.io/change-cause'] ?? '<none>'}\n`).join('')}\n`);
      return 0;
    }
    case 'undo': {
      const revs = revisions(k, d);
      const current = Number(d.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
      const target = f.flags['to-revision'] && f.flags['to-revision'] !== '0' ? revs.find((r) => r.rev === Number(f.flags['to-revision'])) : [...revs].reverse().find((r) => r.rev < current);
      if (!target) throw new KubectlError(f.flags['to-revision'] ? `error: unable to find specified revision ${f.flags['to-revision']} in history` : `error: no rollout history found for deployment "${d.metadata.name}"`);
      if (target.rev === current) {
        k.out(`${q} skipped rollback (current template already matches revision ${target.rev})\n`);
        return 0;
      }
      const tpl = JSON.parse(JSON.stringify(target.rs.spec.template));
      delete tpl.metadata.labels['pod-template-hash'];
      d.spec.template = tpl;
      changed(d);
      if (d.metadata.annotations) delete d.metadata.annotations['kubernetes.io/change-cause'];
      k.out(`${q} rolled back\n`);
      return 0;
    }
    case 'restart': {
      const tpl = d.spec.template;
      tpl.metadata = { ...(tpl.metadata ?? {}), annotations: { ...(tpl.metadata?.annotations ?? {}), 'kubectl.kubernetes.io/restartedAt': new Date(k.now).toISOString().replace(/\.\d+Z$/, 'Z') } };
      changed(d);
      k.out(`${q} restarted\n`);
      return 0;
    }
    case 'pause':
    case 'resume': {
      const want = sub === 'pause';
      if (!!d.spec.paused === want) throw new KubectlError(`error: ${d.kind.toLowerCase()}s.apps "${d.metadata.name}" is already ${want ? 'paused' : 'resumed'}`);
      d.spec.paused = want || undefined;
      if (!want) delete d.spec.paused;
      k.out(`${q} ${want ? 'paused' : 'resumed'}\n`);
      return 0;
    }
  }
  throw new KubectlError(`error: unknown command "${sub ?? ''}" for "kubectl rollout"\nAvailable Commands: history, pause, restart, resume, status, undo`);
}

export { templateHash };
