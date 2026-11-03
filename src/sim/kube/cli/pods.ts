import { getObj, listObjs, removeObj } from '../cluster';
import { containerEnv, isPodReady } from '../controllers';
import { resolveImage } from '../images';
import { podState } from '../podshell';
import { kyaml, table } from '../printers';
import type { KObj } from '../types';
import { findOne, Flags, KCtx, KubectlError, namespaceOf, parseFlags, podFor, resolveResource, selectorMatches } from './common';
import { setAttach } from './workloads';

function pickContainer(k: KCtx, pod: KObj, f: Flags, verb: string): string {
  const names: string[] = pod.spec.containers.map((c: { name: string }) => c.name);
  const want = f.flags.container as string | undefined;
  if (want) {
    if (!names.includes(want)) throw new KubectlError(`${verb === 'logs' ? 'error: container' : 'Error from server (BadRequest): container'} ${want} is not valid for pod ${pod.metadata.name}`);
    return want;
  }
  if (names.length > 1) k.err(`Defaulted container "${names[0]}" out of: ${names.join(', ')}\n`);
  return names[0];
}

// ------------------------------------------------------------------ logs

export function kubectlLogs(k: KCtx, argv: string[]): number {
  const f = parseFlags('logs', argv, {
    bool: ['p', 'previous', 'f', 'follow', 'timestamps', 'all-containers', 'prefix'],
    value: ['c', 'container', 'tail', 'since', 'l', 'selector', 'max-log-requests'],
    alias: { p: 'previous', f: 'follow', c: 'container', l: 'selector' },
  });
  const ns = namespaceOf(k, f);
  let pods: KObj[];
  if (f.flags.selector) {
    pods = listObjs(k.ks, 'Pod', ns).filter((p) => selectorMatches(p.metadata.labels, f.flags.selector as string));
    if (!pods.length) {
      k.err(`No resources found in ${ns} namespace.\n`);
      return 0;
    }
  } else {
    const ref = f.args[0];
    if (!ref) throw new KubectlError("error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.\nPOD or TYPE/NAME is a required argument for the logs command\nSee 'kubectl logs -h' for help and examples");
    if (f.args[1] && !f.flags.container) f.flags.container = f.args[1];
    const pod = podFor(k, ref, ns);
    if (ref.includes('/') && !ref.startsWith('pod/') && !ref.startsWith('pods/') && !ref.startsWith('po/')) {
      const total = listObjs(k.ks, 'Pod', ns).filter((p) => p.metadata.ownerReferences?.length && pod.metadata.labels && Object.entries(pod.metadata.labels).every(([a, b]) => p.metadata.labels?.[a] === b)).length;
      if (total > 1) k.err(`Found ${total} pods, using pod/${pod.metadata.name}\n`);
    }
    pods = [pod];
  }
  let code = 0;
  for (const pod of pods) {
    const containers: string[] = f.flags['all-containers'] ? pod.spec.containers.map((c: { name: string }) => c.name) : [pickContainer(k, pod, f, 'logs')];
    for (const cname of containers) {
      const cs = k.ks.runtime[pod.metadata.uid]?.containers[cname];
      const status = (pod.status?.containerStatuses ?? []).find((s: { name: string }) => s.name === cname);
      const runs = cs?.runs ?? [];
      let run;
      if (f.flags.previous) {
        run = cs?.state === 'running' || cs?.state === 'waiting' ? runs[runs.length - (cs.state === 'running' ? 2 : 1)] : runs[runs.length - 2];
        if (cs?.state === 'waiting' && cs.reason === 'CrashLoopBackOff') run = runs[runs.length - 2] ?? runs[runs.length - 1];
        if (!run) {
          k.err(`Error from server (BadRequest): previous terminated container "${cname}" in pod "${pod.metadata.name}" not found\n`);
          code = 1;
          continue;
        }
      } else {
        run = runs[runs.length - 1];
        if (!run) {
          const reason = status?.state?.waiting?.reason ?? 'ContainerCreating';
          const why = reason === 'ImagePullBackOff' || reason === 'ErrImagePull' ? 'trying and failing to pull image' : reason === 'CreateContainerConfigError' ? 'CreateContainerConfigError' : reason;
          k.err(`Error from server (BadRequest): container "${cname}" in pod "${pod.metadata.name}" is waiting to start: ${why}\n`);
          code = 1;
          continue;
        }
      }
      let lines = run.logs;
      if (f.flags.tail !== undefined && Number(f.flags.tail) >= 0) lines = lines.slice(-Number(f.flags.tail) || lines.length + 1).slice(Number(f.flags.tail) === 0 ? lines.length : 0);
      const prefix = f.flags.prefix || pods.length > 1 ? `[pod/${pod.metadata.name}/${cname}] ` : '';
      k.out(lines.map((l) => `${prefix}${f.flags.timestamps ? new Date(l.time).toISOString().replace('Z', '000000Z') + ' ' : ''}${l.text}\n`).join(''));
    }
  }
  if (f.flags.follow) k.note('devquest: -f (follow) prints what is there now; run it again to see new lines\n');
  return code;
}

