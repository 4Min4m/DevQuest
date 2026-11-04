import { qualified, RESOURCES, ResourceInfo } from '../cluster';
import { columns, customColumns, describe, eventsTable, jsonPath, table, toJson, toYaml, clean } from '../printers';
import type { KObj } from '../types';
import { authorize, findOne, Flags, KCtx, KubectlError, listFor, namespaceOf, notFound, parseFlags, resolveResource, targets, selectorMatches, fieldMatches } from './common';

const ALL = ['Pod', 'Service', 'DaemonSet', 'Deployment', 'ReplicaSet', 'Job'];

function noneFound(k: KCtx, f: Flags, res?: ResourceInfo): void {
  if (f.flags['all-namespaces'] || (res && !res.namespaced)) k.err('No resources found\n');
  else k.err(`No resources found in ${namespaceOf(k, f)} namespace.\n`);
}

function output(k: KCtx, f: Flags, groups: { res: ResourceInfo; objs: KObj[]; named: boolean }[], multiKind: boolean): void {
  const o = (f.flags.output as string | undefined) ?? '';
  const all = groups.flatMap((g) => g.objs);
  const single = groups.length === 1 && groups[0].named && groups[0].objs.length === 1;
  if (o === 'yaml') return k.out(toYaml(all, !single));
  if (o === 'json') return k.out(toJson(all, !single));
  if (o === 'name') return k.out(all.map((x) => qualified(x.kind, x.metadata.name) + '\n').join(''));
  if (o.startsWith('jsonpath=') || o.startsWith('jsonpath-as-json=')) {
    const tpl = o.slice(o.indexOf('=') + 1).replace(/^'(.*)'$/, '$1');
    const data = single ? clean(all[0]) : { apiVersion: 'v1', kind: 'List', items: all.map(clean) };
    return k.out(jsonPath(tpl, data));
  }
  if (o.startsWith('custom-columns=')) return k.out(customColumns(o.slice('custom-columns='.length), all));
  if (o && o !== 'wide') throw new KubectlError(`error: unable to match a printer suitable for the output format "${o}", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,name,template,templatefile,wide,yaml`);
  const allNs = !!f.flags['all-namespaces'];
  const chunks: string[] = [];
  for (const g of groups) {
    if (!g.objs.length) continue;
    const { head, rows } = columns(k.ks, g.res.kind, g.objs, k.now, o === 'wide');
    const nameOf = (x: KObj) => (multiKind ? qualified(x.kind, x.metadata.name) : x.metadata.name);
    const cells = rows.map((r) => [...(allNs && g.res.namespaced ? [r.obj.metadata.namespace!] : []), nameOf(r.obj), ...r.cells.slice(1), ...(f.flags['show-labels'] ? [Object.entries(r.obj.metadata.labels ?? {}).map(([a, b]) => `${a}=${b}`).join(',') || '<none>'] : [])]);
    const header = [...(allNs && g.res.namespaced ? ['NAMESPACE'] : []), ...head, ...(f.flags['show-labels'] ? ['LABELS'] : [])];
    const rendered = table([header, ...cells]);
    chunks.push(f.flags['no-headers'] ? rendered.split('\n').slice(1).join('\n') : rendered);
  }
  k.out(chunks.join('\n'));
}

