/** trivy: image / filesystem / config scanning against the offline database. */
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { DockerEngine } from '../docker/engine';
import { findCatalog, parseRef } from '../docker/catalog';
import type { CommandContext, CommandDef } from '../shell/types';
import type { SimState } from '../state';
import { Vfs } from '../vfs/vfs';
import type { DirNode } from '../vfs/types';
import { secretFindings } from './gitleaks';
import { CURRENT_DEBIAN, IMAGE_VULNS, Misconfig, PKG_VULNS, Severity, versionLess, Vuln } from './vulndb';

const SEVS: Severity[] = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export interface Target {
  name: string;
  kind: string;
  vulns: Vuln[];
}

/** Language packages declared in a requirements.txt / package-lock.json / package.json. */
function langVulns(file: string, text: string): Target | null {
  const name = file.split('/').pop()!;
  const found: Vuln[] = [];
  if (name === 'requirements.txt') {
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*==\s*([\w.]+)/.exec(line);
      if (!m) continue;
      for (const v of PKG_VULNS.pip[m[1].toLowerCase()] ?? []) if (versionLess(m[2], v.fixed)) found.push({ pkg: m[1].toLowerCase(), id: v.id, severity: v.severity, installed: m[2], fixed: v.fixed, title: v.title });
    }
    return { name: file, kind: 'pip', vulns: found };
  }
  if (name === 'package-lock.json' || name === 'package.json') {
    let deps: Record<string, string> = {};
    try {
      const j = JSON.parse(text) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, string | { version: string }> };
      if (j.packages) for (const [k, v] of Object.entries(j.packages)) if (k.startsWith('node_modules/') && v.version) deps[k.slice(13)] = v.version;
      else if (j.dependencies) deps = Object.fromEntries(Object.entries(j.dependencies).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/^[\^~]/, '') : v.version]));
      if (!j.packages && j.dependencies) deps = Object.fromEntries(Object.entries(j.dependencies).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/^[\^~]/, '') : v.version]));
    } catch {
      return null;
    }
    for (const [pkg, ver] of Object.entries(deps)) for (const v of PKG_VULNS.npm[pkg] ?? []) if (versionLess(ver, v.fixed)) found.push({ pkg, id: v.id, severity: v.severity, installed: ver, fixed: v.fixed, title: v.title });
    return { name: file, kind: 'npm', vulns: found };
  }
  return null;
}

function walkFs(node: DirNode, path: string, visit: (p: string, content: string) => void, depth = 0) {
  if (depth > 6) return;
  for (const [name, child] of Object.entries(node.children)) {
    const p = `${path}/${name}`.replace('//', '/');
    if (['proc', 'sys', 'dev', 'usr', 'lib', 'bin', 'sbin', 'etc', 'var', 'node_modules'].includes(name) && depth === 0) continue;
    if (child.type === 'dir') walkFs(child, p, visit, depth + 1);
    else if (child.type === 'file') visit(p, child.content);
  }
}

/** Scan an image: OS packages from its base + language packages found in its filesystem. */
export function scanImage(state: SimState, ref: string): { targets: Target[]; os: string; display: string } | null {
  if (!state.docker) return null;
  const engine = new DockerEngine(state, { silent: true });
  const img = engine.findImage(ref);
  if (!img) return null;
  const base = img.base ?? `${img.repository}:${img.tag}`;
  const { repository, tag } = parseRef(base);
  const known = IMAGE_VULNS[`${repository}:${tag}`];
  const alpine = findCatalog(repository)?.tags.find((t) => t.name === tag)?.alpine || repository === 'alpine';
  const os = known?.os ?? (alpine ? 'alpine 3.20.3' : 'debian 12.7');
  const display = `${img.repository}:${img.tag}`;
  const targets: Target[] = [{ name: `${display} (${os})`, kind: os.split(' ')[0], vulns: known?.vulns ?? (alpine ? [] : CURRENT_DEBIAN) }];
  if (img.fs) {
    walkFs(img.fs, '', (p, content) => {
      const t = langVulns(p.replace(/^\//, ''), content);
      if (t) targets.push(t);
    });
  }
  return { targets, os, display };
}

function filter(vulns: Vuln[], sev: Severity[], ignoreUnfixed: boolean): Vuln[] {
  return vulns.filter((v) => sev.includes(v.severity) && (!ignoreUnfixed || v.fixed));
}

function table(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.min(i === 6 ? 40 : 30, Math.max(...rows.map((r) => r[i].length))));
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + '...' : s);
  const line = (l: string, m: string, r: string) => l + w.map((n) => '─'.repeat(n + 2)).join(m) + r;
  const row = (r: string[]) => '│' + r.map((c, i) => ` ${cut(c, w[i]).padEnd(w[i])} `).join('│') + '│';
  return [line('┌', '┬', '┐'), row(rows[0]), line('├', '┼', '┤'), ...rows.slice(1).map(row), line('└', '┴', '┘')].join('\n') + '\n';
}

