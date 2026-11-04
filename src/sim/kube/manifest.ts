/** Admission: validate manifests (strict fields, required values, types) and apply API-server defaults. */
import { allocateClusterIP, allocateNodePort, qosClass, templateHash } from './controllers';
import { getObj, infoOf, iso, listObjs, newMeta, nextSeq, uid } from './cluster';
import { parseCron } from './cron';
import { validQuantity, memBytes, cpuMilli } from './quantity';
import type { J, KObj, KubeState } from './types';

export class AdmissionError extends Error {}

/** Supported kinds and their API versions. */
export const KINDS: Record<string, string> = {
  Pod: 'v1',
  Service: 'v1',
  ConfigMap: 'v1',
  Secret: 'v1',
  Namespace: 'v1',
  Deployment: 'apps/v1',
  ReplicaSet: 'apps/v1',
  DaemonSet: 'apps/v1',
  Job: 'batch/v1',
  StatefulSet: 'apps/v1',
  CronJob: 'batch/v1',
  PersistentVolumeClaim: 'v1',
  PersistentVolume: 'v1',
  StorageClass: 'storage.k8s.io/v1',
  Ingress: 'networking.k8s.io/v1',
  IngressClass: 'networking.k8s.io/v1',
  NetworkPolicy: 'networking.k8s.io/v1',
  HorizontalPodAutoscaler: 'autoscaling/v2',
  ServiceAccount: 'v1',
  Role: 'rbac.authorization.k8s.io/v1',
  RoleBinding: 'rbac.authorization.k8s.io/v1',
  ClusterRole: 'rbac.authorization.k8s.io/v1',
  ClusterRoleBinding: 'rbac.authorization.k8s.io/v1',
};

/** Real kinds DevOps Quest doesn't simulate. */
const LATER: Record<string, string> = {
  ResourceQuota: 'v1',
  LimitRange: 'v1',
  PodDisruptionBudget: 'policy/v1',
  VerticalPodAutoscaler: 'autoscaling.k8s.io/v1',
  CustomResourceDefinition: 'apiextensions.k8s.io/v1',
};

// ------------------------------------------------------------------ strict field schema

