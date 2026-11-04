/** How kubectl prints things: get tables, describe, -o yaml/json/name/jsonpath/custom-columns. */
import { stringify } from 'yaml';
import { eventsFor, getObj, infoOf, listObjs, ownedBy, parseIso, qualified } from './cluster';
import { isTerminating, podRequests, templateHash } from './controllers';
import { cpuMilli, humanDuration, memBytes } from './quantity';
import type { J, KEvent, KObj, KubeState } from './types';
import { columns2, describe2 } from './printers2';

// ------------------------------------------------------------------ table layout

/** tabwriter-style columns: padded to the widest cell + 3 spaces, last column unpadded. */
export function table(rows: string[][]): string {
  if (!rows.length) return '';
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 3))).join('').trimEnd() + '\n').join('');
}

const age = (o: KObj, now: number) => humanDuration(now - parseIso(o.metadata.creationTimestamp));
const labelsText = (l?: Record<string, string>) => (l && Object.keys(l).length ? Object.entries(l).map(([k, v]) => `${k}=${v}`).join(',') : '<none>');
const selectorText = (sel: J) => {
  const ml = sel?.matchLabels ?? sel ?? {};
  const parts = Object.entries(ml).map(([k, v]) => `${k}=${v}`);
  for (const e of sel?.matchExpressions ?? []) parts.push(`${e.key} ${e.operator.toLowerCase()} (${(e.values ?? []).join(',')})`);
  return parts.length ? parts.join(',') : '<none>';
};

// ------------------------------------------------------------------ pod status (kubectl's printPod logic)

export function podStatusText(p: KObj): string {
  let reason: string = p.status?.reason ?? p.status?.phase ?? 'Pending';
  let initializing = false;
  void initializing;
  const statuses: J[] = p.status?.containerStatuses ?? [];
  let hasRunning = false;
  for (let i = statuses.length - 1; i >= 0; i--) {
    const c = statuses[i];
    if (c.state?.waiting?.reason) reason = c.state.waiting.reason;
    else if (c.state?.terminated?.reason) reason = c.state.terminated.reason;
    else if (c.state?.terminated) reason = c.state.terminated.signal ? `Signal:${c.state.terminated.signal}` : `ExitCode:${c.state.terminated.exitCode}`;
    else if (c.ready && c.state?.running) hasRunning = true;
  }
  if (reason === 'Completed' && hasRunning) reason = 'Running';
  if (!statuses.length && p.spec.nodeName && reason === 'Pending') reason = 'ContainerCreating';
  if (!p.spec.nodeName && reason === 'Pending') reason = 'Pending';
  if (isTerminating(p)) reason = 'Terminating';
  return reason;
}

export function podReadyText(p: KObj): string {
  const statuses: J[] = p.status?.containerStatuses ?? [];
  return `${statuses.filter((c) => c.ready).length}/${p.spec.containers.length}`;
}

export function podRestarts(p: KObj, now: number): string {
  const statuses: J[] = p.status?.containerStatuses ?? [];
  const n = statuses.reduce((s, c) => s + (c.restartCount ?? 0), 0);
  const lastFinish = Math.max(0, ...statuses.map((c) => parseIso(c.lastState?.terminated?.finishedAt)));
  return n && lastFinish ? `${n} (${humanDuration(now - lastFinish)} ago)` : String(n);
}

// ------------------------------------------------------------------ get tables

type Row = { obj: KObj; cells: string[] };

function serviceType(s: KObj): string {
  return s.spec.type ?? 'ClusterIP';
}