function report(t: Target, vulns: Vuln[]): string {
  const counts = SEVS.map((s) => `${s}: ${vulns.filter((v) => v.severity === s).length}`).join(', ');
  let out = `\n${t.name}${t.kind === 'pip' || t.kind === 'npm' ? ` (${t.kind})` : ''}\n${'='.repeat(t.name.length + (t.kind === 'pip' || t.kind === 'npm' ? t.kind.length + 3 : 0))}\nTotal: ${vulns.length} (${counts})\n`;
  if (vulns.length) {
    const sorted = [...vulns].sort((a, b) => SEVS.indexOf(b.severity) - SEVS.indexOf(a.severity) || a.pkg.localeCompare(b.pkg));
    out += '\n' + table([['Library', 'Vulnerability', 'Severity', 'Status', 'Installed Version', 'Fixed Version', 'Title'], ...sorted.map((v) => [v.pkg, v.id, v.severity, v.fixed ? 'fixed' : 'affected', v.installed, v.fixed ?? '', v.title])]);
  }
  return out;
}

// ------------------------------------------------------------------ misconfigurations

export function dockerfileMisconfigs(text: string): Misconfig[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const out: Misconfig[] = [];
  const from = lines.find((l) => /^FROM\s/i.test(l)) ?? '';
  const img = from.split(/\s+/)[1] ?? '';
  const users = lines.filter((l) => /^USER\s/i.test(l)).map((l) => l.split(/\s+/)[1]);
  if (!users.length || ['root', '0'].includes(users[users.length - 1])) out.push({ id: 'DS002', severity: 'HIGH', title: 'Image user should not be \'root\'', message: 'Specify at least 1 USER command in Dockerfile with non-root user as argument', url: 'ds002' });
  if (!img.includes(':') || img.endsWith(':latest')) out.push({ id: 'DS001', severity: 'MEDIUM', title: "':latest' tag used", message: `Specify a tag in the 'FROM' statement for image '${img.split(':')[0]}'`, url: 'ds001' });
  if (lines.some((l) => /^ADD\s/i.test(l) && !/https?:\/\/|\.tar/.test(l))) out.push({ id: 'DS005', severity: 'LOW', title: 'ADD instead of COPY', message: "Consider using 'COPY' instead of 'ADD'", url: 'ds005' });
  if (!lines.some((l) => /^HEALTHCHECK\s/i.test(l))) out.push({ id: 'DS026', severity: 'LOW', title: 'No HEALTHCHECK defined', message: 'Add HEALTHCHECK instruction in your Dockerfile', url: 'ds026' });
  if (lines.some((l) => /^RUN\s.*\bapt-get\s+install\b/.test(l) && !/--no-install-recommends/.test(l))) out.push({ id: 'DS029', severity: 'HIGH', title: "'apt-get' missing '--no-install-recommends'", message: "'--no-install-recommends' flag is missed", url: 'ds029' });
  return out;
}