type Schema = { [key: string]: Schema | true | [Schema] };
const ANY = true as const;
const META: Schema = Object.fromEntries(
  ['name', 'namespace', 'labels', 'annotations', 'generateName', 'uid', 'resourceVersion', 'creationTimestamp', 'generation', 'managedFields', 'ownerReferences', 'finalizers', 'selfLink', 'deletionTimestamp', 'deletionGracePeriodSeconds'].map((k) => [k, ANY]),
);
const REF: Schema = { name: ANY, key: ANY, optional: ANY };
const PROBE: Schema = {
  httpGet: { path: ANY, port: ANY, host: ANY, scheme: ANY, httpHeaders: ANY },
  tcpSocket: { port: ANY, host: ANY },
  exec: { command: ANY },
  grpc: ANY,
  initialDelaySeconds: ANY,
  periodSeconds: ANY,
  timeoutSeconds: ANY,
  successThreshold: ANY,
  failureThreshold: ANY,
  terminationGracePeriodSeconds: ANY,
};
const CONTAINER: Schema = {
  name: ANY,
  image: ANY,
  command: ANY,
  args: ANY,
  workingDir: ANY,
  ports: [{ name: ANY, containerPort: ANY, protocol: ANY, hostPort: ANY, hostIP: ANY }],
  env: [{ name: ANY, value: ANY, valueFrom: { configMapKeyRef: REF, secretKeyRef: REF, fieldRef: { fieldPath: ANY, apiVersion: ANY }, resourceFieldRef: ANY } }],
  envFrom: [{ configMapRef: { name: ANY, optional: ANY }, secretRef: { name: ANY, optional: ANY }, prefix: ANY }],
  resources: { requests: ANY, limits: ANY, claims: ANY },
  volumeMounts: [{ name: ANY, mountPath: ANY, readOnly: ANY, subPath: ANY, subPathExpr: ANY, mountPropagation: ANY, recursiveReadOnly: ANY }],
  livenessProbe: PROBE,
  readinessProbe: PROBE,
  startupProbe: PROBE,
  lifecycle: ANY,
  terminationMessagePath: ANY,
  terminationMessagePolicy: ANY,
  imagePullPolicy: ANY,
  securityContext: ANY,
  stdin: ANY,
  stdinOnce: ANY,
  tty: ANY,
  volumeDevices: ANY,
  resizePolicy: ANY,
  restartPolicy: ANY,
};
const POD_SPEC: Schema = {
  containers: [CONTAINER],
  initContainers: [CONTAINER],
  volumes: [{ name: ANY, configMap: { name: ANY, items: ANY, defaultMode: ANY, optional: ANY }, secret: { secretName: ANY, items: ANY, defaultMode: ANY, optional: ANY }, emptyDir: ANY, persistentVolumeClaim: ANY, hostPath: ANY, projected: ANY, downwardAPI: ANY, nfs: ANY, csi: ANY, ephemeral: ANY }],
  ...Object.fromEntries(
    ['restartPolicy', 'terminationGracePeriodSeconds', 'activeDeadlineSeconds', 'dnsPolicy', 'nodeSelector', 'serviceAccountName', 'serviceAccount', 'automountServiceAccountToken', 'nodeName', 'hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace', 'securityContext', 'imagePullSecrets', 'hostname', 'subdomain', 'affinity', 'schedulerName', 'tolerations', 'hostAliases', 'priorityClassName', 'priority', 'dnsConfig', 'readinessGates', 'runtimeClassName', 'enableServiceLinks', 'preemptionPolicy', 'overhead', 'topologySpreadConstraints', 'setHostnameAsFQDN', 'os', 'hostUsers', 'schedulingGates', 'resourceClaims', 'ephemeralContainers'].map((k) => [k, ANY]),
  ),
};
const TEMPLATE: Schema = { metadata: META, spec: POD_SPEC };
const SELECTOR: Schema = { matchLabels: ANY, matchExpressions: ANY };
const TOP = (spec: Schema): Schema => ({ apiVersion: ANY, kind: ANY, metadata: META, spec, status: ANY });
const SCHEMAS: Record<string, Schema> = {
  Pod: TOP(POD_SPEC),
  Deployment: TOP({ replicas: ANY, selector: SELECTOR, template: TEMPLATE, strategy: { type: ANY, rollingUpdate: { maxSurge: ANY, maxUnavailable: ANY } }, minReadySeconds: ANY, revisionHistoryLimit: ANY, paused: ANY, progressDeadlineSeconds: ANY }),
  ReplicaSet: TOP({ replicas: ANY, selector: SELECTOR, template: TEMPLATE, minReadySeconds: ANY }),
  DaemonSet: TOP({ selector: SELECTOR, template: TEMPLATE, updateStrategy: ANY, minReadySeconds: ANY, revisionHistoryLimit: ANY }),
  Job: TOP({
    template: TEMPLATE,
    ...Object.fromEntries(['parallelism', 'completions', 'activeDeadlineSeconds', 'backoffLimit', 'selector', 'manualSelector', 'ttlSecondsAfterFinished', 'completionMode', 'suspend', 'podFailurePolicy', 'backoffLimitPerIndex', 'maxFailedIndexes', 'successPolicy', 'podReplacementPolicy'].map((k) => [k, ANY])),
  }),
  Service: TOP({
    ports: [{ name: ANY, protocol: ANY, appProtocol: ANY, port: ANY, targetPort: ANY, nodePort: ANY }],
    ...Object.fromEntries(
      ['selector', 'clusterIP', 'clusterIPs', 'type', 'externalIPs', 'sessionAffinity', 'loadBalancerIP', 'loadBalancerSourceRanges', 'externalName', 'externalTrafficPolicy', 'healthCheckNodePort', 'publishNotReadyAddresses', 'sessionAffinityConfig', 'ipFamilies', 'ipFamilyPolicy', 'allocateLoadBalancerNodePorts', 'loadBalancerClass', 'internalTrafficPolicy', 'trafficDistribution'].map((k) => [k, ANY]),
    ),
  }),
  ConfigMap: { apiVersion: ANY, kind: ANY, metadata: META, data: ANY, binaryData: ANY, immutable: ANY },
  Secret: { apiVersion: ANY, kind: ANY, metadata: META, data: ANY, stringData: ANY, type: ANY, immutable: ANY },
  Namespace: TOP({ finalizers: ANY }),
  StatefulSet: TOP({
    replicas: ANY,
    selector: SELECTOR,
    template: TEMPLATE,
    serviceName: ANY,
    volumeClaimTemplates: ANY,
    podManagementPolicy: ANY,
    updateStrategy: ANY,
    revisionHistoryLimit: ANY,
    minReadySeconds: ANY,
    persistentVolumeClaimRetentionPolicy: ANY,
    ordinals: ANY,
  }),
  CronJob: TOP({
    schedule: ANY,
    timeZone: ANY,
    startingDeadlineSeconds: ANY,
    concurrencyPolicy: ANY,
    suspend: ANY,
    successfulJobsHistoryLimit: ANY,
    failedJobsHistoryLimit: ANY,
    jobTemplate: { metadata: META, spec: { template: TEMPLATE, ...Object.fromEntries(['parallelism', 'completions', 'activeDeadlineSeconds', 'backoffLimit', 'ttlSecondsAfterFinished', 'completionMode', 'suspend'].map((k) => [k, ANY])) } },
  }),
  PersistentVolumeClaim: TOP({ accessModes: ANY, resources: { requests: ANY, limits: ANY }, storageClassName: ANY, volumeMode: ANY, volumeName: ANY, selector: ANY, dataSource: ANY, dataSourceRef: ANY, volumeAttributesClassName: ANY }),
  PersistentVolume: TOP(Object.fromEntries(['capacity', 'accessModes', 'persistentVolumeReclaimPolicy', 'storageClassName', 'volumeMode', 'claimRef', 'hostPath', 'local', 'nfs', 'csi', 'nodeAffinity', 'mountOptions'].map((k) => [k, ANY]))),
  StorageClass: { apiVersion: ANY, kind: ANY, metadata: META, provisioner: ANY, parameters: ANY, reclaimPolicy: ANY, volumeBindingMode: ANY, allowVolumeExpansion: ANY, mountOptions: ANY, allowedTopologies: ANY },
  Ingress: TOP({ ingressClassName: ANY, defaultBackend: ANY, tls: ANY, rules: [{ host: ANY, http: { paths: [{ path: ANY, pathType: ANY, backend: { service: { name: ANY, port: { number: ANY, name: ANY } }, resource: ANY } }] } }] }),
  IngressClass: TOP({ controller: ANY, parameters: ANY }),
  NetworkPolicy: TOP({ podSelector: ANY, policyTypes: ANY, ingress: ANY, egress: ANY }),
  HorizontalPodAutoscaler: TOP({ scaleTargetRef: ANY, minReplicas: ANY, maxReplicas: ANY, metrics: ANY, behavior: ANY }),
  ServiceAccount: { apiVersion: ANY, kind: ANY, metadata: META, secrets: ANY, imagePullSecrets: ANY, automountServiceAccountToken: ANY },
  Role: { apiVersion: ANY, kind: ANY, metadata: META, rules: [{ apiGroups: ANY, resources: ANY, verbs: ANY, resourceNames: ANY, nonResourceURLs: ANY }] },
  ClusterRole: { apiVersion: ANY, kind: ANY, metadata: META, rules: [{ apiGroups: ANY, resources: ANY, verbs: ANY, resourceNames: ANY, nonResourceURLs: ANY }], aggregationRule: ANY },
  RoleBinding: { apiVersion: ANY, kind: ANY, metadata: META, subjects: ANY, roleRef: ANY },
  ClusterRoleBinding: { apiVersion: ANY, kind: ANY, metadata: META, subjects: ANY, roleRef: ANY },
};

function unknownFields(v: J, schema: Schema | true, path: string, out: string[]): void {
  if (schema === true || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) return;
  for (const [k, sub] of Object.entries(v)) {
    const p = path ? `${path}.${k}` : k;
    const s = schema[k];
    if (s === undefined) {
      out.push(p);
      continue;
    }
    if (Array.isArray(s)) {
      if (Array.isArray(sub)) sub.forEach((item, i) => unknownFields(item, s[0], `${p}[${i}]`, out));
    } else unknownFields(sub, s, p, out);
  }
}

