/** Helm releases: stored as Secrets `sh.helm.release.v1.NAME.vN`, applied to and removed from the cluster. */
import { parseAllDocuments } from 'yaml';
import { getObj, infoOf, listObjs, putObj, resourceFor } from '../kube/cluster';
import { admit, AdmissionError } from '../kube/manifest';
import type { J, KObj, KubeState } from '../kube/types';
import { HelmError, RenderedDoc } from './chart';

export interface ReleaseRecord {
  name: string;
  namespace: string;
  version: number;
  status: 'deployed' | 'superseded' | 'failed' | 'uninstalled' | 'pending-install' | 'pending-upgrade';
  chart: { name: string; version: string; appVersion: string };
  /** User-supplied values. */
  config: J;
  /** Computed (merged) values. */
  values: J;
  manifest: string;
  notes: string;
  firstDeployed: number;
  lastDeployed: number;
  description: string;
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s: string) => decodeURIComponent(escape(atob(s)));

export function secretName(name: string, version: number): string {
  return `sh.helm.release.v1.${name}.v${version}`;
}

/** All revisions of a release (oldest first). */
export function history(ks: KubeState, ns: string, name: string): ReleaseRecord[] {
  return listObjs(ks, 'Secret', ns)
    .filter((s) => s.type === 'helm.sh/release.v1' && s.metadata.labels?.name === name && s.metadata.labels?.owner === 'helm')
    .map((s) => JSON.parse(unb64(s.data!.release)) as ReleaseRecord)
    .sort((a, b) => a.version - b.version);
}