export function k8sMisconfigs(text: string): Misconfig[] {
  const out: Misconfig[] = [];
  for (const doc of parseAllDocuments(text)) {
    const o = doc.toJS() as { kind?: string; metadata?: { name?: string }; spec?: Record<string, unknown> } | null;
    if (!o?.kind) continue;
    const podSpec = (o.kind === 'Pod' ? o.spec : (o.spec as { template?: { spec?: Record<string, unknown> } })?.template?.spec) as { containers?: Record<string, unknown>[]; volumes?: { hostPath?: unknown }[]; hostNetwork?: boolean; securityContext?: Record<string, unknown> } | undefined;
    if (!podSpec?.containers) continue;
    const podSc = podSpec.securityContext ?? {};
    for (const c of podSpec.containers) {
      const sc = (c.securityContext as Record<string, unknown>) ?? {};
      const where = `Container '${c.name}' of ${o.kind} '${o.metadata?.name}'`;
      if (sc.privileged === true) out.push({ id: 'KSV017', severity: 'HIGH', title: 'Privileged container', message: `${where} should set 'securityContext.privileged' to false`, url: 'ksv017' });
      if (sc.allowPrivilegeEscalation !== false) out.push({ id: 'KSV001', severity: 'MEDIUM', title: 'Can elevate its own privileges', message: `${where} should set 'securityContext.allowPrivilegeEscalation' to false`, url: 'ksv001' });
      if (sc.runAsNonRoot !== true && podSc.runAsNonRoot !== true) out.push({ id: 'KSV012', severity: 'MEDIUM', title: 'Runs as root user', message: `${where} should set 'securityContext.runAsNonRoot' to true`, url: 'ksv012' });
      if (sc.readOnlyRootFilesystem !== true) out.push({ id: 'KSV014', severity: 'HIGH', title: 'Root file system is not read-only', message: `${where} should set 'securityContext.readOnlyRootFilesystem' to true`, url: 'ksv014' });
      const drop = ((sc.capabilities as { drop?: string[] })?.drop ?? []).map((x) => String(x).toUpperCase());
      if (!drop.includes('ALL')) out.push({ id: 'KSV106', severity: 'LOW', title: 'Container capabilities must only include NET_BIND_SERVICE', message: `${where} should drop all capabilities and add only NET_BIND_SERVICE`, url: 'ksv106' });
      const lim = (c.resources as { limits?: Record<string, unknown> })?.limits ?? {};
      if (!lim.memory) out.push({ id: 'KSV018', severity: 'LOW', title: 'Memory not limited', message: `${where} should set 'resources.limits.memory'`, url: 'ksv018' });
    }
    if (podSpec.volumes?.some((v) => v.hostPath)) out.push({ id: 'KSV023', severity: 'MEDIUM', title: 'hostPath volumes mounted', message: `${o.kind} '${o.metadata?.name}' should not set 'spec.template.volumes.hostPath'`, url: 'ksv023' });
    if (podSpec.hostNetwork) out.push({ id: 'KSV009', severity: 'HIGH', title: 'Access to host network', message: `${o.kind} '${o.metadata?.name}' should not set 'spec.template.spec.hostNetwork' to true`, url: 'ksv009' });
  }
  return out;
}

export function terraformMisconfigs(text: string): Misconfig[] {
  const out: Misconfig[] = [];
  for (const m of text.matchAll(/resource\s+"aws_security_group"\s+"(\w+)"\s*\{([\s\S]*?)\n\}/g)) {
    for (const ing of m[2].matchAll(/ingress\s*\{([\s\S]*?)\}/g)) {
      if (/"0\.0\.0\.0\/0"/.test(ing[1]) && /from_port\s*=\s*(22|3389)\b/.test(ing[1])) out.push({ id: 'AVD-AWS-0107', severity: 'CRITICAL', title: 'An ingress security group rule allows traffic from /0.', message: `Security group rule allows ingress from public internet to port ${/from_port\s*=\s*(\d+)/.exec(ing[1])![1]} (aws_security_group.${m[1]})`, url: 'aws/ec2/aws-ec2-no-public-ingress-sgr' });
    }
  }
  for (const m of text.matchAll(/resource\s+"aws_s3_bucket"\s+"(\w+)"/g)) {
    if (!new RegExp(`aws_s3_bucket_public_access_block[\\s\\S]*?bucket\\s*=\\s*aws_s3_bucket\\.${m[1]}\\.`).test(text)) out.push({ id: 'AVD-AWS-0094', severity: 'LOW', title: 'S3 buckets should each define an aws_s3_bucket_public_access_block', message: `Bucket does not have a corresponding public access block (aws_s3_bucket.${m[1]})`, url: 'aws/s3/aws-s3-specify-public-access-block' });
  }
  return out;
}