// ------------------------------------------------------------------ type checks

const GO_TYPES: Record<string, string> = {
  replicas: 'DeploymentSpec.spec.replicas of type int32',
  containerPort: 'ContainerPort.spec.containers.ports.containerPort of type int32',
  port: 'ServicePort.spec.ports.port of type int32',
};

function typeErrors(o: J): string | null {
  const kind = o.kind;
  const check = (v: J, path: string, want: 'int' | 'string', goField: string): string | null => {
    if (v === undefined || v === null) return null;
    if (want === 'int' && typeof v !== 'number') return `json: cannot unmarshal ${typeof v === 'string' ? 'string' : typeof v === 'boolean' ? 'bool' : 'object'} into Go struct field ${goField}`;
    if (want === 'int' && !Number.isInteger(v)) return `json: cannot unmarshal number ${v} into Go struct field ${goField}`;
    if (want === 'string' && typeof v !== 'string') return `json: cannot unmarshal ${typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'object'} into Go struct field ${goField}`;
    void path;
    return null;
  };
  const errs: (string | null)[] = [];
  if (kind === 'Deployment' || kind === 'ReplicaSet') errs.push(check(o.spec?.replicas, 'spec.replicas', 'int', `${kind}Spec.spec.replicas of type int32`));
  const pod = kind === 'Pod' ? o.spec : o.spec?.template?.spec;
  const prefix = kind === 'Pod' ? 'spec' : 'spec.template.spec';
  for (const c of pod?.containers ?? []) {
    for (const p of c.ports ?? []) errs.push(check(p.containerPort, '', 'int', `ContainerPort.${prefix}.containers.ports.containerPort of type int32`));
    for (const e of c.env ?? []) if (e.value !== undefined) errs.push(check(e.value, '', 'string', `EnvVar.${prefix}.containers.env.value of type string`));
  }
  if (kind === 'ConfigMap') for (const [k, v] of Object.entries(o.data ?? {})) errs.push(check(v, '', 'string', `ConfigMap.data of type string`) && `json: cannot unmarshal ${typeof v} into Go struct field ConfigMap.data of type string (key ${k})`);
  if (kind === 'Service') for (const p of o.spec?.ports ?? []) errs.push(check(p.port, '', 'int', 'ServicePort.spec.ports.port of type int32'));
  void GO_TYPES;
  return errs.find((e) => e) ?? null;
}

// ------------------------------------------------------------------ validation

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const LABEL_MSG = (v: string) =>
  `Invalid value: "${v}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')`;
const SUBDOMAIN_MSG = (v: string) =>
  `Invalid value: "${v}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')`;

function goMap(m: Record<string, string>): string {
  return `map[string]string{${Object.entries(m)
    .map(([k, v]) => `"${k}":"${v}"`)
    .join(', ')}}`;
}

function validatePodSpec(spec: J, path: string, errs: string[], allowedRestart?: string[], claimNames: string[] = []): void {
  if (!spec || !Array.isArray(spec.containers) || !spec.containers.length) {
    errs.push(`${path}.containers: Required value`);
    return;
  }
  const names = new Set<string>();
  spec.containers.forEach((c: J, i: number) => {
    const cp = `${path}.containers[${i}]`;
    if (!c.name) errs.push(`${cp}.name: Required value`);
    else if (!DNS_LABEL.test(c.name)) errs.push(`${cp}.name: ${LABEL_MSG(c.name)}`);
    else if (names.has(c.name)) errs.push(`${cp}.name: Duplicate value: "${c.name}"`);
    names.add(c.name);
    if (!c.image) errs.push(`${cp}.image: Required value`);
    for (const [j, p] of (c.ports ?? []).entries()) {
      if (typeof p.containerPort === 'number' && (p.containerPort < 1 || p.containerPort > 65535)) errs.push(`${cp}.ports[${j}].containerPort: Invalid value: ${p.containerPort}: must be between 1 and 65535, inclusive`);
    }
    for (const [j, e] of (c.env ?? []).entries()) if (!e.name) errs.push(`${cp}.env[${j}].name: Required value`);
    const res = c.resources ?? {};
    for (const kind of ['requests', 'limits']) {
      for (const [r, q] of Object.entries(res[kind] ?? {})) {
        if (!validQuantity(q)) errs.push(`${cp}.resources.${kind}[${r}]: Invalid value: "${q}": must match the regex ^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$`);
      }
    }
    if (res.requests?.memory && res.limits?.memory && memBytes(res.requests.memory) > memBytes(res.limits.memory)) {
      errs.push(`${cp}.resources.requests: Invalid value: "${res.requests.memory}": must be less than or equal to memory limit of ${res.limits.memory}`);
    }
    if (res.requests?.cpu && res.limits?.cpu && cpuMilli(res.requests.cpu) > cpuMilli(res.limits.cpu)) {
      errs.push(`${cp}.resources.requests: Invalid value: "${res.requests.cpu}": must be less than or equal to cpu limit of ${res.limits.cpu}`);
    }
    for (const [j, m] of (c.volumeMounts ?? []).entries()) {
      if (!(spec.volumes ?? []).some((v: J) => v.name === m.name) && !claimNames.includes(m.name)) errs.push(`${cp}.volumeMounts[${j}].name: Not found: "${m.name}"`);
      if (!m.mountPath) errs.push(`${cp}.volumeMounts[${j}].mountPath: Required value`);
    }
    for (const pk of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
      const pr = c[pk];
      if (pr && !pr.httpGet && !pr.tcpSocket && !pr.exec && !pr.grpc) errs.push(`${cp}.${pk}: Required value: must specify a handler type`);
    }
  });
  if (allowedRestart && spec.restartPolicy && !allowedRestart.includes(spec.restartPolicy)) {
    errs.push(
      allowedRestart.length === 1
        ? `${path}.restartPolicy: Unsupported value: "${spec.restartPolicy}": supported values: "Always"`
        : `${path}.restartPolicy: Required value: valid values: "OnFailure", "Never"`,
    );
  }
  if (allowedRestart && allowedRestart.length === 2 && !spec.restartPolicy) errs.push(`${path}.restartPolicy: Required value: valid values: "OnFailure", "Never"`);
}