// ------------------------------------------------------------------ exec

function containerShell(k: KCtx, pod: KObj, cname: string) {
  const c = pod.spec.containers.find((x: { name: string }) => x.name === cname);
  const cs = k.ks.runtime[pod.metadata.uid]?.containers[cname];
  if (!cs || cs.state !== 'running') throw new KubectlError(`error: Internal error occurred: unable to upgrade connection: container not found ("${cname}")`);
  const img = resolveImage(k.ks, c.image);
  if (!img.ok) throw new KubectlError(`error: Internal error occurred: unable to upgrade connection: container not found ("${cname}")`);
  const env = containerEnv(k.ks, pod, c, img.image.spec);
  const fs = k.ks.runtime[pod.metadata.uid].fs!;
  return { state: podState(k.ctx.state, pod, cname, fs, 'env' in env ? env.env : {}, img.image), image: img.image };
}

function execNotFound(cmd: string): KubectlError {
  return new KubectlError(
    `error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${'0'.repeat(0)}${suffixId(cmd)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd}": executable file not found in $PATH: unknown`,
  );
}

const suffixId = (s: string) => Array.from(s).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0').repeat(8);

const SHELLS = ['sh', '/bin/sh', 'bash', '/bin/bash', 'ash', '/bin/ash'];

export function kubectlExec(k: KCtx, argv: string[]): number {
  const f = parseFlags('exec', argv, { bool: ['i', 'stdin', 't', 'tty', 'q', 'quiet'], value: ['c', 'container', 'f', 'filename'], alias: { i: 'stdin', t: 'tty', c: 'container', q: 'quiet' } });
  const ns = namespaceOf(k, f);
  if (!f.args.length) throw new KubectlError("error: you must specify at least one command for the container\nSee 'kubectl exec -h' for help and examples");
  if (f.rest === null) {
    if (f.args.length > 1) throw new KubectlError('error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead\nSee \'kubectl exec -h\' for help and examples');
    throw new KubectlError("error: you must specify at least one command for the container\nSee 'kubectl exec -h' for help and examples");
  }
  const pod = podFor(k, f.args[0], ns);
  const cname = pickContainer(k, pod, f, 'exec');
  const { state, image } = containerShell(k, pod, cname);
  const cmd = f.rest;
  if (!cmd.length) throw new KubectlError("error: you must specify at least one command for the container");
  const shells = image.catalog ? (['bash', '/bin/bash'].includes(cmd[0]) && !state.users[0].shell.endsWith('bash') ? [] : SHELLS) : SHELLS;
  if (SHELLS.includes(cmd[0]) && cmd.length === 1) {
    if (!shells.includes(cmd[0])) throw execNotFound(cmd[0]);
    if (!f.flags.stdin || !f.flags.tty) {
      // A shell with no terminal reads an empty stdin and exits at once.
      return 0;
    }
    k.ctx.shell.attach(state, () => {});
    return 0;
  }
  if (['bash', '/bin/bash'].includes(cmd[0]) && !state.users[0].shell.endsWith('bash')) throw execNotFound(cmd[0]);
  const line = SHELLS.includes(cmd[0]) && cmd[1] === '-c' ? cmd.slice(2).join(' ') : cmd.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  const r = k.ctx.shell.spawn(state).run(line, k.ctx.stdin);
  for (const chunk of r.output) {
    if (chunk.stream === 'stdout') k.out(chunk.text);
    else k.err(chunk.text);
  }
  if (r.exitCode === 127 && r.output.some((c) => /command not found|not found/.test(c.text))) {
    return 127;
  }
  if (r.exitCode !== 0) k.err(`command terminated with exit code ${r.exitCode}\n`);
  return r.exitCode;
}

/** `kubectl run -it ... -- sh`: attach a shell in the new pod; --rm deletes it on exit. */
setAttach((k, pod, container, _shell, rm, ns) => {
  const { state } = containerShell(k, pod, container);
  const ks = k.ks;
  k.ctx.shell.attach(state, () => {
    if (rm) {
      const p = getObj(ks, 'Pod', ns, pod.metadata.name);
      if (p) removeObj(ks, p);
    }
  });
  return 0;
});

// ------------------------------------------------------------------ port-forward