function misconfigReport(file: string, kind: string, found: Misconfig[], sev: Severity[], total: number): string {
  const f = found.filter((m) => sev.includes(m.severity));
  const counts = SEVS.map((s) => `${s}: ${f.filter((m) => m.severity === s).length}`).join(', ');
  let out = `\n${file} (${kind})\n${'='.repeat(file.length + kind.length + 3)}\nTests: ${total} (SUCCESSES: ${total - f.length}, FAILURES: ${f.length})\nFailures: ${f.length} (${counts})\n`;
  for (const m of f) out += `\n${m.id.startsWith('AVD') ? m.id : m.id.replace(/^([A-Z]+)(\d+)$/, (_x, a: string, d: string) => `AVD-${a}-${d.padStart(4, '0')}`)} (${m.severity}): ${m.message}\n${'═'.repeat(40)}\n${m.title}\n\nSee https://avd.aquasec.com/misconfig/${m.url}\n${'─'.repeat(40)}\n`;
  return out;
}

/** Files under dir (relative paths), skipping .git and node_modules. */
function filesIn(v: Vfs, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let names: string[] = [];
    try {
      names = v.readdir(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (n === '.git' || n === 'node_modules' || n === '.terraform') continue;
      const p = `${d}/${n}`;
      if (v.isDir(p)) walk(p, rel + n + '/');
      else out.push(rel + n);
    }
  };
  if (v.isDir(dir)) walk(dir, '');
  else out.push('');
  return out;
}

export function configFindings(v: Vfs, dir: string): { file: string; kind: string; found: Misconfig[]; total: number }[] {
  const res: { file: string; kind: string; found: Misconfig[]; total: number }[] = [];
  for (const f of filesIn(v, dir)) {
    const p = f ? `${dir}/${f}` : dir;
    const name = p.split('/').pop()!;
    let text: string;
    try {
      text = v.readFile(p);
    } catch {
      continue;
    }
    if (/^Dockerfile|\.dockerfile$|^Containerfile/.test(name)) res.push({ file: f || name, kind: 'dockerfile', found: dockerfileMisconfigs(text), total: 27 });
    else if (/\.ya?ml$/.test(name) && /\bkind:\s*(Deployment|Pod|StatefulSet|DaemonSet|Job|CronJob)\b/.test(text)) {
      try {
        parseYaml(text.split('\n---')[0]);
        res.push({ file: f || name, kind: 'kubernetes', found: k8sMisconfigs(text), total: 94 });
      } catch {
        /* invalid yaml */
      }
    } else if (name.endsWith('.tf')) res.push({ file: f || name, kind: 'terraform', found: terraformMisconfigs(text), total: 12 });
  }
  return res;
}

function logLine(ctx: CommandContext, quiet: boolean, msg: string) {
  if (!quiet) ctx.note(`${new Date(ctx.state.clock).toISOString().replace(/\.\d+Z$/, 'Z')}\tINFO\t${msg}\n`);
}