function servicePorts(s: KObj): string {
  const ports = (s.spec.ports ?? []).map((p: J) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`);
  return ports.length ? ports.join(',') : '<none>';
}

function endpointsText(ep: KObj | undefined): string {
  const addrs: string[] = [];
  for (const s of ep?.subsets ?? []) for (const a of s.addresses ?? []) for (const port of s.ports ?? []) addrs.push(`${a.ip}:${port.port}`);
  if (!addrs.length) return '<none>';
  return addrs.length > 3 ? `${addrs.slice(0, 3).join(',')} + ${addrs.length - 3} more...` : addrs.join(',');
}

function images(o: KObj): { names: string; images: string } {
  const cs = o.spec.template?.spec?.containers ?? o.spec.containers ?? [];
  return { names: cs.map((c: J) => c.name).join(','), images: cs.map((c: J) => c.image).join(',') };
}

export function columns(_ks: KubeState, kind: string, objs: KObj[], now: number, wide: boolean): { head: string[]; rows: Row[] } {
  switch (kind) {
    case 'Pod':
      return {
        head: ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : [])],
        rows: objs.map((p) => ({
          obj: p,
          cells: [p.metadata.name, podReadyText(p), podStatusText(p), podRestarts(p, now), age(p, now), ...(wide ? [p.status?.podIP ?? '<none>', p.spec.nodeName ?? '<none>', '<none>', '<none>'] : [])],
        })),
      };
    case 'Deployment':
      return {
        head: ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])],
        rows: objs.map((d) => {
          const i = images(d);
          return { obj: d, cells: [d.metadata.name, `${d.status?.readyReplicas ?? 0}/${d.spec.replicas ?? 1}`, String(d.status?.updatedReplicas ?? 0), String(d.status?.availableReplicas ?? 0), age(d, now), ...(wide ? [i.names, i.images, selectorText(d.spec.selector)] : [])] };
        }),
      };
    case 'ReplicaSet':
      return {
        head: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])],
        rows: objs.map((r) => {
          const i = images(r);
          return { obj: r, cells: [r.metadata.name, String(r.spec.replicas ?? 1), String(r.status?.replicas ?? 0), String(r.status?.readyReplicas ?? 0), age(r, now), ...(wide ? [i.names, i.images, selectorText(r.spec.selector)] : [])] };
        }),
      };
    case 'DaemonSet':
      return {
        head: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])],
        rows: objs.map((d) => {
          const s = d.status ?? {};
          const i = images(d);
          return {
            obj: d,
            cells: [d.metadata.name, String(s.desiredNumberScheduled ?? 0), String(s.currentNumberScheduled ?? 0), String(s.numberReady ?? 0), String(s.updatedNumberScheduled ?? 0), String(s.numberAvailable ?? 0), labelsText(d.spec.template.spec.nodeSelector).replace(/,/g, ','), age(d, now), ...(wide ? [i.names, i.images, selectorText(d.spec.selector)] : [])],
          };
        }),
      };
    case 'Job':
      return {
        head: ['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])],
        rows: objs.map((j) => {
          const st = j.status ?? {};
          const done = (st.conditions ?? []).find((c: J) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True');
          const start = parseIso(st.startTime);
          const end = st.completionTime ? parseIso(st.completionTime) : now;
          const i = images(j);
          return {
            obj: j,
            cells: [j.metadata.name, done ? done.type : 'Running', `${st.succeeded ?? 0}/${j.spec.completions ?? 1}`, start ? humanDuration(end - start) : '', age(j, now), ...(wide ? [i.names, i.images, selectorText(j.spec.selector)] : [])],
          };
        }),
      };
    case 'Service':
      return {
        head: ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE', ...(wide ? ['SELECTOR'] : [])],
        rows: objs.map((s) => ({
          obj: s,
          cells: [s.metadata.name, serviceType(s), s.spec.clusterIP ?? '<none>', serviceType(s) === 'LoadBalancer' ? '<pending>' : '<none>', servicePorts(s), age(s, now), ...(wide ? [selectorText(s.spec.selector)] : [])],
        })),
      };
    case 'Endpoints':
      return { head: ['NAME', 'ENDPOINTS', 'AGE'], rows: objs.map((e) => ({ obj: e, cells: [e.metadata.name, e.metadata.name === 'kubernetes' ? '172.18.0.2:6443' : endpointsText(e), age(e, now)] })) };
    case 'ConfigMap':
      return { head: ['NAME', 'DATA', 'AGE'], rows: objs.map((c) => ({ obj: c, cells: [c.metadata.name, String(Object.keys(c.data ?? {}).length), age(c, now)] })) };
    case 'Secret':
      return { head: ['NAME', 'TYPE', 'DATA', 'AGE'], rows: objs.map((s) => ({ obj: s, cells: [s.metadata.name, s.type ?? 'Opaque', String(Object.keys(s.data ?? {}).length), age(s, now)] })) };
    case 'Namespace':
      return { head: ['NAME', 'STATUS', 'AGE'], rows: objs.map((n) => ({ obj: n, cells: [n.metadata.name, isTerminating(n) ? 'Terminating' : 'Active', age(n, now)] })) };
    case 'Node':
      return {
        head: ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', ...(wide ? ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'] : [])],
        rows: objs.map((n) => {
          const roles = Object.keys(n.metadata.labels ?? {}).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]);
          const info = n.status.nodeInfo;
          return {
            obj: n,
            cells: [
              n.metadata.name,
              n.spec.unschedulable ? 'Ready,SchedulingDisabled' : 'Ready',
              roles.length ? roles.join(',') : '<none>',
              age(n, now),
              info.kubeletVersion,
              ...(wide ? [n.status.addresses[0].address, '<none>', info.osImage, info.kernelVersion, info.containerRuntimeVersion] : []),
            ],
          };
        }),
      };
  }
  return columns2(kind, objs, now, wide);
}

export function eventsTable(events: KEvent[], now: number, allNs: boolean): string {
  const rows = events.map((e) => [...(allNs ? [e.namespace] : []), humanDuration(now - e.last), e.type, e.reason, `${e.involved.kind.toLowerCase()}/${e.involved.name}`, e.message]);
  return table([[...(allNs ? ['NAMESPACE'] : []), 'LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], ...rows]);
}

// ------------------------------------------------------------------ -o yaml / json

/** YAML the way kubectl prints it: no anchors, unindented sequences, quoted timestamps. */
export function kyaml(v: unknown): string {
  return stringify(v, { lineWidth: 0, indentSeq: false, aliasDuplicateObjects: false }).replace(/^(\s*(?:- )?[\w.\/-]+: )(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)$/gm, '$1"$2"');
}

/** Strip simulator-internal fields (they start with "_"). */
export function clean(o: J): J {
  if (Array.isArray(o)) return o.map(clean);
  if (o && typeof o === 'object') {
    const out: J = {};
    for (const k of Object.keys(o).sort()) {
      if (k.startsWith('_') || o[k] === undefined) continue;
      out[k] = clean(o[k]);
    }
    return out;
  }
  return o;
}

export function toYaml(objs: KObj[], asList: boolean): string {
  const body = asList ? { apiVersion: 'v1', items: objs.map(clean), kind: 'List', metadata: { resourceVersion: '' } } : clean(objs[0]);
  return kyaml(body);
}

export function toJson(objs: KObj[], asList: boolean): string {
  const body = asList ? { apiVersion: 'v1', items: objs.map(clean), kind: 'List', metadata: { resourceVersion: '' } } : clean(objs[0]);
  return JSON.stringify(body, null, 4) + '\n';
}

/** A small JSONPath: {.a.b[0].c}, [*] fan-out, {"\n"}, {range .items[*]}...{end}. */
export function jsonPath(template: string, data: J): string {
  const evalPath = (expr: string, ctx: J): J[] => {
    let cur: J[] = [ctx];
    const re = /\.?([A-Za-z0-9_\-/]+|\[(\*|\d+)\]|\[\?\(@\.([\w.]+)==["']?([^"')]*)["']?\)\])/g;
    const e = expr.trim().replace(/^\$/, '');
    let m;
    while ((m = re.exec(e))) {
      const next: J[] = [];
      for (const c of cur) {
        if (c === undefined || c === null) continue;
        if (m[2] === '*') next.push(...(Array.isArray(c) ? c : Object.values(c)));
        else if (m[2] !== undefined) next.push(c[Number(m[2])]);
        else if (m[3] !== undefined) {
          for (const item of Array.isArray(c) ? c : []) {
            const v = m[3].split('.').reduce((a: J, k) => a?.[k], item);
            if (String(v) === m[4]) next.push(item);
          }
        } else next.push(c[m[1]]);
      }
      cur = next;
    }
    return cur.filter((v) => v !== undefined);
  };
  const fmt = (v: J) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  let out = '';
  const tokens = template.split(/(\{[^}]*\})/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('{')) {
      out += t;
      continue;
    }
    const inner = t.slice(1, -1).trim();
    if (inner.startsWith('"') || inner.startsWith("'")) {
      out += inner.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      continue;
    }
    if (inner.startsWith('range ')) {
      const items = evalPath(inner.slice(6), data);
      const body: string[] = [];
      let depth = 1;
      let j = i + 1;
      for (; j < tokens.length; j++) {
        if (tokens[j].startsWith('{range ')) depth++;
        if (tokens[j] === '{end}' && --depth === 0) break;
        body.push(tokens[j]);
      }
      for (const it of items) out += jsonPath(body.join(''), it);
      i = j;
      continue;
    }
    out += evalPath(inner, data).map(fmt).join(' ');
  }
  return out;
}

export function customColumns(spec: string, objs: KObj[]): string {
  const cols = spec.split(',').map((c) => {
    const [h, ...p] = c.split(':');
    return { head: h, path: p.join(':') };
  });
  const rows = objs.map((o) => cols.map((c) => jsonPath(`{${c.path.startsWith('.') ? c.path : '.' + c.path}}`, clean(o)) || '<none>'));
  return table([cols.map((c) => c.head), ...rows]);
}

// ------------------------------------------------------------------ describe

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Tue, 03 Nov 2026 09:00:01 +0000" */
export function rfc1123(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export function kv(pairs: [string, string][], indent = '', min = 0): string {
  const w = Math.max(min, ...pairs.map(([k]) => k.length + 1));
  return pairs.map(([k, v]) => `${indent}${(k + ':').padEnd(w + 1)}${v}\n`).join('');
}

export function multiline(label: string, map: Record<string, string> | undefined, width: number, indent = ''): string {
  const entries = Object.entries(map ?? {}).filter(([k]) => k !== 'kubectl.kubernetes.io/last-applied-configuration');
  if (!entries.length) return `${indent}${(label + ':').padEnd(width)}<none>\n`;
  return entries.map(([k, v], i) => `${indent}${(i === 0 ? label + ':' : '').padEnd(width)}${k}${label === 'Annotations' ? ': ' : '='}${v}\n`).join('');
}

export function eventsSection(ks: KubeState, o: KObj, now: number): string {
  const evs = eventsFor(ks, o);
  if (!evs.length) return 'Events:                   <none>\n'.replace(/ {19}/, ' '.repeat(o.kind === 'Pod' ? 19 : 19));
  const rows = evs.map((e) => [
    `  ${e.type}`,
    e.reason,
    e.count > 1 ? `${humanDuration(now - e.last)} (x${e.count} over ${humanDuration(now - e.first)})` : humanDuration(now - e.last),
    e.source,
    e.message,
  ]);
  return 'Events:\n' + table([['  Type', 'Reason', 'Age', 'From', 'Message'], ['  ----', '------', '----', '----', '-------'], ...rows]);
}

function probeText(p: J): string {
  const h = p.httpGet ? `http-get ${(p.httpGet.scheme ?? 'HTTP').toLowerCase()}://:${p.httpGet.port}${p.httpGet.path ?? '/'}` : p.tcpSocket ? `tcp-socket :${p.tcpSocket.port}` : p.exec ? `exec [${(p.exec.command ?? []).join(' ')}]` : 'unknown';
  return `${h} delay=${p.initialDelaySeconds ?? 0}s timeout=${p.timeoutSeconds ?? 1}s period=${p.periodSeconds ?? 10}s #success=${p.successThreshold ?? 1} #failure=${p.failureThreshold ?? 3}`;
}

function envLines(c: J, indent: string): string {
  let out = '';
  if ((c.envFrom ?? []).length) {
    out += `${indent}Environment Variables from:\n`;
    for (const f of c.envFrom) {
      if (f.configMapRef) out += `${indent}  ${f.configMapRef.name}  ConfigMap  Optional: ${!!f.configMapRef.optional}\n`;
      if (f.secretRef) out += `${indent}  ${f.secretRef.name}  Secret  Optional: ${!!f.secretRef.optional}\n`;
    }
  }
  const env = c.env ?? [];
  if (!env.length) return out + `${indent}Environment:  <none>\n`;
  out += `${indent}Environment:\n`;
  for (const e of env) {
    let v = e.value;
    if (e.valueFrom?.configMapKeyRef) v = `<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>  Optional: ${!!e.valueFrom.configMapKeyRef.optional}`;
    else if (e.valueFrom?.secretKeyRef) v = `<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>  Optional: ${!!e.valueFrom.secretKeyRef.optional}`;
    else if (e.valueFrom?.fieldRef) v = ` (${e.valueFrom.fieldRef.apiVersion ?? 'v1'}:${e.valueFrom.fieldRef.fieldPath})`;
    out += `${indent}  ${e.name}:  ${v ?? ''}\n`;
  }
  return out;
}

function resourcesLines(c: J, indent: string): string {
  let out = '';
  for (const [label, key] of [['Limits', 'limits'], ['Requests', 'requests']] as const) {
    const r = c.resources?.[key];
    if (!r || !Object.keys(r).length) continue;
    out += `${indent}${label}:\n` + kv(Object.entries(r).map(([k, v]) => [k, String(v)]), indent + '  ');
  }
  return out;
}

function containerBlock(c: J, status: J | undefined, indent: string, template: boolean): string {
  const port = (c.ports ?? []).map((p: J) => `${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ') || '<none>';
  let out = `${indent}${c.name}:\n`;
  const i2 = indent + '  ';
  const pairs: [string, string][] = [];
  if (!template && status?.containerID) pairs.push(['Container ID', status.containerID]);
  pairs.push(['Image', c.image]);
  if (!template) pairs.push(['Image ID', status?.imageID ?? '']);
  pairs.push(['Port', port], ['Host Port', (c.ports ?? []).length ? (c.ports as J[]).map((p) => `0/${p.protocol ?? 'TCP'}`).join(', ') : '<none>']);
  if (c.command) pairs.push(['Command', '\n' + c.command.map((x: string) => `${i2}  ${x}`).join('\n')]);
  if (c.args) pairs.push(['Args', '\n' + c.args.map((x: string) => `${i2}  ${x}`).join('\n')]);
  out += kv(pairs, i2, 15);
  if (!template) {
    const st = status?.state ?? { waiting: { reason: 'ContainerCreating' } };
    const stateLines = (s: J, label: string) => {
      if (s.running) return kv([[label, 'Running'], ['  Started', rfc1123(parseIso(s.running.startedAt))]], i2, 15);
      if (s.terminated)
        return kv(
          [
            [label, 'Terminated'],
            ['  Reason', s.terminated.reason ?? 'Error'],
            ['  Exit Code', String(s.terminated.exitCode)],
            ['  Started', rfc1123(parseIso(s.terminated.startedAt))],
            ['  Finished', rfc1123(parseIso(s.terminated.finishedAt))],
          ],
          i2,
          15,
        );
      if (s.waiting) return kv([[label, 'Waiting'], ['  Reason', s.waiting.reason]], i2, 15);
      return kv([[label, '<none>']], i2, 15);
    };
    out += stateLines(st, 'State');
    if (status?.lastState?.terminated) out += stateLines(status.lastState, 'Last State');
    out += kv([['Ready', status?.ready ? 'True' : 'False'], ['Restart Count', String(status?.restartCount ?? 0)]], i2, 15);
  }
  out += resourcesLines(c, i2);
  for (const [label, k] of [['Liveness', 'livenessProbe'], ['Readiness', 'readinessProbe'], ['Startup', 'startupProbe']] as const) if (c[k]) out += kv([[label, probeText(c[k])]], i2, 15);
  out += envLines(c, i2);
  const mounts = c.volumeMounts ?? [];
  out += mounts.length || !template ? `${i2}Mounts:\n` + mounts.map((m: J) => `${i2}  ${m.mountPath} from ${m.name} (${m.readOnly ? 'ro' : 'rw'})\n`).join('') + (template ? '' : `${i2}  /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access (ro)\n`) : `${i2}Mounts:       <none>\n`;
  return out;
}

function volumesBlock(spec: J, indent: string): string {
  const vols = spec.volumes ?? [];
  if (!vols.length) return `${indent}Volumes:         <none>\n`;
  let out = `${indent}Volumes:\n`;
  for (const v of vols) {
    out += `${indent}  ${v.name}:\n`;
    if (v.configMap) out += kv([['Type', 'ConfigMap (a volume populated by a ConfigMap)'], ['Name', v.configMap.name], ['Optional', String(!!v.configMap.optional)]], indent + '    ');
    else if (v.secret) out += kv([['Type', 'Secret (a volume populated by a Secret)'], ['SecretName', v.secret.secretName], ['Optional', String(!!v.secret.optional)]], indent + '    ');
    else if (v.emptyDir) out += kv([['Type', 'EmptyDir (a temporary directory that shares a pod\'s lifetime)'], ['Medium', v.emptyDir.medium ?? ''], ['SizeLimit', '<unset>']], indent + '    ');
    else out += kv([['Type', Object.keys(v).filter((k) => k !== 'name')[0] ?? 'unknown']], indent + '    ');
  }
  return out;
}

function tolerationsText(ts: J[] | undefined, indent: number): string {
  if (!ts?.length) return '<none>\n';
  return ts
    .map((t, i) => `${i ? ' '.repeat(indent) : ''}${t.key ?? ''}${t.value ? '=' + t.value : ''}${t.effect ? ':' + t.effect : ''}${t.operator === 'Exists' && !t.key ? ' op=Exists' : t.operator === 'Exists' ? ' op=Exists' : ''}${t.tolerationSeconds ? ` for ${t.tolerationSeconds}s` : ''}\n`)
    .join('');
}

export function describe(ks: KubeState, o: KObj, now: number): string {
  const W = 18;
  const m = o.metadata;
  const head = (pairs: [string, string][], w = W) => kv(pairs, '', w - 1);
  switch (o.kind) {
    case 'Pod': {
      const ctrl = m.ownerReferences?.find((r) => r.controller);
      const W2 = 18;
      let out = head([
        ['Name', m.name],
        ['Namespace', m.namespace!],
        ['Priority', String(o.spec.priority ?? 0)],
        ...(o.spec.priorityClassName ? [['Priority Class Name', o.spec.priorityClassName] as [string, string]] : []),
        ['Service Account', o.spec.serviceAccountName ?? 'default'],
        ['Node', o.spec.nodeName ? `${o.spec.nodeName}/${o.status?.hostIP ?? ''}` : '<none>'],
        ...(o.status?.startTime ? [['Start Time', rfc1123(parseIso(o.status.startTime))] as [string, string]] : []),
      ], W2);
      out += multiline('Labels', m.labels, W2);
      out += multiline('Annotations', m.annotations, W2);
      out += head([['Status', isTerminating(o) ? `Terminating (lasts ${humanDuration(now - parseIso(m.deletionTimestamp))})` : o.status?.phase ?? 'Pending'], ['IP', o.status?.podIP ?? '']], W2);
      out += o.status?.podIP ? `IPs:\n  IP:  ${o.status.podIP}\n` : 'IPs:              <none>\n';
      if (ctrl) out += `Controlled By:  ${ctrl.kind}/${ctrl.name}\n`;
      out += 'Containers:\n';
      for (const c of o.spec.containers) out += containerBlock(c, (o.status?.containerStatuses ?? []).find((s: J) => s.name === c.name), '  ', false);
      const conds: J[] = o.status?.conditions ?? [];
      if (conds.length) out += 'Conditions:\n' + table([['  Type', 'Status'], ...conds.map((c) => [`  ${c.type}`, c.status])]);
      out += volumesBlock(o.spec, '');
      out += `QoS Class:                   ${o.status?.qosClass ?? 'BestEffort'}\n`;
      out += `Node-Selectors:              ${o.spec.nodeSelector ? labelsText(o.spec.nodeSelector) : '<none>'}\n`;
      out += `Tolerations:                 ${tolerationsText(o.spec.tolerations, 29)}`;
      return out + eventsSection(ks, o, now);
    }
    case 'Deployment': {
      const W3 = 24;
      const s = o.status ?? {};
      const desired = o.spec.replicas ?? 1;
      let out = head([['Name', m.name], ['Namespace', m.namespace!], ['CreationTimestamp', rfc1123(parseIso(m.creationTimestamp))]], W3);
      out += multiline('Labels', m.labels, W3);
      out += multiline('Annotations', m.annotations, W3);
      out += head([
        ['Selector', selectorText(o.spec.selector)],
        ['Replicas', `${desired} desired | ${s.updatedReplicas ?? 0} updated | ${s.replicas ?? 0} total | ${s.availableReplicas ?? 0} available | ${Math.max(0, (s.replicas ?? 0) - (s.availableReplicas ?? 0)) || s.unavailableReplicas || 0} unavailable`],
        ['StrategyType', o.spec.strategy?.type ?? 'RollingUpdate'],
        ['MinReadySeconds', String(o.spec.minReadySeconds ?? 0)],
        ...(o.spec.strategy?.type === 'Recreate' ? [] : [['RollingUpdateStrategy', `${o.spec.strategy?.rollingUpdate?.maxUnavailable ?? '25%'} max unavailable, ${o.spec.strategy?.rollingUpdate?.maxSurge ?? '25%'} max surge`] as [string, string]]),
      ], W3);
      out += podTemplate(o.spec.template);
      const conds: J[] = s.conditions ?? [];
      if (conds.length) out += 'Conditions:\n' + table([['  Type', 'Status', 'Reason'], ['  ----', '------', '------'], ...conds.map((c) => [`  ${c.type}`, c.status, c.reason])]);
      const rss = ownedBy(ks, 'ReplicaSet', o);
      const hash = templateHash(o.spec.template);
      const cur = rss.find((r) => r.metadata.labels?.['pod-template-hash'] === hash);
      const old = rss.filter((r) => r !== cur && (r.spec.replicas ?? 0) > 0);
      const rsText = (r: KObj) => `${r.metadata.name} (${r.status?.replicas ?? 0}/${r.spec.replicas ?? 0} replicas created)`;
      out += `OldReplicaSets:  ${old.length ? old.map(rsText).join(', ') : '<none>'}\n`;
      out += `NewReplicaSet:   ${cur ? rsText(cur) : '<none>'}\n`;
      return out + eventsSection(ks, o, now);
    }
    case 'ReplicaSet':
    case 'DaemonSet': {
      const ctrl = m.ownerReferences?.find((r) => r.controller);
      let out = head([['Name', m.name], ['Namespace', m.namespace!], ['Selector', selectorText(o.spec.selector)]], 15);
      out += multiline('Labels', m.labels, 15);
      out += multiline('Annotations', m.annotations, 15);
      if (ctrl) out += `Controlled By:  ${ctrl.kind}/${ctrl.name}\n`;
      if (o.kind === 'ReplicaSet') {
        out += `Replicas:       ${o.status?.replicas ?? 0} current / ${o.spec.replicas ?? 1} desired\n`;
        const pods = ownedBy(ks, 'Pod', o);
        const count = (ph: string) => pods.filter((p) => p.status?.phase === ph).length;
        out += `Pods Status:    ${count('Running')} Running / ${count('Pending')} Waiting / ${count('Succeeded')} Succeeded / ${count('Failed')} Failed\n`;
      } else {
        const s = o.status ?? {};
        out += `Desired Number of Nodes Scheduled: ${s.desiredNumberScheduled ?? 0}\nCurrent Number of Nodes Scheduled: ${s.currentNumberScheduled ?? 0}\nNumber of Nodes Scheduled with Up-to-date Pods: ${s.updatedNumberScheduled ?? 0}\nNumber of Nodes Scheduled with Available Pods: ${s.numberAvailable ?? 0}\nNumber of Nodes Misscheduled: 0\n`;
      }
      out += podTemplate(o.spec.template);
      return out + eventsSection(ks, o, now);
    }
    case 'Job': {
      const s = o.status ?? {};
      let out = head([['Name', m.name], ['Namespace', m.namespace!], ['Selector', selectorText(o.spec.selector)]], 18);
      out += multiline('Labels', m.labels, 18);
      out += multiline('Annotations', m.annotations, 18);
      out += head([
        ['Parallelism', String(o.spec.parallelism ?? 1)],
        ['Completions', String(o.spec.completions ?? 1)],
        ['Completion Mode', o.spec.completionMode ?? 'NonIndexed'],
        ['Suspend', String(!!o.spec.suspend)],
        ['Backoff Limit', String(o.spec.backoffLimit ?? 6)],
        ...(s.startTime ? [['Start Time', rfc1123(parseIso(s.startTime))] as [string, string]] : []),
        ...(s.completionTime ? [['Completed At', rfc1123(parseIso(s.completionTime))] as [string, string], ['Duration', humanDuration(parseIso(s.completionTime) - parseIso(s.startTime))] as [string, string]] : []),
        ['Pods Statuses', `${s.active ?? 0} Active (${s.ready ?? 0} Ready) / ${s.succeeded ?? 0} Succeeded / ${s.failed ?? 0} Failed`],
      ], 18);
      out += podTemplate(o.spec.template);
      return out + eventsSection(ks, o, now);
    }
    case 'Service': {
      const W4 = 26;
      const ep = getObj(ks, 'Endpoints', m.namespace, m.name);
      let out = head([['Name', m.name], ['Namespace', m.namespace!]], W4);
      out += multiline('Labels', m.labels, W4);
      out += multiline('Annotations', m.annotations, W4);
      out += head([
        ['Selector', o.spec.selector ? selectorText(o.spec.selector) : '<none>'],
        ['Type', serviceType(o)],
        ['IP Family Policy', o.spec.ipFamilyPolicy ?? 'SingleStack'],
        ['IP Families', (o.spec.ipFamilies ?? ['IPv4']).join(',')],
        ['IP', o.spec.clusterIP],
        ['IPs', (o.spec.clusterIPs ?? [o.spec.clusterIP]).join(',')],
      ], W4);
      if (serviceType(o) === 'LoadBalancer') out += `LoadBalancer Ingress:     <pending>\n`;
      for (const p of o.spec.ports ?? []) {
        out += head([
          ['Port', `${p.name ?? '<unset>'}  ${p.port}/${p.protocol}`],
          ['TargetPort', `${p.targetPort}/${p.protocol}`],
          ...(p.nodePort ? [['NodePort', `${p.name ?? '<unset>'}  ${p.nodePort}/${p.protocol}`] as [string, string]] : []),
          ['Endpoints', o.metadata.name === 'kubernetes' ? '172.18.0.2:6443' : endpointsText(ep) === '<none>' ? '' : endpointsText(ep)],
        ], W4);
      }
      out += head([['Session Affinity', o.spec.sessionAffinity ?? 'None'], ...(o.spec.externalTrafficPolicy ? [['External Traffic Policy', o.spec.externalTrafficPolicy] as [string, string]] : []), ['Internal Traffic Policy', o.spec.internalTrafficPolicy ?? 'Cluster']], W4);
      return out + eventsSection(ks, o, now);
    }
    case 'ConfigMap':
    case 'Secret': {
      let out = head([['Name', m.name], ['Namespace', m.namespace!]], 14);
      out += multiline('Labels', m.labels, 14);
      out += multiline('Annotations', m.annotations, 14);
      out += '\n';
      if (o.kind === 'Secret') {
        out += `Type:  ${o.type ?? 'Opaque'}\n\nData\n====\n`;
        for (const [k, v] of Object.entries(o.data ?? {})) out += `${k}:  ${atob(v).length} bytes\n`;
        return out;
      }
      out += 'Data\n====\n';
      for (const [k, v] of Object.entries(o.data ?? {})) out += `${k}:\n----\n${v}${v.endsWith('\n') ? '' : '\n'}\n`;
      out += '\nBinaryData\n====\n\n';
      return out + eventsSection(ks, o, now);
    }
    case 'Namespace': {
      let out = head([['Name', m.name]], 7);
      out += multiline('Labels', m.labels, 14);
      out += multiline('Annotations', m.annotations, 14);
      out += `Status:       ${isTerminating(o) ? 'Terminating' : 'Active'}\n\nNo resource quota.\n\nNo LimitRange resource.\n`;
      return out;
    }
    case 'Node':
      return describeNode(ks, o, now);
  }
  return describe2(ks, o, now);
}

export function podTemplate(t: J): string {
  let out = 'Pod Template:\n';
  out += multiline('Labels', t.metadata?.labels, 9, '  ');
  if (t.metadata?.annotations) out += multiline('Annotations', t.metadata.annotations, 9, '  ');
  out += '  Containers:\n';
  for (const c of t.spec.containers) out += containerBlock(c, undefined, '   ', true);
  out += volumesBlock(t.spec, '  ');
  out += `  Node-Selectors:  ${t.spec.nodeSelector ? labelsText(t.spec.nodeSelector) : '<none>'}\n`;
  out += `  Tolerations:     ${tolerationsText(t.spec.tolerations, 19)}`;
  return out;
}

function describeNode(ks: KubeState, n: KObj, now: number): string {
  const roles = Object.keys(n.metadata.labels ?? {}).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]);
  let out = kv([['Name', n.metadata.name], ['Roles', roles.join(',') || '<none>']], '', 18);
  out += multiline('Labels', n.metadata.labels, 20);
  out += multiline('Annotations', n.metadata.annotations, 20);
  out += kv([['CreationTimestamp', rfc1123(parseIso(n.metadata.creationTimestamp))]], '', 18);
  const taints = (n.spec.taints ?? []).map((t: J) => `${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`);
  out += `Taints:             ${taints.length ? taints.join('\n                    ') : '<none>'}\n`;
  out += `Unschedulable:      ${!!n.spec.unschedulable}\n`;
  out += 'Conditions:\n' + table([['  Type', 'Status', 'Reason', 'Message'], ['  ----', '------', '------', '-------'], ...n.status.conditions.map((c: J) => [`  ${c.type}`, c.status, c.reason, c.message])]);
  out += 'Addresses:\n' + n.status.addresses.map((a: J) => `  ${a.type}:  ${a.address}\n`).join('');
  out += 'Capacity:\n' + kv(Object.entries(n.status.capacity).map(([k, v]) => [k, String(v)]), '  ');
  out += 'Allocatable:\n' + kv(Object.entries(n.status.allocatable).map(([k, v]) => [k, String(v)]), '  ');
  const i = n.status.nodeInfo;
  out += `System Info:\n  Kernel Version:             ${i.kernelVersion}\n  OS Image:                   ${i.osImage}\n  Operating System:           linux\n  Architecture:               amd64\n  Container Runtime Version:  ${i.containerRuntimeVersion}\n  Kubelet Version:            ${i.kubeletVersion}\n  Kube-Proxy Version:         ${i.kubeProxyVersion}\n`;
  out += `PodCIDR:                      ${n.spec.podCIDR}\nPodCIDRs:                     ${n.spec.podCIDR}\nProviderID:                   ${n.spec.providerID}\n`;
  const pods = listObjs(ks, 'Pod').filter((p) => p.spec.nodeName === n.metadata.name && !['Succeeded', 'Failed'].includes(p.status?.phase));
  const allocCpu = cpuMilli(n.status.allocatable.cpu);
  const allocMem = memBytes(n.status.allocatable.memory);
  const pct = (a: number, b: number) => `${Math.floor((a / b) * 100)}%`;
  const fmtMem = (b: number) => (b === 0 ? '0' : b % 1024 ** 2 === 0 ? `${b / 1024 ** 2}Mi` : `${Math.round(b / 1024 ** 2)}Mi`);
  const limits = (p: KObj) =>
    p.spec.containers.reduce((a: { cpu: number; mem: number }, c: J) => ({ cpu: a.cpu + cpuMilli(c.resources?.limits?.cpu), mem: a.mem + memBytes(c.resources?.limits?.memory) }), { cpu: 0, mem: 0 });
  out += `Non-terminated Pods:          (${pods.length} in total)\n`;
  out += table([
    ['  Namespace', 'Name', 'CPU Requests', 'CPU Limits', 'Memory Requests', 'Memory Limits', 'Age'],
    ['  ---------', '----', '------------', '----------', '---------------', '-------------', '---'],
    ...pods.map((p) => {
      const r = podRequests(p);
      const l = limits(p);
      return [`  ${p.metadata.namespace}`, p.metadata.name, `${r.cpu}m (${pct(r.cpu, allocCpu)})`, `${l.cpu}m (${pct(l.cpu, allocCpu)})`, `${fmtMem(r.mem)} (${pct(r.mem, allocMem)})`, `${fmtMem(l.mem)} (${pct(l.mem, allocMem)})`, humanDuration(now - parseIso(p.metadata.creationTimestamp))];
    }),
  ]);
  const tot = pods.reduce((a, p) => ({ cpu: a.cpu + podRequests(p).cpu, mem: a.mem + podRequests(p).mem, lcpu: a.lcpu + limits(p).cpu, lmem: a.lmem + limits(p).mem }), { cpu: 0, mem: 0, lcpu: 0, lmem: 0 });
  out += 'Allocated resources:\n  (Total limits may be over 100 percent, i.e., overcommitted.)\n';
  out += table([
    ['  Resource', 'Requests', 'Limits'],
    ['  --------', '--------', '------'],
    ['  cpu', `${tot.cpu}m (${pct(tot.cpu, allocCpu)})`, `${tot.lcpu}m (${pct(tot.lcpu, allocCpu)})`],
    ['  memory', `${fmtMem(tot.mem)} (${pct(tot.mem, allocMem)})`, `${fmtMem(tot.lmem)} (${pct(tot.lmem, allocMem)})`],
  ]);
  return out + eventsSection(ks, n, now);
}

export { qualified, infoOf, age, labelsText, selectorText };