function validate(o: J): string[] {
  const errs: string[] = [];
  const name = o.metadata?.name;
  if (!name) errs.push('metadata.name: Required value: name or generateName is required');
  else if (!(o.kind === 'Service' || o.kind === 'Namespace' ? DNS_LABEL : DNS_SUBDOMAIN).test(name)) {
    errs.push(`metadata.name: ${o.kind === 'Service' || o.kind === 'Namespace' ? LABEL_MSG(name).replace('a lowercase RFC 1123 label', 'a DNS-1035 label').replace("start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')", "start with an alphabetic character, and end with an alphanumeric character (e.g. 'my-name',  or 'abc-123', regex used for validation is '[a-z]([-a-z0-9]*[a-z0-9])?')") : SUBDOMAIN_MSG(name)}`);
  }
  for (const [k, v] of Object.entries(o.metadata?.labels ?? {})) {
    if (typeof v !== 'string') errs.push(`metadata.labels: Invalid value: ${JSON.stringify(v)}: must be a string (quote it in YAML: ${k}: "${v}")`);
  }
  switch (o.kind) {
    case 'Deployment':
    case 'ReplicaSet':
    case 'DaemonSet': {
      const sel = o.spec?.selector;
      if (!sel || (!sel.matchLabels && !sel.matchExpressions)) errs.push('spec.selector: Required value');
      const labels = o.spec?.template?.metadata?.labels ?? {};
      if (sel && Object.entries(sel.matchLabels ?? {}).some(([k, v]) => labels[k] !== v)) {
        errs.push(`spec.template.metadata.labels: Invalid value: ${goMap(labels)}: \`selector\` does not match template \`labels\``);
      }
      if (typeof o.spec?.replicas === 'number' && o.spec.replicas < 0) errs.push(`spec.replicas: Invalid value: ${o.spec.replicas}: must be greater than or equal to 0`);
      validatePodSpec(o.spec?.template?.spec, 'spec.template.spec', errs, ['Always']);
      break;
    }
    case 'Job':
      validatePodSpec(o.spec?.template?.spec, 'spec.template.spec', errs, ['OnFailure', 'Never']);
      break;
    case 'StatefulSet': {
      const sel = o.spec?.selector;
      if (!sel || (!sel.matchLabels && !sel.matchExpressions)) errs.push('spec.selector: Required value');
      const labels = o.spec?.template?.metadata?.labels ?? {};
      if (sel && Object.entries(sel.matchLabels ?? {}).some(([k, v]) => labels[k] !== v)) {
        errs.push(`spec.template.metadata.labels: Invalid value: ${goMap(labels)}: \`selector\` does not match template \`labels\``);
      }
      validatePodSpec(o.spec?.template?.spec, 'spec.template.spec', errs, ['Always'], (o.spec?.volumeClaimTemplates ?? []).map((t: J) => t.metadata?.name));
      for (const [i, t] of (o.spec?.volumeClaimTemplates ?? []).entries()) {
        if (!t.metadata?.name) errs.push(`spec.volumeClaimTemplates[${i}].metadata.name: Required value`);
        if (!(t.spec?.accessModes ?? []).length) errs.push(`spec.volumeClaimTemplates[${i}].spec.accessModes: Required value: at least 1 access mode is required`);
      }
      break;
    }
    case 'CronJob': {
      const sch = o.spec?.schedule;
      if (!sch) errs.push('spec.schedule: Required value');
      else if (!parseCron(sch)) errs.push(`spec.schedule: Invalid value: "${sch}": expected exactly 5 fields, found ${String(sch).trim().split(/\s+/).length}: ${sch}`);
      validatePodSpec(o.spec?.jobTemplate?.spec?.template?.spec, 'spec.jobTemplate.spec.template.spec', errs, ['OnFailure', 'Never']);
      break;
    }
    case 'PersistentVolumeClaim': {
      const modes: string[] = o.spec?.accessModes ?? [];
      if (!modes.length) errs.push('spec.accessModes: Required value: at least 1 access mode is required');
      for (const m of modes) if (!['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'].includes(m)) errs.push(`spec.accessModes: Unsupported value: "${m}": supported values: "ReadOnlyMany", "ReadWriteMany", "ReadWriteOnce", "ReadWriteOncePod"`);
      const st = o.spec?.resources?.requests?.storage;
      if (!st) errs.push('spec.resources[storage]: Required value');
      else if (!validQuantity(st)) errs.push(`spec.resources.requests[storage]: Invalid value: "${st}": quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'`);
      break;
    }
    case 'Ingress':
      for (const [i, r] of (o.spec?.rules ?? []).entries()) {
        for (const [j, path] of (r.http?.paths ?? []).entries()) {
          const at = `spec.rules[${i}].http.paths[${j}]`;
          if (!path.pathType) errs.push(`${at}.pathType: Required value: pathType must be specified`);
          else if (!['Prefix', 'Exact', 'ImplementationSpecific'].includes(path.pathType)) errs.push(`${at}.pathType: Unsupported value: "${path.pathType}": supported values: "Exact", "ImplementationSpecific", "Prefix"`);
          if (path.path && !String(path.path).startsWith('/')) errs.push(`${at}.path: Invalid value: "${path.path}": must be an absolute path`);
          if (!path.backend?.service?.name) errs.push(`${at}.backend: Invalid value: "": resource or service backend is required`);
          else if (path.backend.service.port?.number === undefined && path.backend.service.port?.name === undefined) errs.push(`${at}.backend.service.port: Invalid value: "": port name or number is required`);
        }
      }
      break;
    case 'HorizontalPodAutoscaler':
      if (!o.spec?.scaleTargetRef?.name) errs.push('spec.scaleTargetRef.name: Required value');
      if (!o.spec?.maxReplicas) errs.push('spec.maxReplicas: Invalid value: 0: must be greater than or equal to 1');
      if (o.spec?.minReplicas !== undefined && o.spec.maxReplicas !== undefined && o.spec.minReplicas > o.spec.maxReplicas) errs.push(`spec.maxReplicas: Invalid value: ${o.spec.maxReplicas}: must be greater than or equal to \`minReplicas\``);
      break;
    case 'RoleBinding':
    case 'ClusterRoleBinding':
      if (!o.roleRef?.name) errs.push('roleRef.name: Required value');
      if (o.roleRef?.kind && !['Role', 'ClusterRole'].includes(o.roleRef.kind)) errs.push(`roleRef.kind: Unsupported value: "${o.roleRef.kind}": supported values: "ClusterRole", "Role"`);
      if (o.kind === 'ClusterRoleBinding' && o.roleRef?.kind === 'Role') errs.push('roleRef.kind: Unsupported value: "Role": supported values: "ClusterRole"');
      for (const [i, sub] of (o.subjects ?? []).entries()) {
        if (!['User', 'Group', 'ServiceAccount'].includes(sub.kind)) errs.push(`subjects[${i}].kind: Unsupported value: "${sub.kind}": supported values: "Group", "ServiceAccount", "User"`);
        if (sub.kind === 'ServiceAccount' && !sub.namespace && o.kind === 'ClusterRoleBinding') errs.push(`subjects[${i}].namespace: Required value`);
      }
      break;
    case 'Role':
    case 'ClusterRole':
      for (const [i, r] of (o.rules ?? []).entries()) {
        if (!(r.verbs ?? []).length) errs.push(`rules[${i}].verbs: Required value: verbs must contain at least one value`);
        if (!r.nonResourceURLs && !(r.apiGroups ?? []).length) errs.push(`rules[${i}].apiGroups: Required value: resource rules must supply at least one api group`);
      }
      break;
    case 'Pod':
      validatePodSpec(o.spec, 'spec', errs);
      break;
    case 'Service': {
      const type = o.spec?.type ?? 'ClusterIP';
      if (!['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'].includes(type)) errs.push(`spec.type: Unsupported value: "${type}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`);
      if (type !== 'ExternalName' && !(o.spec?.ports ?? []).length) errs.push('spec.ports: Required value');
      for (const [i, p] of (o.spec?.ports ?? []).entries()) {
        if (p.port === undefined) errs.push(`spec.ports[${i}].port: Required value`);
        if (p.nodePort !== undefined && (p.nodePort < 30000 || p.nodePort > 32767)) errs.push(`spec.ports[${i}].nodePort: Invalid value: ${p.nodePort}: provided port is not in the valid range. The range of valid ports is 30000-32767`);
        if (p.nodePort !== undefined && type === 'ClusterIP') errs.push(`spec.ports[${i}].nodePort: Forbidden: may not be used when \`type\` is 'ClusterIP'`);
      }
      if ((o.spec?.ports ?? []).length > 1 && (o.spec.ports as J[]).some((p) => !p.name)) errs.push('spec.ports[1].name: Required value');
      break;
    }
  }
  return errs;
}