export const trivy: CommandDef = {
  name: 'trivy',
  summary: 'scan images, filesystems and IaC for vulnerabilities, secrets and misconfigurations',
  run(ctx) {
    const args = [...ctx.args];
    const flags: Record<string, string> = {};
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
      if (!m) {
        pos.push(a);
        continue;
      }
      const bool = ['ignore-unfixed', 'quiet', 'q', 'help', 'h', 'version', 'v'].includes(m[1]);
      flags[m[1]] = m[2] ?? (bool ? 'true' : args[++i] ?? '');
    }
    if (flags.version || flags.v || pos[0] === 'version') {
      ctx.out('Version: 0.56.2\nVulnerability DB:\n  Version: 2\n  UpdatedAt: 2026-11-06 06:12:44 +0000 UTC\n');
      return 0;
    }
    const [cmd, target] = pos;
    const quiet = flags.quiet === 'true' || flags.q === 'true';
    const sev = (flags.severity ? flags.severity.split(',').map((s) => s.trim().toUpperCase()) : SEVS) as Severity[];
    for (const s of sev) if (!SEVS.includes(s)) {
      ctx.err(`${new Date(ctx.state.clock).toISOString()}\tFATAL\tFatal error\tflag error: unknown severity option: ${s}\n`);
      return 1;
    }
    const exitCode = Number(flags['exit-code'] ?? 0);
    const ignoreUnfixed = flags['ignore-unfixed'] === 'true';
    const v = ctx.vfs;
    if (cmd === 'image' || cmd === 'i') {
      if (!target) {
        ctx.err('trivy image requires at least 1 argument\n');
        return 1;
      }
      const r = scanImage(ctx.state, target);
      if (!r) {
        ctx.err(`${new Date(ctx.state.clock).toISOString().replace(/\.\d+Z$/, 'Z')}\tFATAL\tFatal error\timage scan error: scan error: unable to initialize a scan service: unable to initialize an image scan service: unable to find the specified image "${target}" in ["docker" "containerd" "podman" "remote"]\n`);
        return 1;
      }
      logLine(ctx, quiet, '[vuln] Vulnerability scanning is enabled');
      logLine(ctx, quiet, `Detected OS\tfamily="${r.os.split(' ')[0]}" version="${r.os.split(' ')[1]}"`);
      let found = 0;
      for (const t of r.targets) {
        const vs = filter(t.vulns, sev, ignoreUnfixed);
        found += vs.length;
        if (t.kind === 'pip' || t.kind === 'npm') {
          if (!t.vulns.length) continue;
        }
        ctx.out(report(t, vs));
      }
      return found && exitCode ? exitCode : 0;
    }
    if (cmd === 'fs' || cmd === 'filesystem' || cmd === 'repo') {
      const dir = ctx.resolve(target ?? '.');
      const scanners = (flags.scanners ?? 'vuln,secret').split(',');
      logLine(ctx, quiet, `[vuln] Vulnerability scanning is enabled`);
      if (scanners.includes('secret')) logLine(ctx, quiet, `[secret] Secret scanning is enabled`);
      let found = 0;
      for (const f of filesIn(v, dir)) {
        let text: string;
        try {
          text = v.readFile(f ? `${dir}/${f}` : dir);
        } catch {
          continue;
        }
        if (scanners.includes('vuln')) {
          const t = langVulns(f || (target ?? ''), text);
          if (t) {
            const vs = filter(t.vulns, sev, ignoreUnfixed);
            found += vs.length;
            ctx.out(report(t, vs));
          }
        }
        if (scanners.includes('secret')) {
          const s = secretFindings(text).filter((x) => sev.includes(x.severity));
          if (s.length) {
            found += s.length;
            ctx.out(`\n${f} (secrets)\n${'='.repeat(f.length + 10)}\nTotal: ${s.length} (${SEVS.map((x) => `${x}: ${s.filter((y) => y.severity === x).length}`).join(', ')})\n\n` + s.map((x) => `${x.severity}: ${x.title} (${x.rule})\n${'═'.repeat(40)}\n${x.description}\n${'─'.repeat(40)}\n ${f}:${x.line}\n${'─'.repeat(40)}\n${String(x.line).padStart(3)} [ ${x.masked}\n${'─'.repeat(40)}\n`).join('\n'));
          }
        }
      }
      return found && exitCode ? exitCode : 0;
    }
    if (cmd === 'config') {
      const dir = ctx.resolve(target ?? '.');
      logLine(ctx, quiet, '[misconfig] Misconfiguration scanning is enabled');
      let found = 0;
      for (const r of configFindings(v, dir)) {
        const f = r.found.filter((m) => sev.includes(m.severity));
        found += f.length;
        ctx.out(misconfigReport(r.file, r.kind, r.found, sev, r.total));
      }
      return found && exitCode ? exitCode : 0;
    }
    ctx.err('Scanner for SBOM, vulnerabilities, misconfigurations and secrets\n\nUsage:\n  trivy [command]\n\nScanning Commands:\n  config      Scan config files for misconfigurations\n  filesystem  Scan local filesystem\n  image       Scan a container image\n');
    return 1;
  },
};