export function kubectlGet(k: KCtx, argv: string[]): number {
  const f = parseFlags('get', argv, {
    bool: ['show-labels', 'w', 'watch', 'no-headers', 'ignore-not-found'],
    value: ['o', 'output', 'l', 'selector', 'field-selector', 'sort-by'],
    alias: { o: 'output', l: 'selector', w: 'watch' },
  });
  if (!f.args.length) {
    throw new KubectlError(
      'You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.\nUse "kubectl explain <resource>" for a detailed description of that resource (e.g. kubectl explain pods).\nSee \'kubectl get -h\' for help and examples',
    );
  }
  const ns = namespaceOf(k, f);
  const args = f.args[0] === 'all' ? [ALL.map((x) => RESOURCES.find((r) => r.kind === x)!.plural).join(','), ...f.args.slice(1)] : f.args;
  const wanted = targets(args);
  const groups: { res: ResourceInfo; objs: KObj[]; named: boolean }[] = [];
  let code = 0;
  for (const { res, names } of wanted) {
    if (res.kind === 'Event') {
      authorize(k, 'list', res, f.flags['all-namespaces'] ? undefined : ns);
      let evs = k.ks.events.filter((e) => f.flags['all-namespaces'] || e.namespace === ns);
      if (f.flags['field-selector']) {
        evs = evs.filter((e) => fieldMatches({ involvedObject: { name: e.involved.name, kind: e.involved.kind }, type: e.type, reason: e.reason } as unknown as KObj, f.flags['field-selector'] as string));
      }
      evs.sort((a, b) => a.last - b.last);
      if (!evs.length) noneFound(k, f, res);
      else k.out(eventsTable(evs, k.now, !!f.flags['all-namespaces']));
      continue;
    }
    if (names.length) {
      const objs: KObj[] = [];
      for (const n of names) {
        try {
          authorize(k, 'get', res, ns, n);
          objs.push(findOne(k, res, ns, n));
        } catch (e) {
          if (f.flags['ignore-not-found']) continue;
          k.err((e as Error).message + '\n');
          code = 1;
        }
      }
      groups.push({ res, objs, named: true });
    } else {
      authorize(k, 'list', res, f.flags['all-namespaces'] ? undefined : ns);
      groups.push({ res, objs: listFor(k, res, f), named: false });
    }
  }
  if (f.flags['sort-by']) {
    const path = (f.flags['sort-by'] as string).replace(/^\{?\.?/, '').replace(/\}$/, '');
    for (const g of groups) g.objs.sort((a, b) => String(path.split('.').reduce((x: unknown, key) => (x as Record<string, unknown>)?.[key], a) ?? '').localeCompare(String(path.split('.').reduce((x: unknown, key) => (x as Record<string, unknown>)?.[key], b) ?? '')));
  }
  const nonEvent = wanted.filter((w) => w.res.kind !== 'Event');
  if (nonEvent.length && groups.every((g) => !g.objs.length) && !groups.some((g) => g.named)) {
    noneFound(k, f, groups[0]?.res);
    return code;
  }
  output(k, f, groups, groups.length > 1 || f.args[0] === 'all');
  if (f.flags.watch) k.note('devquest: --watch shows one snapshot here; run the command again (or `kubectl rollout status`) to see changes\n');
  return code;
}

export function kubectlDescribe(k: KCtx, argv: string[]): number {
  const f = parseFlags('describe', argv, { value: ['l', 'selector'], alias: { l: 'selector' }, bool: ['show-events'] });
  if (!f.args.length) throw new KubectlError('You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.');
  const ns = namespaceOf(k, f);
  const chunks: string[] = [];
  let code = 0;
  for (const { res, names } of targets(f.args)) {
    let objs: KObj[];
    if (names.length) {
      objs = [];
      for (const n of names) {
        authorize(k, 'get', res, ns, n);
        const all = listFor(k, res, { ...f, flags: { ...f.flags, selector: undefined as unknown as string } }).filter((o) => o.metadata.name === n || o.metadata.name.startsWith(n));
        const exact = all.find((o) => o.metadata.name === n);
        if (exact) objs.push(exact);
        else if (all.length) objs.push(...all);
        else {
          k.err(notFound(res, n).message + '\n');
          code = 1;
        }
      }
    } else {
      authorize(k, 'list', res, f.flags['all-namespaces'] ? undefined : ns);
      objs = listFor(k, res, f);
    }
    if (!names.length && !objs.length) {
      noneFound(k, f, res);
      continue;
    }
    for (const o of objs) chunks.push(describe(k.ks, o, k.now));
    void ns;
  }
  k.out(chunks.join('\n\n'));
  return code;
}

export { selectorMatches, resolveResource };