// ------------------------------------------------------------------ defaults

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

function defaultProbe(p: J): J {
  if (!p) return p;
  const out = { timeoutSeconds: 1, periodSeconds: 10, successThreshold: 1, failureThreshold: 3, ...p };
  if (out.httpGet) out.httpGet = { path: '/', scheme: 'HTTP', ...out.httpGet };
  return out;
}

export function defaultPodSpec(spec: J): J {
  const s = { dnsPolicy: 'ClusterFirst', restartPolicy: 'Always', schedulerName: 'default-scheduler', securityContext: {}, terminationGracePeriodSeconds: 30, ...spec };
  s.containers = (spec.containers ?? []).map((c: J) => {
    const tag = /:[^/:]+$/.test(c.image ?? '') ? (c.image as string).replace(/^.*:/, '') : 'latest';
    const out: J = {
      ...c,
      imagePullPolicy: c.imagePullPolicy ?? (tag === 'latest' ? 'Always' : 'IfNotPresent'),
      resources: c.resources ?? {},
      terminationMessagePath: c.terminationMessagePath ?? '/dev/termination-log',
      terminationMessagePolicy: c.terminationMessagePolicy ?? 'File',
    };
    if (c.ports) out.ports = c.ports.map((p: J) => ({ protocol: 'TCP', ...p }));
    for (const k of ['livenessProbe', 'readinessProbe', 'startupProbe']) if (c[k]) out[k] = defaultProbe(c[k]);
    return out;
  });
  return s;
}