export function kubectlPortForward(k: KCtx, argv: string[]): number {
  const f = parseFlags('port-forward', argv, { value: ['address'], bool: ['stop'] });
  const ns = namespaceOf(k, f);
  const [ref, ...specs] = f.args;
  if (!ref || !specs.length) throw new KubectlError("error: TYPE/NAME and list of ports are required for port-forward\nSee 'kubectl port-forward -h' for help and examples");
  const pod = podFor(k, ref, ns);
  if (pod.status?.phase !== 'Running') throw new KubectlError(`error: unable to forward port because pod is not running. Current status=${pod.status?.phase ?? 'Pending'}`);
  let svc: KObj | undefined;
  if (/^(svc|service|services)\//.test(ref)) svc = findOne(k, resolveResource('svc'), ns, ref.split('/')[1]);
  for (const spec of specs) {
    const [l, r] = spec.includes(':') ? spec.split(':') : [spec, spec];
    const local = Number(l || r);
    let remote = Number(r);
    if (svc) {
      const sp = (svc.spec.ports ?? []).find((p: { port: number }) => p.port === remote);
      if (!sp) throw new KubectlError(`error: Service ${svc.metadata.name} does not have a service port ${remote}`);
      remote = typeof sp.targetPort === 'number' ? sp.targetPort : remote;
    }
    if (k.ctx.state.processes.some((p) => p.ports?.includes(local)) || (k.ctx.state.docker?.containers ?? []).some((c) => c.status === 'running' && c.ports.some((b) => b.hostPort === local))) {
      throw new KubectlError(`Unable to listen on port ${local}: Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:${local}: bind: address already in use unable to create listener: Error listen tcp6 [::1]:${local}: bind: address already in use]\nerror: unable to listen on any of the requested ports: [{${local} ${remote}}]`);
    }
    k.ks.forwards = k.ks.forwards.filter((x) => x.localPort !== local);
    k.ks.forwards.push({ localPort: local, namespace: ns, target: pod.metadata.name, remotePort: remote });
    k.out(`Forwarding from 127.0.0.1:${local} -> ${remote}\nForwarding from [::1]:${local} -> ${remote}\n`);
  }
  k.note('devquest: the forward keeps running in the background so you can use this terminal (a real one blocks until Ctrl+C). It stops when the pod goes away.\n');
  return 0;
}

// ------------------------------------------------------------------ top

export function kubectlTop(k: KCtx, argv: string[]): number {
  const [what, ...rest] = argv;
  const f = parseFlags(`top ${what}`, rest, { value: ['l', 'selector', 'sort-by'], bool: ['containers', 'no-headers'], alias: { l: 'selector' } });
  const usage = (p: KObj) => {
    let cpu = 0;
    let mem = 0;
    for (const c of p.spec.containers) {
      const cs = k.ks.runtime[p.metadata.uid]?.containers[c.name];
      if (cs?.state !== 'running') continue;
      const img = resolveImage(k.ks, c.image);
      if (!img.ok) continue;
      cpu += img.image.spec.cpuM ?? 1;
      mem += img.image.spec.memMi ?? 5;
    }
    return { cpu, mem };
  };
  if (what === 'pod' || what === 'pods' || what === 'po') {
    const ns = namespaceOf(k, f);
    let pods = listObjs(k.ks, 'Pod', f.flags['all-namespaces'] ? undefined : ns).filter((p) => p.status?.phase === 'Running');
    if (f.flags.selector) pods = pods.filter((p) => selectorMatches(p.metadata.labels, f.flags.selector as string));
    if (f.args[0]) pods = pods.filter((p) => p.metadata.name === f.args[0]);
    if (!pods.length) {
      k.err(f.args[0] ? `Error from server (NotFound): pods "${f.args[0]}" not found\n` : `No resources found in ${ns} namespace.\n`);
      return f.args[0] ? 1 : 0;
    }
    const rows = pods.map((p) => ({ p, u: usage(p) }));
    if (f.flags['sort-by'] === 'memory') rows.sort((a, b) => b.u.mem - a.u.mem);
    if (f.flags['sort-by'] === 'cpu') rows.sort((a, b) => b.u.cpu - a.u.cpu);
    k.out(table([[...(f.flags['all-namespaces'] ? ['NAMESPACE'] : []), 'NAME', 'CPU(cores)', 'MEMORY(bytes)'], ...rows.map(({ p, u }) => [...(f.flags['all-namespaces'] ? [p.metadata.namespace!] : []), p.metadata.name, `${u.cpu}m`, `${u.mem}Mi`])]));
    return 0;
  }
  if (what === 'node' || what === 'nodes' || what === 'no') {
    const rows = listObjs(k.ks, 'Node').map((n) => {
      const pods = listObjs(k.ks, 'Pod').filter((p) => p.spec.nodeName === n.metadata.name && p.status?.phase === 'Running');
      const u = pods.reduce((a, p) => ({ cpu: a.cpu + usage(p).cpu, mem: a.mem + usage(p).mem }), { cpu: 60, mem: 420 });
      return [n.metadata.name, `${u.cpu}m`, `${Math.round((u.cpu / 2000) * 100)}%`, `${u.mem}Mi`, `${Math.round((u.mem / 3921) * 100)}%`];
    });
    k.out(table([['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)'], ...rows]));
    return 0;
  }
  throw new KubectlError('error: unknown command "' + (what ?? '') + '" for "kubectl top"\nAvailable Commands: node, pod');
}

// ------------------------------------------------------------------ config & cluster info

export function kubectlConfig(k: KCtx, argv: string[]): number {
  const [sub, ...rest] = argv;
  const f = parseFlags(`config ${sub}`, rest, { bool: ['current', 'minify', 'raw', 'flatten'], value: ['o', 'output'], alias: { o: 'output' } });
  const ctxName = k.ks.currentContext;
  switch (sub) {
    case 'current-context':
      k.out(ctxName + '\n');
      return 0;
    case 'get-contexts':
      k.out(table([['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ['*', ctxName, ctxName, ctxName, k.ks.namespace === 'default' ? '' : k.ks.namespace]]));
      return 0;
    case 'use-context':
      if (f.args[0] !== ctxName) throw new KubectlError(`error: no context exists with the name: "${f.args[0] ?? ''}"`);
      k.out(`Switched to context "${ctxName}".\n`);
      return 0;
    case 'set-context': {
      if (!f.flags.current && f.args[0] !== ctxName) throw new KubectlError(`devquest: only the current context (${ctxName}) exists; use --current`);
      const ns = f.flags.namespace as string | undefined;
      if (ns) k.ks.namespace = ns;
      k.out(`Context "${ctxName}" modified.\n`);
      return 0;
    }
    case 'view': {
      const cfg = {
        apiVersion: 'v1',
        clusters: [{ cluster: { 'certificate-authority-data': 'DATA+OMITTED', server: 'https://127.0.0.1:41231' }, name: ctxName }],
        contexts: [{ context: { cluster: ctxName, ...(k.ks.namespace !== 'default' ? { namespace: k.ks.namespace } : {}), user: ctxName }, name: ctxName }],
        'current-context': ctxName,
        kind: 'Config',
        preferences: {},
        users: [{ name: ctxName, user: { 'client-certificate-data': 'DATA+OMITTED', 'client-key-data': 'DATA+OMITTED' } }],
      };
      k.out(kyaml(cfg));
      return 0;
    }
  }
  throw new KubectlError(`devquest: kubectl config ${sub ?? ''} is not simulated (try current-context, get-contexts, use-context, set-context --current --namespace=NS, view)`);
}

export function kubectlVersion(k: KCtx, argv: string[]): number {
  const f = parseFlags('version', argv, { bool: ['client', 'short'], value: ['o', 'output'], alias: { o: 'output' } });
  k.out(`Client Version: v1.31.2\nKustomize Version: v5.4.2\n${f.flags.client ? '' : 'Server Version: v1.31.2\n'}`);
  return 0;
}

export function kubectlClusterInfo(k: KCtx): number {
  k.out(
    'Kubernetes control plane is running at https://127.0.0.1:41231\nCoreDNS is running at https://127.0.0.1:41231/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use \'kubectl cluster-info dump\'.\n',
  );
  return 0;
}

export function kubectlApiResources(k: KCtx): number {
  const rows = [
    ['configmaps', 'cm', 'v1', 'true', 'ConfigMap'],
    ['endpoints', 'ep', 'v1', 'true', 'Endpoints'],
    ['events', 'ev', 'v1', 'true', 'Event'],
    ['namespaces', 'ns', 'v1', 'false', 'Namespace'],
    ['nodes', 'no', 'v1', 'false', 'Node'],
    ['pods', 'po', 'v1', 'true', 'Pod'],
    ['secrets', '', 'v1', 'true', 'Secret'],
    ['services', 'svc', 'v1', 'true', 'Service'],
    ['daemonsets', 'ds', 'apps/v1', 'true', 'DaemonSet'],
    ['deployments', 'deploy', 'apps/v1', 'true', 'Deployment'],
    ['replicasets', 'rs', 'apps/v1', 'true', 'ReplicaSet'],
    ['jobs', '', 'batch/v1', 'true', 'Job'],
  ];
  k.out(table([['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], ...rows]));
  k.note('devquest: these are the resources simulated so far\n');
  return 0;
}

export { isPodReady };