/** Every release's latest revision, in one namespace or all. */
export function latestReleases(ks: KubeState, ns?: string): ReleaseRecord[] {
  const byName = new Map<string, ReleaseRecord>();
  for (const s of listObjs(ks, 'Secret', ns)) {
    if (s.type !== 'helm.sh/release.v1' || s.metadata.labels?.owner !== 'helm') continue;
    const r = JSON.parse(unb64(s.data!.release)) as ReleaseRecord;
    const key = `${r.namespace}/${r.name}`;
    if (!byName.has(key) || byName.get(key)!.version < r.version) byName.set(key, r);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function saveRelease(ks: KubeState, now: number, r: ReleaseRecord): void {
  const name = secretName(r.name, r.version);
  const existing = getObj(ks, 'Secret', r.namespace, name);
  const labels = { modifiedAt: String(Math.floor(now / 1000)), name: r.name, owner: 'helm', status: r.status, version: String(r.version) };
  if (existing) {
    existing.data = { release: b64(JSON.stringify(r)) };
    existing.metadata.labels = labels;
    return;
  }
  const doc = { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: r.namespace, labels }, type: 'helm.sh/release.v1', data: { release: b64(JSON.stringify(r)) } };
  putObj(ks, admit(ks, doc, now, { source: 'helm', mode: 'create', namespace: r.namespace }).obj);
}

export function deleteReleaseSecrets(ks: KubeState, ns: string, name: string): void {
  for (const s of listObjs(ks, 'Secret', ns)) if (s.type === 'helm.sh/release.v1' && s.metadata.labels?.name === name) delete ks.objects.Secret[`${ns}/${s.metadata.name}`];
}

/** Objects named by a stored manifest: kind / namespace / name. */
export function manifestObjects(manifest: string, ns: string): { kind: string; namespace?: string; name: string }[] {
  const out: { kind: string; namespace?: string; name: string }[] = [];
  for (const d of parseAllDocuments(manifest)) {
    const o = d.toJS();
    if (!o?.kind || !o.metadata?.name) continue;
    const info = resourceFor(o.kind);
    out.push({ kind: o.kind, namespace: info?.namespaced === false ? undefined : o.metadata.namespace ?? ns, name: o.metadata.name });
  }
  return out;
}

const key = (kind: string, ns: string | undefined, name: string) => `${kind}/${ns ?? ''}/${name}`;

/** Admission error text as Helm reports it (without kubectl's "Error from server … when creating" prefix). */
function cleanError(msg: string): string {
  return msg.replace(/^Error from server \([A-Za-z]+\): /, '').replace(/^error when (creating|applying patch[^"]*) "[^"]*": /, '');
}

/**
 * Create or update every object of a rendered release (in install order). Objects that exist but belong to
 * no release (or another one) block the install, as Helm's ownership check does.
 */
export function applyRelease(ks: KubeState, now: number, docs: RenderedDoc[], rel: { name: string; namespace: string }, mode: 'install' | 'update', previous?: string): void {
  const prepared = docs.map((d) => {
    const o = JSON.parse(JSON.stringify(d.obj));
    o.metadata ??= {};
    const info = typeof o.kind === 'string' ? resourceFor(o.kind) : undefined;
    if (!info) throw new HelmError(`unable to build kubernetes objects from release manifest: resource mapping not found for name: "${o.metadata.name ?? ''}" namespace: "${o.metadata.namespace ?? ''}" from "": no matches for kind "${o.kind}" in version "${o.apiVersion}"\nensure CRDs are installed first`);
    if (info.namespaced) o.metadata.namespace ??= rel.namespace;
    o.metadata.labels = { ...(o.metadata.labels ?? {}), 'app.kubernetes.io/managed-by': 'Helm' };
    o.metadata.annotations = { ...(o.metadata.annotations ?? {}), 'meta.helm.sh/release-name': rel.name, 'meta.helm.sh/release-namespace': rel.namespace };
    return { d, o, info };
  });
  // Ownership: an existing object must carry this release's metadata.
  for (const { o, info } of prepared) {
    const existing = getObj(ks, o.kind, info.namespaced ? o.metadata.namespace : undefined, o.metadata.name);
    if (!existing) continue;
    const errs: string[] = [];
    if (existing.metadata.labels?.['app.kubernetes.io/managed-by'] !== 'Helm') errs.push('label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"');
    const rn = existing.metadata.annotations?.['meta.helm.sh/release-name'];
    const rns = existing.metadata.annotations?.['meta.helm.sh/release-namespace'];
    if (rn !== rel.name) errs.push(rn === undefined ? `annotation validation error: missing key "meta.helm.sh/release-name": must be set to "${rel.name}"` : `annotation validation error: key "meta.helm.sh/release-name" must equal "${rel.name}": current value is "${rn}"`);
    if (rns !== rel.namespace) errs.push(rns === undefined ? `annotation validation error: missing key "meta.helm.sh/release-namespace": must be set to "${rel.namespace}"` : `annotation validation error: key "meta.helm.sh/release-namespace" must equal "${rel.namespace}": current value is "${rns}"`);
    if (errs.length) {
      throw new HelmError(`Unable to continue with ${mode}: ${o.kind} "${o.metadata.name}" in namespace "${info.namespaced ? o.metadata.namespace : ''}" exists and cannot be imported into the current release: invalid ownership metadata; ${errs.join('; ')}`);
    }
  }
  // Validate everything first (on a copy), so a bad object doesn't leave a half-applied release.
  const shadow: KubeState = JSON.parse(JSON.stringify(ks));
  for (const { d, o } of prepared) {
    try {
      const r = admit(shadow, o, now, { source: d.source, mode: 'apply', namespace: rel.namespace });
      if (r.action === 'created') putObj(shadow, r.obj);
    } catch (e) {
      if (e instanceof AdmissionError) throw new HelmError(cleanError(e.message));
      throw e;
    }
  }
  for (const { d, o } of prepared) {
    const r = admit(ks, o, now, { source: d.source, mode: 'apply', namespace: rel.namespace });
    if (r.action === 'created') putObj(ks, r.obj);
  }
  // Objects the previous revision had but this one doesn't are deleted.
  if (previous !== undefined) {
    const keep = new Set(prepared.map(({ o, info }) => key(o.kind, info.namespaced ? o.metadata.namespace : undefined, o.metadata.name)));
    for (const old of manifestObjects(previous, rel.namespace)) {
      if (!keep.has(key(old.kind, old.namespace, old.name))) removeResource(ks, now, old);
    }
  }
}

let deleter: (ks: KubeState, now: number, o: KObj) => void = () => undefined;
/** Wired by the CLI to kubectl's delete semantics (graceful pod termination, finalizers). */
export function setDeleter(fn: typeof deleter): void {
  deleter = fn;
}

export function removeResource(ks: KubeState, now: number, ref: { kind: string; namespace?: string; name: string }): boolean {
  const info = resourceFor(ref.kind);
  if (!info) return false;
  const o = getObj(ks, info.kind, info.namespaced ? ref.namespace : undefined, ref.name);
  if (!o) return false;
  deleter(ks, now, o);
  return true;
}

export { infoOf };