function sortKeys(v: J): J {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** Fill in what the API server would (defaults, ids, cluster IPs). */
function withDefaults(ks: KubeState, o: J, now: number, existing?: KObj): KObj {
  const kind = o.kind;
  const namespaced = infoOf(kind).namespaced;
  const ns = namespaced ? (o.metadata.namespace ?? ks.namespace) : undefined;
  const meta = existing ? { ...existing.metadata } : newMeta(ks, now, o.metadata.name, ns);
  meta.labels = o.metadata.labels;
  meta.annotations = o.metadata.annotations;
  if (!meta.labels) delete meta.labels;
  if (!meta.annotations) delete meta.annotations;
  const out: KObj = { apiVersion: o.apiVersion, kind, metadata: meta };
  switch (kind) {
    case 'Deployment': {
      const spec = { replicas: 1, revisionHistoryLimit: 10, progressDeadlineSeconds: 600, ...o.spec };
      spec.strategy = o.spec.strategy?.type === 'Recreate' ? { type: 'Recreate' } : { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%', ...(o.spec.strategy?.rollingUpdate ?? {}) } };
      spec.template = { metadata: { ...(o.spec.template.metadata ?? {}) }, spec: defaultPodSpec(o.spec.template.spec) };
      out.spec = spec;
      out.status = existing?.status ?? {};
      break;
    }
    case 'ReplicaSet':
    case 'DaemonSet': {
      const spec = { ...o.spec, template: { metadata: { ...(o.spec.template.metadata ?? {}) }, spec: defaultPodSpec(o.spec.template.spec) } };
      if (kind === 'ReplicaSet') spec.replicas ??= 1;
      else spec.updateStrategy ??= { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } };
      if (kind === 'DaemonSet') spec.revisionHistoryLimit ??= 10;
      out.spec = spec;
      out.status = existing?.status ?? {};
      break;
    }
    case 'Job': {
      const id = existing?.metadata.uid ?? meta.uid;
      const autoLabels = { 'batch.kubernetes.io/controller-uid': id, 'batch.kubernetes.io/job-name': o.metadata.name, 'controller-uid': id, 'job-name': o.metadata.name };
      out.spec = {
        backoffLimit: 6,
        completionMode: 'NonIndexed',
        completions: 1,
        manualSelector: false,
        parallelism: 1,
        podReplacementPolicy: 'TerminatingOrFailed',
        suspend: false,
        ...o.spec,
        selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': id } },
        template: { metadata: { ...(o.spec.template.metadata ?? {}), labels: { ...(o.spec.template.metadata?.labels ?? {}), ...autoLabels } }, spec: defaultPodSpec(o.spec.template.spec) },
      };
      out.status = existing?.status ?? {};
      break;
    }
    case 'Pod':
      out.spec = { ...defaultPodSpec(o.spec), serviceAccountName: o.spec.serviceAccountName ?? 'default' };
      out.status = existing?.status ?? { phase: 'Pending', qosClass: qosClass(o.spec) };
      break;
    case 'Service': {
      const type = o.spec.type ?? 'ClusterIP';
      const spec: J = { sessionAffinity: 'None', internalTrafficPolicy: 'Cluster', ipFamilies: ['IPv4'], ipFamilyPolicy: 'SingleStack', ...o.spec, type };
      const ip = existing?.spec.clusterIP ?? o.spec.clusterIP ?? allocateClusterIP(ks, meta.uid);
      spec.clusterIP = ip;
      spec.clusterIPs = [ip];
      if (ip === 'None') delete spec.ipFamilyPolicy;
      spec.ports = (o.spec.ports ?? []).map((p: J, i: number) => {
        const port: J = { protocol: 'TCP', ...p, targetPort: p.targetPort ?? p.port };
        if (type === 'NodePort' || type === 'LoadBalancer') port.nodePort = p.nodePort ?? existing?.spec.ports?.[i]?.nodePort ?? allocateNodePort(ks, meta.uid + i);
        return port;
      });
      if (type === 'NodePort' || type === 'LoadBalancer') spec.externalTrafficPolicy ??= 'Cluster';
      out.spec = spec;
      out.status = { loadBalancer: {} };
      break;
    }
    case 'ConfigMap':
      if (o.data) out.data = Object.fromEntries(Object.entries(o.data).map(([k, v]) => [k, String(v)]));
      if (o.immutable !== undefined) out.immutable = o.immutable;
      break;
    case 'Secret': {
      const data: Record<string, string> = { ...(o.data ?? {}) };
      for (const [k, v] of Object.entries(o.stringData ?? {})) data[k] = b64(String(v));
      if (Object.keys(data).length) out.data = data;
      out.type = o.type ?? 'Opaque';
      break;
    }
    case 'Namespace':
      out.spec = { finalizers: ['kubernetes'] };
      out.status = { phase: 'Active' };
      meta.labels = { ...(meta.labels ?? {}), 'kubernetes.io/metadata.name': o.metadata.name };
      break;
    case 'StatefulSet':
      out.spec = {
        replicas: 1,
        podManagementPolicy: 'OrderedReady',
        revisionHistoryLimit: 10,
        persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
        updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 0 } },
        ...o.spec,
        template: { metadata: { ...(o.spec.template.metadata ?? {}) }, spec: defaultPodSpec(o.spec.template.spec) },
      };
      if (o.spec.volumeClaimTemplates) {
        out.spec.volumeClaimTemplates = o.spec.volumeClaimTemplates.map((t: J) => ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', ...t, spec: { volumeMode: 'Filesystem', ...t.spec }, status: { phase: 'Pending' } }));
      }
      out.status = existing?.status ?? { replicas: 0 };
      break;
    case 'CronJob':
      out.spec = {
        concurrencyPolicy: 'Allow',
        failedJobsHistoryLimit: 1,
        successfulJobsHistoryLimit: 3,
        suspend: false,
        ...o.spec,
        jobTemplate: { metadata: o.spec.jobTemplate?.metadata ?? {}, spec: { ...o.spec.jobTemplate.spec, template: { metadata: o.spec.jobTemplate.spec.template.metadata ?? {}, spec: defaultPodSpec(o.spec.jobTemplate.spec.template.spec) } } },
      };
      out.status = existing?.status ?? {};
      break;
    case 'PersistentVolumeClaim': {
      const dflt = listObjs(ks, 'StorageClass').find((c) => c.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true');
      out.spec = { volumeMode: 'Filesystem', ...o.spec };
      if (out.spec.storageClassName === undefined && dflt) out.spec.storageClassName = dflt.metadata.name;
      if (existing?.spec.volumeName) out.spec.volumeName = existing.spec.volumeName;
      out.status = existing?.status ?? { phase: 'Pending' };
      break;
    }
    case 'PersistentVolume':
      out.spec = { persistentVolumeReclaimPolicy: 'Retain', volumeMode: 'Filesystem', ...o.spec };
      out.status = existing?.status ?? { phase: 'Available' };
      break;
    case 'StorageClass':
      for (const k of ['provisioner', 'parameters', 'allowVolumeExpansion', 'mountOptions', 'allowedTopologies']) if (o[k] !== undefined) out[k] = o[k];
      out.reclaimPolicy = o.reclaimPolicy ?? 'Delete';
      out.volumeBindingMode = o.volumeBindingMode ?? 'Immediate';
      break;
    case 'Ingress':
      out.spec = o.spec;
      out.status = existing?.status ?? { loadBalancer: {} };
      break;
    case 'HorizontalPodAutoscaler':
      out.spec = {
        minReplicas: 1,
        ...o.spec,
        metrics: o.spec.metrics ?? [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } } }],
      };
      out.status = existing?.status ?? { currentReplicas: 0, desiredReplicas: 0 };
      break;
    case 'NetworkPolicy':
      out.spec = { podSelector: {}, ...o.spec };
      out.spec.policyTypes ??= o.spec.egress ? (o.spec.ingress ? ['Ingress', 'Egress'] : ['Ingress', 'Egress']) : ['Ingress'];
      break;
    case 'IngressClass':
      out.spec = o.spec ?? {};
      break;
    case 'ServiceAccount':
    case 'Role':
    case 'ClusterRole':
    case 'RoleBinding':
    case 'ClusterRoleBinding':
      for (const k of ['secrets', 'imagePullSecrets', 'automountServiceAccountToken', 'rules', 'aggregationRule', 'subjects', 'roleRef']) if (o[k] !== undefined) out[k] = o[k];
      if (out.roleRef) out.roleRef = { apiGroup: 'rbac.authorization.k8s.io', ...out.roleRef };
      if (kind === 'Role' || kind === 'ClusterRole') out.rules ??= [];
      break;
  }
  if (['Deployment', 'ReplicaSet', 'DaemonSet', 'Job', 'StatefulSet', 'CronJob', 'HorizontalPodAutoscaler'].includes(kind)) {
    const changed = !existing || JSON.stringify(sortKeys(existing.spec)) !== JSON.stringify(sortKeys(out.spec));
    meta.generation = existing ? (existing.metadata.generation ?? 1) + (changed ? 1 : 0) : 1;
  }
  return out;
}

// ------------------------------------------------------------------ entry points

export interface Admitted {
  obj: KObj;
  action: 'created' | 'configured' | 'unchanged';
}

function parseManifest(doc: J, source: string): void {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new AdmissionError(`error: error validating "${source}": error validating data: invalid object to validate; if you choose to ignore these errors, turn validation off with --validate=false`);
  if (!doc.apiVersion) throw new AdmissionError(`error: error validating "${source}": error validating data: apiVersion not set; if you choose to ignore these errors, turn validation off with --validate=false`);
  if (!doc.kind) throw new AdmissionError(`error: error validating "${source}": error validating data: kind not set; if you choose to ignore these errors, turn validation off with --validate=false`);
  if (LATER[doc.kind]) throw new AdmissionError(`devquest: ${doc.kind} objects are not simulated yet (they arrive in the next Kubernetes step)`);
  const want = KINDS[doc.kind];
  if (!want) {
    throw new AdmissionError(`error: resource mapping not found for name: "${doc.metadata?.name ?? ''}" namespace: "${doc.metadata?.namespace ?? ''}" from "${source}": no matches for kind "${doc.kind}" in version "${doc.apiVersion}"\nensure CRDs are installed first`);
  }
  if (doc.apiVersion !== want) {
    throw new AdmissionError(`error: resource mapping not found for name: "${doc.metadata?.name ?? ''}" namespace: "${doc.metadata?.namespace ?? ''}" from "${source}": no matches for kind "${doc.kind}" in version "${doc.apiVersion}"\nensure CRDs are installed first`);
  }
}

/**
 * Create or update an object from a manifest, like `kubectl apply` / `create` would.
 * Throws AdmissionError with kubectl's message.
 */
export function admit(ks: KubeState, doc: J, now: number, opts: { source: string; mode: 'apply' | 'create' | 'replace'; namespace?: string; lastApplied?: boolean }): Admitted {
  parseManifest(doc, opts.source);
  const kind = doc.kind;
  const verb = opts.mode === 'create' ? 'creating' : 'applying patch';
  const unknown: string[] = [];
  unknownFields(doc, SCHEMAS[kind], '', unknown);
  if (unknown.length) {
    throw new AdmissionError(
      `Error from server (BadRequest): error when ${opts.mode === 'create' ? 'creating' : 'creating'} "${opts.source}": ${kind} in version "${doc.apiVersion.split('/').pop()}" cannot be handled as a ${kind}: strict decoding error: ${unknown.map((u) => `unknown field "${u}"`).join(', ')}`,
    );
  }
  const typeErr = typeErrors(doc);
  if (typeErr) throw new AdmissionError(`Error from server (BadRequest): error when creating "${opts.source}": ${kind} in version "${doc.apiVersion.split('/').pop()}" cannot be handled as a ${kind}: ${typeErr}`);
  const o = JSON.parse(JSON.stringify(doc));
  o.metadata ??= {};
  const nsWanted = opts.namespace;
  if (infoOf(kind).namespaced) {
    if (o.metadata.namespace && nsWanted && o.metadata.namespace !== nsWanted) {
      throw new AdmissionError(`error: the namespace from the provided object "${o.metadata.namespace}" does not match the namespace "${nsWanted}". You must pass '--namespace=${o.metadata.namespace}' to perform this operation.`);
    }
    o.metadata.namespace ??= nsWanted ?? ks.namespace;
    if (!getObj(ks, 'Namespace', undefined, o.metadata.namespace)) {
      throw new AdmissionError(`Error from server (NotFound): error when creating "${opts.source}": namespaces "${o.metadata.namespace}" not found`);
    }
  }
  const errs = validate(o);
  if (errs.length) {
    const head = `The ${kind} "${o.metadata.name ?? ''}" is invalid: `;
    throw new AdmissionError(errs.length === 1 ? head + errs[0] : head + '\n' + errs.map((e) => `* ${e}`).join('\n'));
  }
  const existing = getObj(ks, kind, o.metadata.namespace, o.metadata.name);
  if (existing && opts.mode === 'create') {
    const r = infoOf(kind);
    throw new AdmissionError(`Error from server (AlreadyExists): error when ${verb} "${opts.source}": ${r.plural}${r.apiVersion.includes('/') ? '.' + r.apiVersion.split('/')[0] : ''} "${o.metadata.name}" already exists`);
  }
  if (opts.lastApplied) {
    const copy = JSON.parse(JSON.stringify(doc));
    if (infoOf(kind).namespaced) copy.metadata = { ...copy.metadata, namespace: o.metadata.namespace };
    o.metadata.annotations = { ...(o.metadata.annotations ?? {}), 'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify(sortKeys(copy)) + '\n' };
  }
  if (existing) {
    immutableChecks(existing, o);
    const next = withDefaults(ks, o, now, existing);
    // Annotations set by controllers survive an apply.
    for (const k of ['deployment.kubernetes.io/revision']) if (existing.metadata.annotations?.[k]) next.metadata.annotations = { ...(next.metadata.annotations ?? {}), [k]: existing.metadata.annotations[k] };
    if (kind === 'Pod') {
      next.spec.nodeName = existing.spec.nodeName;
      next.status = existing.status;
    }
    const top = (x: KObj) => Object.fromEntries(Object.entries(x).filter(([k]) => !['metadata', 'status', 'apiVersion', 'kind'].includes(k)));
    const before = JSON.stringify(sortKeys({ t: top(existing), l: existing.metadata.labels, a: stripLastApplied(existing.metadata.annotations) }));
    const after = JSON.stringify(sortKeys({ t: top(next), l: next.metadata.labels, a: stripLastApplied(next.metadata.annotations) }));
    if (before === after) {
      if (next.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']) existing.metadata.annotations = { ...(existing.metadata.annotations ?? {}), 'kubectl.kubernetes.io/last-applied-configuration': next.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'] };
      return { obj: existing, action: 'unchanged' };
    }
    next.metadata.resourceVersion = String(1000 + nextSeq(ks));
    Object.assign(existing, next);
    for (const k of Object.keys(existing)) if (!(k in next)) delete existing[k];
    return { obj: existing, action: 'configured' };
  }
  const created = withDefaults(ks, o, now);
  return { obj: created, action: 'created' };
}

function stripLastApplied(a: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!a) return a;
  const { ['kubectl.kubernetes.io/last-applied-configuration']: _drop, ['deployment.kubernetes.io/revision']: _rev, ...rest } = a;
  void _drop;
  void _rev;
  return Object.keys(rest).length ? rest : undefined;
}

function immutableChecks(existing: KObj, o: J): void {
  const kind = existing.kind;
  const name = existing.metadata.name;
  if (['Deployment', 'ReplicaSet', 'DaemonSet'].includes(kind) && JSON.stringify(sortKeys(existing.spec.selector)) !== JSON.stringify(sortKeys(o.spec.selector))) {
    throw new AdmissionError(`The ${kind} "${name}" is invalid: spec.selector: Invalid value: v1.LabelSelector{MatchLabels:${goMap(o.spec.selector?.matchLabels ?? {})}, MatchExpressions:[]v1.LabelSelectorRequirement(nil)}: field is immutable`);
  }
  if ((kind === 'RoleBinding' || kind === 'ClusterRoleBinding') && JSON.stringify(sortKeys({ apiGroup: 'rbac.authorization.k8s.io', ...o.roleRef })) !== JSON.stringify(sortKeys(existing.roleRef))) {
    throw new AdmissionError(`The ${kind} "${name}" is invalid: roleRef: Invalid value: rbac.RoleRef{APIGroup:"rbac.authorization.k8s.io", Kind:"${o.roleRef?.kind}", Name:"${o.roleRef?.name}"}: cannot change roleRef`);
  }
  if (kind === 'PersistentVolumeClaim') {
    const strip = (spec: J) => ({ ...spec, resources: undefined, volumeName: undefined, storageClassName: undefined });
    if (JSON.stringify(sortKeys(strip({ volumeMode: 'Filesystem', ...o.spec }))) !== JSON.stringify(sortKeys(strip(existing.spec))) || (o.spec.storageClassName !== undefined && o.spec.storageClassName !== existing.spec.storageClassName)) {
      throw new AdmissionError(`The PersistentVolumeClaim "${name}" is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims`);
    }
  }
  if (kind === 'StatefulSet') {
    const keep = (sp: J) => Object.fromEntries(Object.entries(sp ?? {}).filter(([k]) => !['replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy', 'minReadySeconds'].includes(k)));
    const vct = (sp: J) => (sp.volumeClaimTemplates ?? []).map((t: J) => ({ name: t.metadata?.name, spec: { ...t.spec, volumeMode: t.spec?.volumeMode ?? 'Filesystem' } }));
    if (JSON.stringify(sortKeys({ ...keep(existing.spec), volumeClaimTemplates: vct(existing.spec), revisionHistoryLimit: undefined, podManagementPolicy: existing.spec.podManagementPolicy })) !== JSON.stringify(sortKeys({ ...keep(o.spec), volumeClaimTemplates: vct(o.spec), revisionHistoryLimit: undefined, podManagementPolicy: o.spec.podManagementPolicy ?? 'OrderedReady' }))) {
      throw new AdmissionError(`The StatefulSet "${name}" is invalid: spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden`);
    }
  }
  if (kind === 'Service' && o.spec.clusterIP && o.spec.clusterIP !== existing.spec.clusterIP) {
    throw new AdmissionError(`The Service "${name}" is invalid: spec.clusterIPs[0]: Invalid value: []string{"${o.spec.clusterIP}"}: may not change once set`);
  }
  if (kind === 'Job' && JSON.stringify(sortKeys(stripJobLabels(existing.spec.template))) !== JSON.stringify(sortKeys(stripJobLabels({ metadata: o.spec.template.metadata ?? {}, spec: defaultPodSpec(o.spec.template.spec) })))) {
    throw new AdmissionError(`The Job "${name}" is invalid: spec.template: Invalid value: core.PodTemplateSpec{...}: field is immutable`);
  }
  if (kind === 'Pod') {
    const a = { ...defaultPodSpec(o.spec), serviceAccountName: o.spec.serviceAccountName ?? 'default' };
    const b = { ...existing.spec };
    delete b.nodeName;
    delete b.tolerations;
    delete a.tolerations;
    const strip = (s: J) => ({ ...s, containers: s.containers.map((c: J) => ({ ...c, image: '' })) });
    if (JSON.stringify(sortKeys(strip(a))) !== JSON.stringify(sortKeys(strip(b)))) {
      throw new AdmissionError(
        `The Pod "${name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`,\`spec.initContainers[*].image\`,\`spec.activeDeadlineSeconds\`,\`spec.tolerations\` (only additions to existing tolerations),\`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)`,
      );
    }
  }
}

function stripJobLabels(t: J): J {
  const labels = { ...(t.metadata?.labels ?? {}) };
  for (const k of ['batch.kubernetes.io/controller-uid', 'batch.kubernetes.io/job-name', 'controller-uid', 'job-name']) delete labels[k];
  return { metadata: { ...(t.metadata ?? {}), labels }, spec: t.spec };
}

export { iso, uid, templateHash };
