/** The terraform command. */
import type { CommandContext, CommandDef } from '../shell/types';
import { unifiedHunks } from '../git/diff';
import { Vfs } from '../vfs/vfs';
import { applyPlan } from './apply';
import { Diag, loadModule, ModuleCfg, renderDiag, TfError } from './config';
import { Engine, instAddr, normalizeDir } from './engine';
import { evaluate, Sensitive } from './eval';
import { formatHcl } from './fmt';
import { HclError, parseHcl } from './hcl';
import { PROVIDERS, providerOf } from './providers';
import { legend, renderChange, renderDrift, renderOutputValue, renderVal } from './render';
import { Backend, BackendError, emptyState, localBackend, LockInfo, lockDetail, s3Backend, StateFile, TF_VERSION } from './state';

interface Flags {
  pos: string[];
  f: Record<string, string | true>;
  vars: string[];
  varFiles: string[];
  replace: string[];
}

function parseFlags(args: string[]): Flags {
  const r: Flags = { pos: [], f: {}, vars: [], varFiles: [], replace: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') {
      r.pos.push(a);
      continue;
    }
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m) {
      r.pos.push(a);
      continue;
    }
    const [, k, v] = m;
    const takesValue = ['var', 'var-file', 'out', 'replace', 'target', 'chdir', 'state', 'backend-config', 'lock-timeout', 'parallelism'].includes(k);
    const val = v ?? (takesValue && args[i + 1] !== undefined && !args[i + 1].startsWith('-') ? args[++i] : undefined);
    if (k === 'var') r.vars.push(val ?? '');
    else if (k === 'var-file') r.varFiles.push(val ?? '');
    else if (k === 'replace') r.replace.push(val ?? '');
    else r.f[k] = val ?? true;
  }
  return r;
}

const isFalse = (v: string | true | undefined) => v === 'false';

class Cli {
  vfs: Vfs;
  dir: string;
  constructor(public ctx: CommandContext, dir: string) {
    this.vfs = ctx.vfs;
    this.dir = dir;
  }
  out = (s: string) => this.ctx.out(s);
  err = (d: Diag | Diag[]) => {
    for (const x of Array.isArray(d) ? d : [d]) this.ctx.err('\n' + renderDiag(x));
  };
  read(p: string): string | null {
    try {
      return this.vfs.readFile(p.startsWith('/') ? p : `${this.dir}/${p}`);
    } catch {
      return null;
    }
  }
  write(p: string, c: string) {
    this.vfs.writeFile(p.startsWith('/') ? p : `${this.dir}/${p}`, c);
  }

  config(): ModuleCfg {
    return loadModule(this.vfs, this.dir);
  }

  /** Providers this configuration needs (explicit required_providers + implied by resource types). */
  required(cfg: ModuleCfg, all: ModuleCfg[]): Record<string, { source: string; version?: string }> {
    const req: Record<string, { source: string; version?: string }> = {};
    for (const m of all) {
      for (const [k, v] of Object.entries(m.required)) req[k] = v;
      for (const r of m.resources) {
        const p = providerOf(r.type);
        if (p !== 'terraform' && !req[p]) req[p] = { source: `hashicorp/${p}` };
      }
      for (const p of Object.keys(m.providers)) if (!req[p]) req[p] = { source: `hashicorp/${p}` };
    }
    void cfg;
    return req;
  }

  modulesOf(cfg: ModuleCfg): ModuleCfg[] {
    const out: ModuleCfg[] = [cfg];
    for (const call of Object.values(cfg.modules)) {
      if (!/^\.\.?\//.test(call.source)) continue;
      try {
        out.push(...this.modulesOf(loadModule(this.vfs, normalizeDir(`${cfg.dir}/${call.source}`))));
      } catch {
        /* reported by init */
      }
    }
    return out;
  }

  backend(cfg: ModuleCfg): Backend {
    if (cfg.backend?.type === 's3') {
      const a = Object.fromEntries(cfg.backend.block.body.attrs.map((x) => [x.name, evaluate(x.expr, { root: () => null })]));
      return s3Backend(this.ctx.state, { bucket: String(a.bucket), key: String(a.key), region: a.region as string | undefined });
    }
    return localBackend(this.ctx.state, this.dir);
  }

  /** Is the working directory initialized for this configuration? */
  checkInit(cfg: ModuleCfg): Diag | null {
    const lock = this.read('.terraform.lock.hcl') ?? '';
    const saved = this.read('.terraform/terraform.tfstate');
    const wantBackend = cfg.backend?.type ?? 'local';
    const haveBackend = saved ? (JSON.parse(saved).backend?.type as string) : 'local';
    if (wantBackend !== haveBackend) {
      return { summary: 'Backend initialization required, please run "terraform init"', detail: `Reason: ${wantBackend === 'local' ? 'Unsetting the previously set backend "' + haveBackend + '"' : `Initial configuration of the requested backend "${wantBackend}"`}\n\nThe "backend" is the interface that Terraform uses to store state,\nperform operations, etc. If this message is showing up, it means that the\nTerraform configuration you're using is using a custom configuration for\nthe Terraform backend.\n\nChanges to backend configurations require reinitialization. This allows\nTerraform to set up the new configuration, copy existing state, etc. Please run\n"terraform init" with either the "-reconfigure" or "-migrate-state" flags to\nuse the current configuration.\n\nIf the change reason above is incorrect, please verify your configuration\nhasn't changed and try again. At this point, no changes to your existing\nconfiguration or state have been made.` };
    }
    const mods = this.read('.terraform/modules/modules.json');
    for (const call of Object.values(cfg.modules)) {
      if (!mods || !mods.includes(`"Key":"${call.name}"`)) {
        return { summary: 'Module not installed', detail: 'This module is not yet installed. Run "terraform init" to install all modules required by this configuration.', file: call.file, pos: call.block.pos, line: call.block.line };
      }
    }
    const req = this.required(cfg, this.modulesOf(cfg));
    const missing = Object.values(req).filter((r) => !lock.includes(`"registry.terraform.io/${r.source}"`));
    if (missing.length) {
      return { summary: 'Inconsistent dependency lock file', detail: `The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n${missing.map((r) => `  - provider registry.terraform.io/${r.source}: required by this configuration but no version is selected`).join('\n')}\n\nTo make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init` };
    }
    return null;
  }

  /** Variable values: terraform.tfvars, *.auto.tfvars, -var-file, -var, TF_VAR_*. */
  vars(cfg: ModuleCfg, fl: Flags): Record<string, { value: unknown; raw: boolean }> {
    const out: Record<string, { value: unknown; raw: boolean }> = {};
    for (const [k, v] of Object.entries(this.ctx.env)) if (k.startsWith('TF_VAR_') && cfg.variables[k.slice(7)]) out[k.slice(7)] = { value: v, raw: true };
    const files: string[] = [];
    if (this.read('terraform.tfvars') !== null) files.push('terraform.tfvars');
    try {
      files.push(...this.vfs.readdir(this.dir).filter((f) => f.endsWith('.auto.tfvars')).sort());
    } catch {
      /* none */
    }
    for (const f of [...files, ...fl.varFiles]) {
      const t = this.read(f);
      if (t === null) throw new TfError([{ summary: 'Failed to read variables file', detail: `Given variables file ${f} does not exist.` }]);
      let body;
      try {
        body = parseHcl(t, f);
      } catch (e) {
        if (e instanceof HclError) throw new TfError([{ summary: e.summary, detail: e.detail, file: f, pos: e.pos, line: t.split('\n')[e.pos.line - 1] }]);
        throw e;
      }
      for (const a of body.attrs) {
        if (!cfg.variables[a.name]) {
          this.ctx.err('\n' + renderDiag({ severity: 'warning', summary: 'Value for undeclared variable', detail: `The root module does not declare a variable named "${a.name}" but a value was found in file "${f}". If you meant to use this value, add a "variable" block to the configuration.\n\nTo silence these warnings, use TF_VAR_... environment variables to provide certain "global" settings to all configurations in your organization. To reduce the verbosity of these warnings, use the -compact-warnings option.`, file: f, pos: a.pos, line: a.line }));
          continue;
        }
        out[a.name] = { value: evaluate(a.expr, { root: () => null }), raw: false };
      }
    }
    for (const v of fl.vars) {
      const i = v.indexOf('=');
      if (i < 0) throw new TfError([{ summary: 'Invalid -var option', detail: `The given -var option "${v}" is not correctly specified. Must be a variable name and value separated by an equals sign, like -var="key=value".` }]);
      const name = v.slice(0, i);
      if (!cfg.variables[name]) throw new TfError([{ summary: 'Value for undeclared variable', detail: `A variable named "${name}" was assigned on the command line, but the root module does not declare a variable of that name. To use this value, add a "variable" block to the configuration.` }]);
      out[name] = { value: v.slice(i + 1), raw: true };
    }
    // Interactive prompt for missing required variables (answers from stdin).
    const answers = this.ctx.stdin.split('\n');
    let ai = 0;
    for (const v of Object.values(cfg.variables)) {
      if (out[v.name] || v.default) continue;
      if (this.ctx.stdin && answers[ai] !== undefined && !/^yes$/.test(answers[ai])) {
        this.out(`var.${v.name}\n${v.description ? `  ${v.description}\n` : ''}\n  Enter a value: ${answers[ai]}\n\n`);
        out[v.name] = { value: answers[ai++], raw: true };
      }
    }
    this.stdinUsed = ai;
    return out;
  }
  stdinUsed = 0;

  readState(cfg: ModuleCfg): { backend: Backend; state: StateFile } {
    const backend = this.backend(cfg);
    try {
      return { backend, state: backend.read() ?? emptyState() };
    } catch (e) {
      if (e instanceof BackendError) throw new TfError([{ summary: e.summary, detail: e.detail }]);
      throw e;
    }
  }

  lock(backend: Backend, op: string, noLock: boolean): void {
    if (noLock) return;
    const info = backend.lockInfo();
    if (info) {
      this.out('');
      throw new TfError([{ summary: 'Error acquiring the state lock', detail: lockDetail(info, backend.kind === 's3') }]);
    }
    backend.lock({ ID: 'self', Operation: op, Info: '', Who: `${this.ctx.state.user}@${this.ctx.state.hostname}`, Version: TF_VERSION, Created: new Date(this.ctx.state.clock).toISOString(), Path: backend.describe });
  }

  unlock(backend: Backend) {
    const info = backend.lockInfo();
    if (info?.ID === 'self') backend.unlock();
  }

  confirm(question: string, detail: string): boolean {
    const answer = (this.ctx.stdin.split('\n')[this.stdinUsed] ?? '').trim();
    this.out(`\n${question}\n${detail}\n\n  Enter a value: ${answer}\n`);
    return answer === 'yes';
  }
}

function summary(changes: { action: string }[]): string {
  const add = changes.filter((c) => c.action === 'create' || c.action === 'replace').length;
  const change = changes.filter((c) => c.action === 'update').length;
  const destroy = changes.filter((c) => c.action === 'delete' || c.action === 'replace').length;
  return `Plan: ${add} to add, ${change} to change, ${destroy} to destroy.`;
}

function outputsDiff(e: Engine, prior: StateFile): string {
  const now = e.outputs();
  const lines: string[] = [];
  const names = [...new Set([...Object.keys(prior.outputs), ...Object.keys(now)])].sort();
  const w = Math.max(0, ...names.map((n) => n.length));
  for (const n of names) {
    const a = prior.outputs[n];
    const b = now[n];
    const fmt = (v: unknown, sens: boolean) => (sens ? '(sensitive value)' : renderVal(v, 2, '+'));
    if (!a && b) lines.push(`  + ${n.padEnd(w)} = ${fmt(b.value, b.sensitive)}`);
    else if (a && !b) lines.push(`  - ${n.padEnd(w)} = ${fmt(a.value, !!a.sensitive)} -> null`);
    else if (a && b && JSON.stringify(a.value) !== JSON.stringify(b.value instanceof Sensitive ? b.value.v : b.value)) lines.push(`  ~ ${n.padEnd(w)} = ${fmt(a.value, !!a.sensitive)} -> ${fmt(b.value, b.sensitive)}`);
  }
  return lines.length ? `\nChanges to Outputs:\n${lines.join('\n')}\n` : '';
}

function printOutputs(cli: Cli, outputs: StateFile['outputs']) {
  const names = Object.keys(outputs).sort();
  if (!names.length) return;
  cli.out('\nOutputs:\n\n');
  for (const n of names) cli.out(`${n} = ${outputs[n].sensitive ? '<sensitive>' : renderOutputValue(outputs[n].value)}\n`);
}

/** plan / apply / destroy share this. */
function run(cli: Cli, fl: Flags, mode: 'plan' | 'apply' | 'destroy'): number {
  let planFile: { serial: number; vars: string[]; varFiles: string[]; destroy: boolean; replace: string[] } | null = null;
  if (mode === 'apply' && fl.pos[0]) {
    const t = cli.read(fl.pos[0]);
    if (t === null || !t.startsWith('{"tfplan"')) {
      throw new TfError([{ summary: 'Failed to load "' + fl.pos[0] + '" as a plan file', detail: `Error: stat ${fl.pos[0]}: no such file or directory` }]);
    }
    planFile = JSON.parse(t).tfplan;
    fl.vars = planFile!.vars;
    fl.varFiles = planFile!.varFiles;
    fl.replace = planFile!.replace;
    if (planFile!.destroy) fl.f.destroy = true;
  }
  const cfg = cli.config();
  const initErr = cli.checkInit(cfg);
  if (initErr) throw new TfError([initErr]);
  const vars = cli.vars(cfg, fl);
  const { backend, state: prior } = cli.readState(cfg);
  if (planFile && planFile.serial !== prior.serial) {
    throw new TfError([{ summary: 'Saved plan is stale', detail: 'The given plan file can no longer be applied because the state was changed by another\noperation after the plan was created.' }]);
  }
  const destroy = mode === 'destroy' || !!fl.f.destroy;
  const noLock = isFalse(fl.f.lock);
  cli.lock(backend, mode === 'plan' ? 'OperationTypePlan' : 'OperationTypeApply', noLock);
  try {
    const e = new Engine({ cmd: cli.ctx, state: cli.ctx.state, dir: cli.dir, vars, prior, destroy, refresh: !isFalse(fl.f.refresh), replace: fl.replace, out: cli.out }, cfg);
    e.plan();
    const changes = [...e.changes.values()].filter((c) => c.action !== 'noop').sort((a, b) => a.addr.localeCompare(b.addr));
    const outDiff = outputsDiff(e, prior);
    cli.out(renderDrift(e.drift));
    if (!changes.length && !outDiff) {
      cli.out(`\nNo changes. ${destroy ? 'No objects need to be destroyed.' : 'Your infrastructure matches the configuration.'}\n\n${destroy ? 'Either you have not created any objects yet or the existing objects were\nalready deleted outside of Terraform.' : 'Terraform has compared your real infrastructure against your configuration\nand found no differences, so no changes are needed.'}\n`);
      if (mode === 'plan') return fl.f['detailed-exitcode'] ? 0 : 0;
    } else if (!changes.length) {
      cli.out(`\nChanges to Outputs:${outDiff.replace('\nChanges to Outputs:', '')}\nYou can apply this plan to save these new output values to the Terraform\nstate, without changing any real infrastructure.\n`);
    } else {
      cli.out(legend(changes) + changes.map(renderChange).join('\n') + '\n' + summary(changes) + '\n' + outDiff);
    }
    if (mode === 'plan') {
      if (typeof fl.f.out === 'string') {
        cli.write(fl.f.out, JSON.stringify({ tfplan: { serial: prior.serial, vars: fl.vars, varFiles: fl.varFiles, destroy, replace: fl.replace } }));
        cli.out(`\n${'─'.repeat(77)}\n\nSaved the plan to: ${fl.f.out}\n\nTo perform exactly these actions, run the following command to apply:\n    terraform apply "${fl.f.out}"\n`);
      } else if (changes.length || outDiff) {
        cli.out(`\n${'─'.repeat(77)}\n\nNote: You didn't use the -out option to save this plan, so Terraform can't\nguarantee to take exactly these actions if you run "terraform apply" now.\n`);
      }
      return fl.f['detailed-exitcode'] && changes.length ? 2 : 0;
    }
    if ((changes.length || outDiff) && !planFile && !fl.f['auto-approve']) {
      const ok = destroy
        ? cli.confirm('Do you really want to destroy all resources?', '  Terraform will destroy all your managed infrastructure, as shown above.\n  There is no undo. Only \'yes\' will be accepted to confirm.')
        : cli.confirm('Do you want to perform these actions?', '  Terraform will perform the actions described above.\n  Only \'yes\' will be accepted to approve.');
      if (!ok) {
        cli.out(`\n${destroy ? 'Destroy' : 'Apply'} cancelled.\n`);
        return 1;
      }
    }
    if (changes.length || outDiff || e.drift.length) cli.out('\n');
    const r = applyPlan(e, prior, cli.out);
    if (changes.length || outDiff || e.drift.length || r.error) backend.write(r.state);
    if (r.error) {
      cli.err(r.error.diags);
      return 1;
    }
    if (destroy) cli.out(`\nDestroy complete! Resources: ${r.destroyed} destroyed.\n`);
    else {
      cli.out(`\nApply complete! Resources: ${r.added} added, ${r.changed} changed, ${r.destroyed} destroyed.\n`);
      printOutputs(cli, r.state.outputs);
    }
    return 0;
  } finally {
    cli.unlock(backend);
  }
}

function init(cli: Cli, fl: Flags): number {
  const cfg = cli.config();
  if (cfg.requiredVersion && !satisfies(TF_VERSION, cfg.requiredVersion)) {
    throw new TfError([{ summary: 'Unsupported Terraform Core version', detail: `This configuration does not support Terraform version ${TF_VERSION}. To proceed, either choose another supported Terraform version or update this version constraint. Version constraints are normally set for good reason, so updating the constraint may lead to other errors or unexpected behavior.` }]);
  }
  const all = cli.modulesOf(cfg);
  cli.vfs.mkdir(`${cli.dir}/.terraform`, { parents: true });
  // Modules
  const calls = Object.values(cfg.modules);
  if (calls.length) {
    cli.out('Initializing modules...\n');
    const entries: string[] = [];
    for (const c of calls) {
      if (!/^\.\.?\//.test(c.source)) {
        throw new TfError([{ summary: 'Failed to download module', detail: `Could not download module "${c.name}" (${c.file}:${c.block.pos.line}) source code from "registry.terraform.io/${c.source}": devquest works offline, so only local modules (source = "./modules/...") can be installed.`, file: c.file, pos: c.block.pos, line: c.block.line }]);
      }
      const dir = normalizeDir(`${cli.dir}/${c.source}`);
      if (!cli.vfs.isDir(dir)) throw new TfError([{ summary: 'Unreadable module directory', detail: `Unable to evaluate directory symlink: lstat ${c.source}: no such file or directory`, file: c.file, pos: c.block.pos, line: c.block.line }]);
      cli.out(`- ${c.name} in ${c.source.replace(/^\.\//, '')}\n`);
      entries.push(`{"Key":"${c.name}","Source":"${c.source}","Dir":"${c.source.replace(/^\.\//, '')}"}`);
    }
    cli.vfs.mkdir(`${cli.dir}/.terraform/modules`, { parents: true });
    cli.write('.terraform/modules/modules.json', `{"Modules":[{"Key":"","Source":"","Dir":"."},${entries.join(',')}]}`);
  }
  // Backend
  cli.out('\nInitializing the backend...\n');
  const saved = cli.read('.terraform/terraform.tfstate');
  const prevType = saved ? (JSON.parse(saved).backend?.type as string) : 'local';
  const newType = cfg.backend?.type ?? 'local';
  if (newType === 's3') {
    const be = cli.backend(cfg);
    try {
      be.read();
    } catch (e) {
      if (e instanceof BackendError) throw new TfError([{ summary: e.summary, detail: e.detail }]);
      throw e;
    }
    if (prevType !== 's3') {
      const local = localBackend(cli.ctx.state, cli.dir).read();
      if (local && local.resources.length) {
        if (!fl.f['migrate-state'] && !fl.f['force-copy']) {
          const ok = cli.confirm('Do you want to copy existing state to the new backend?', '  Pre-existing state was found while migrating the previous "local" backend to the\n  newly configured "s3" backend. No existing state was found in the newly\n  configured "s3" backend. Do you want to copy this state to the new "s3"\n  backend? Enter "yes" to copy and "no" to start with an empty state.');
          if (ok) be.write(local);
        } else be.write(local);
        if (fl.f['force-copy'] || fl.f['migrate-state']) be.write(local);
      }
    }
    cli.out(`\nSuccessfully configured the backend "s3"! Terraform will automatically\nuse this backend unless the backend configuration changes.\n`);
  }
  cli.write('.terraform/terraform.tfstate', JSON.stringify({ version: 3, terraform_version: TF_VERSION, backend: { type: newType } }));
  // Providers
  cli.out('\nInitializing provider plugins...\n');
  const req = cli.required(cfg, all);
  const lock = cli.read('.terraform.lock.hcl');
  const locked: string[] = [];
  for (const [name, r] of Object.entries(req).sort()) {
    const p = PROVIDERS[name];
    if (!p || p.source !== r.source) {
      throw new TfError([{ summary: 'Failed to query available provider packages', detail: `Could not retrieve the list of available versions for provider ${r.source}: provider registry registry.terraform.io does not have a provider named registry.terraform.io/${r.source}\n\ndevquest simulates these providers: ${Object.values(PROVIDERS).filter((x) => x.version).map((x) => x.source).join(', ')}.` }]);
    }
    if (r.version && !satisfies(p.version, r.version)) {
      throw new TfError([{ summary: 'Failed to query available provider packages', detail: `Could not retrieve the list of available versions for provider ${r.source}: no available releases match the given constraints ${r.version}` }]);
    }
    if (lock?.includes(`"registry.terraform.io/${r.source}"`) && !fl.f.upgrade) {
      cli.out(`- Reusing previous version of ${r.source} from the dependency lock file\n- Using previously-installed ${r.source} v${p.version}\n`);
    } else {
      cli.out(`- Finding ${r.version ? `${r.source} versions matching "${r.version}"` : `latest version of ${r.source}`}...\n- Installing ${r.source} v${p.version}...\n- Installed ${r.source} v${p.version} (signed by HashiCorp)\n`);
    }
    locked.push(`provider "registry.terraform.io/${r.source}" {\n  version     = "${p.version}"\n${r.version ? `  constraints = "${r.version}"\n` : ''}  hashes = [\n    "h1:${btoa(r.source + p.version).slice(0, 43)}=",\n  ]\n}\n`);
  }
  cli.vfs.mkdir(`${cli.dir}/.terraform/providers`, { parents: true });
  const newLock = `# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\n${locked.join('\n')}`;
  if (!lock) cli.out('Terraform has created a lock file .terraform.lock.hcl to record the provider\nselections it made above. Include this file in your version control repository\nso that Terraform can guarantee to make the same selections by default when\nyou run "terraform init" in the future.\n');
  if (locked.length || !lock) cli.write('.terraform.lock.hcl', newLock);
  cli.out(`\nTerraform has been successfully initialized!\n\nYou may now begin working with Terraform. Try running "terraform plan" to see\nany changes that are required for your infrastructure. All Terraform commands\nshould now work.\n\nIf you ever set or change modules or backend configuration for Terraform,\nrerun this command to reinitialize your working directory. If you forget, other\ncommands will detect it and remind you to do so if necessary.\n`);
  return 0;
}

/** Version constraints: "~> 5.0", ">= 1.5, < 2.0", "= 3.6.3". */
export function satisfies(version: string, constraint: string): boolean {
  const v = version.split('.').map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return constraint.split(',').every((part) => {
    const m = /^\s*(~>|>=|<=|!=|>|<|=)?\s*([\d.]+)\s*$/.exec(part);
    if (!m) return true;
    const op = m[1] ?? '=';
    const c = m[2].split('.').map(Number);
    const d = cmp(v, c);
    if (op === '~>') {
      if (d < 0) return false;
      const fixed = c.slice(0, Math.max(1, c.length - 1));
      return fixed.every((x, i) => v[i] === x);
    }
    return op === '>=' ? d >= 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : op === '<' ? d < 0 : op === '!=' ? d !== 0 : d === 0;
  });
}

function fmt(cli: Cli, fl: Flags): number {
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const f of cli.vfs.readdir(dir).sort()) {
      if (f.startsWith('.')) continue;
      const p = `${dir}/${f}`;
      if (cli.vfs.isDir(p)) {
        if (fl.f.recursive) walk(p, rel + f + '/');
      } else if (/\.(tf|tfvars)$/.test(f)) files.push(rel + f);
    }
  };
  if (fl.pos[0]) {
    const p = cli.ctx.resolve(fl.pos[0]);
    if (cli.vfs.isDir(p)) walk(p, fl.pos[0].replace(/\/?$/, '/'));
    else files.push(fl.pos[0]);
  } else walk(cli.dir, '');
  let code = 0;
  for (const f of files) {
    const p = f.startsWith('/') ? f : `${fl.pos[0] && !cli.vfs.isDir(cli.ctx.resolve(fl.pos[0])) ? cli.ctx.state.cwd : cli.dir}/${fl.pos[0] && cli.vfs.isDir(cli.ctx.resolve(fl.pos[0])) ? f.slice(fl.pos[0].replace(/\/?$/, '/').length) : f}`;
    const full = fl.pos[0] && cli.vfs.isDir(cli.ctx.resolve(fl.pos[0])) ? `${cli.ctx.resolve(fl.pos[0])}/${f.slice(fl.pos[0].replace(/\/?$/, '/').length)}` : p;
    const text = cli.vfs.readFile(full);
    try {
      parseHcl(text, f);
    } catch (e) {
      if (e instanceof HclError) {
        cli.err({ summary: e.summary, detail: e.detail, file: f, pos: e.pos, line: text.split('\n')[e.pos.line - 1] });
        return 2;
      }
      throw e;
    }
    const nice = formatHcl(text);
    if (nice === text) continue;
    cli.out(f + '\n');
    if (fl.f.diff) cli.out(`--- old/${f}\n+++ new/${f}\n${unifiedHunks(text, nice)}`);
    if (fl.f.check) code = 3;
    else cli.vfs.writeFile(full, nice);
  }
  return code;
}

function validate(cli: Cli): number {
  const cfg = cli.config();
  const initErr = cli.checkInit(cfg);
  if (initErr) throw new TfError([initErr]);
  // Plan with placeholder variables against an empty state, without contacting providers for data.
  const vars: Record<string, { value: unknown; raw: boolean }> = {};
  for (const v of Object.values(cfg.variables)) if (!v.default) vars[v.name] = { value: v.type === 'number' ? 0 : v.type === 'bool' ? false : v.type?.startsWith('list') || v.type?.startsWith('set') ? [] : v.type?.startsWith('map') ? {} : 'x', raw: false };
  const e = new Engine({ cmd: cli.ctx, state: structuredClone(cli.ctx.state), dir: cli.dir, vars, prior: emptyState(), refresh: false, out: () => undefined }, cfg);
  try {
    e.plan();
  } catch (err) {
    if (err instanceof TfError && err.diags.some((d) => /credential|region|query returned|does not exist|no matching/i.test(d.summary + (d.detail ?? '')))) {
      /* provider/data-source problems are not validation errors */
    } else throw err;
  }
  cli.out('Success! The configuration is valid.\n\n');
  return 0;
}

function stateCmd(cli: Cli, fl: Flags): number {
  const [sub, a, b] = fl.pos;
  const cfg = cli.config();
  const { backend, state } = cli.readState(cfg);
  const addrs = () => state.resources.flatMap((r) => r.instances.map((i) => ({ r, i, addr: instAddr(r.module ? r.module + '.' : '', r.mode, r.type, r.name, i.index_key) })));
  switch (sub) {
    case 'list':
      for (const x of addrs()) if (!a || x.addr === a || x.addr.startsWith(a + '[') || x.addr.startsWith(a + '.')) cli.out(x.addr + '\n');
      return 0;
    case 'show': {
      const x = addrs().find((y) => y.addr === a);
      if (!x) throw new TfError([{ summary: 'No instance found for the given address!', detail: 'This command requires that the address references one specific instance.\nTo view the available instances, use "terraform state list". Please modify\nthe address to reference a specific instance.' }]);
      cli.out(showResource(x.addr, x.r.mode, x.r.type, x.r.name, x.i.attributes));
      return 0;
    }
    case 'rm': {
      const targets = fl.pos.slice(1);
      cli.lock(backend, 'OperationTypeInvalid', isFalse(fl.f.lock));
      try {
        let n = 0;
        for (const t of targets) {
          const before = addrs().filter((x) => x.addr === t || x.addr.replace(/\[.*\]$/, '') === t);
          if (!before.length) throw new TfError([{ summary: 'Invalid target address', detail: `No matching objects found. To view the available instances, use "terraform state list". Please modify the address to reference a specific instance.` }]);
          for (const x of before) {
            x.r.instances = x.r.instances.filter((i) => i !== x.i);
            cli.out(`Removed ${x.addr}\n`);
            n++;
          }
        }
        state.resources = state.resources.filter((r) => r.instances.length);
        state.serial++;
        backend.write(state);
        cli.out(`Successfully removed ${n} resource instance(s).\n`);
      } finally {
        cli.unlock(backend);
      }
      return 0;
    }
    case 'mv': {
      const x = addrs().find((y) => y.addr === a);
      if (!x) throw new TfError([{ summary: 'Invalid source address', detail: `Cannot move ${a}: does not match anything in the current state.` }]);
      if (addrs().some((y) => y.addr === b)) throw new TfError([{ summary: 'Invalid target address', detail: `Cannot move to ${b}: there is already a resource instance at that address in the current state.` }]);
      const m = /^((?:module\.[\w-]+\.)*)(?:(data)\.)?([\w-]+)\.([\w-]+)(?:\[(.+)\])?$/.exec(b ?? '');
      if (!m) throw new TfError([{ summary: 'Error parsing address', detail: `Invalid address "${b}".` }]);
      const [, mod, , type, name, key] = m;
      if (type !== x.r.type) throw new TfError([{ summary: 'Invalid state move request', detail: `Cannot move ${a} to ${b}: resource types don't match.` }]);
      x.r.instances = x.r.instances.filter((i) => i !== x.i);
      const modName = mod ? mod.replace(/\.$/, '') : undefined;
      let dest = state.resources.find((r) => r.module === modName && r.type === type && r.name === name && r.mode === x.r.mode);
      if (!dest) {
        dest = { ...(modName ? { module: modName } : {}), mode: x.r.mode, type, name, provider: x.r.provider, instances: [] };
        state.resources.push(dest);
      }
      const k = key === undefined ? undefined : /^\d+$/.test(key) ? Number(key) : key.replace(/^"|"$/g, '');
      dest.instances.push({ ...x.i, ...(k !== undefined ? { index_key: k } : {}) });
      if (k === undefined) delete dest.instances[dest.instances.length - 1].index_key;
      state.resources = state.resources.filter((r) => r.instances.length);
      state.serial++;
      backend.write(state);
      cli.out(`Move "${a}" to "${b}"\nSuccessfully moved 1 object(s).\n`);
      return 0;
    }
    case 'pull':
      cli.out(JSON.stringify(state, null, 2) + '\n');
      return 0;
  }
  cli.ctx.err('Usage: terraform [global options] state <subcommand> [options] [args]\n\n  This command has subcommands for advanced state management.\n\nSubcommands:\n    list                List resources in the state\n    mv                  Move an item in the state\n    pull                Pull current state and output to stdout\n    rm                  Remove instances from the state\n    show                Show a resource in the state\n');
  return 1;
}

function showResource(addr: string, mode: string, type: string, name: string, attrs: Record<string, unknown>): string {
  const keys = Object.keys(attrs).filter((k) => attrs[k] !== null && !(Array.isArray(attrs[k]) && !(attrs[k] as unknown[]).length) && !(typeof attrs[k] === 'object' && attrs[k] && !Array.isArray(attrs[k]) && !Object.keys(attrs[k] as object).length)).sort();
  const w = Math.max(0, ...keys.map((k) => k.length));
  const sens = PROVIDERS[providerOf(type)]?.resources[type]?.schema ?? {};
  return `# ${addr}:\n${mode === 'data' ? 'data' : 'resource'} "${type}" "${name}" {\n${keys.map((k) => `    ${k.padEnd(w)} = ${sens[k]?.sensitive ? '(sensitive value)' : renderOutputValue(attrs[k], 4)}`).join('\n')}\n}\n`;
}

function importCmd(cli: Cli, fl: Flags): number {
  const [addr, id] = fl.pos;
  if (!addr || !id) {
    cli.ctx.err('The import command expects two arguments.\nUsage: terraform [global options] import [options] ADDR ID\n');
    return 1;
  }
  const cfg = cli.config();
  const initErr = cli.checkInit(cfg);
  if (initErr) throw new TfError([initErr]);
  const m = /^(?:(data)\.)?([\w-]+)\.([\w-]+)(?:\[(.+)\])?$/.exec(addr);
  const rc = m && cfg.resources.find((r) => r.mode === 'managed' && r.type === m[2] && r.name === m[3]);
  if (!m || !rc) {
    throw new TfError([{ summary: 'Configuration for import target does not exist', detail: `The configuration for the given import target ${addr} does not exist. All target instances must have an associated configuration to be imported.` }]);
  }
  const { backend, state } = cli.readState(cfg);
  const key = m[4] === undefined ? undefined : /^\d+$/.test(m[4]) ? Number(m[4]) : m[4].replace(/^"|"$/g, '');
  const existing = state.resources.find((r) => r.type === m[2] && r.name === m[3] && !r.module)?.instances.find((i) => i.index_key === key);
  if (existing) throw new TfError([{ summary: 'Resource already managed by Terraform', detail: `Terraform is already managing a remote object for ${addr}. To import to this address you must first remove the existing object from the state.` }]);
  const rt = PROVIDERS[providerOf(rc.type)]?.resources[rc.type];
  if (!rt?.importer) throw new TfError([{ summary: 'resource ' + rc.type + ' doesn\'t support import', detail: '' }]);
  const vars = cli.vars(cfg, fl);
  const e = new Engine({ cmd: cli.ctx, state: cli.ctx.state, dir: cli.dir, vars, prior: state, out: cli.out }, cfg);
  cli.out(`${addr}: Importing from ID "${id}"...\n`);
  const p = e.provider(providerOf(rc.type));
  const attrs = rt.importer(p, id);
  if (!attrs) {
    throw new TfError([{ summary: 'Cannot import non-existent remote object', detail: `While attempting to import an existing object to "${addr}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.` }]);
  }
  cli.out(`${addr}: Import prepared!\n  Prepared ${rc.type} for import\n${addr}: Refreshing state... [id=${attrs.id}]\n`);
  let res = state.resources.find((r) => r.type === rc.type && r.name === rc.name && !r.module && r.mode === 'managed');
  if (!res) {
    res = { mode: 'managed', type: rc.type, name: rc.name, provider: `provider["registry.terraform.io/${PROVIDERS[providerOf(rc.type)].source}"]`, instances: [] };
    state.resources.push(res);
  }
  const full: Record<string, unknown> = {};
  for (const k of Object.keys(rt.schema)) full[k] = attrs[k] ?? null;
  res.instances.push({ ...(key !== undefined ? { index_key: key } : {}), schema_version: 0, attributes: full, sensitive_attributes: [] });
  state.serial++;
  backend.write(state);
  cli.out('\nImport successful!\n\nThe resources that were imported are shown above. These resources are now in\nyour Terraform state and will henceforth be managed by Terraform.\n\n');
  return 0;
}

function outputCmd(cli: Cli, fl: Flags): number {
  const cfg = cli.config();
  const { state } = cli.readState(cfg);
  const name = fl.pos[0];
  if (fl.f.json) {
    const o = name ? state.outputs[name]?.value : Object.fromEntries(Object.entries(state.outputs).map(([k, v]) => [k, { sensitive: !!v.sensitive, type: v.type, value: v.value }]));
    cli.out(JSON.stringify(o, null, 2) + '\n');
    return 0;
  }
  if (!name) {
    if (!Object.keys(state.outputs).length) {
      cli.ctx.err('\n' + renderDiag({ severity: 'warning', summary: 'No outputs found', detail: 'The state file either has no outputs defined, or all the defined outputs are\nempty. Please define an output in your configuration with the `output` keyword\nand run `terraform refresh` for it to become available. If you are using\ninterpolation, please verify the interpolated value is not empty. You can use\nthe `terraform console` command to assist.' }));
      return 0;
    }
    for (const k of Object.keys(state.outputs).sort()) cli.out(`${k} = ${state.outputs[k].sensitive ? '<sensitive>' : renderOutputValue(state.outputs[k].value)}\n`);
    return 0;
  }
  const o = state.outputs[name];
  if (!o) throw new TfError([{ summary: 'Output "' + name + '" not found', detail: 'The output variable requested could not be found in the state file. If you recently added this to your configuration, be sure to run `terraform apply`, since the state won\'t be updated with new output variables until that command is run.' }]);
  if (fl.f.raw) {
    if (typeof o.value === 'object' && o.value !== null) throw new TfError([{ summary: 'Unsupported value for raw output', detail: `The -raw option only supports strings, numbers, and boolean values, but output value "${name}" is ${Array.isArray(o.value) ? 'tuple' : 'object'}.\n\nUse the -json option for machine-readable representations of output values that have complex types.` }]);
    cli.out(String(o.value));
    return 0;
  }
  cli.out(renderOutputValue(o.value) + '\n');
  return 0;
}

function show(cli: Cli, fl: Flags): number {
  const cfg = cli.config();
  const { state } = cli.readState(cfg);
  if (fl.pos[0]) {
    const t = cli.read(fl.pos[0]);
    if (!t?.startsWith('{"tfplan"')) throw new TfError([{ summary: 'Failed to read the given file as a state or plan file', detail: `State read error: Error loading statefile: open ${fl.pos[0]}: no such file or directory` }]);
    const p = JSON.parse(t).tfplan;
    return run(cli, { ...fl, pos: [], vars: p.vars, varFiles: p.varFiles, replace: p.replace, f: { ...(p.destroy ? { destroy: true } : {}), lock: 'false' } }, 'plan');
  }
  if (fl.f.json) {
    cli.out(JSON.stringify({ format_version: '1.0', terraform_version: TF_VERSION, values: { outputs: state.outputs, root_module: { resources: state.resources.flatMap((r) => r.instances.map((i) => ({ address: instAddr(r.module ? r.module + '.' : '', r.mode, r.type, r.name, i.index_key), mode: r.mode, type: r.type, name: r.name, values: i.attributes }))) } } }) + '\n');
    return 0;
  }
  if (!state.resources.length) {
    cli.out('No state.\n');
    return 0;
  }
  const blocks = state.resources.flatMap((r) => r.instances.map((i) => showResource(instAddr(r.module ? r.module + '.' : '', r.mode, r.type, r.name, i.index_key), r.mode, r.type, r.name, i.attributes)));
  cli.out(blocks.join('\n'));
  if (Object.keys(state.outputs).length) printOutputs(cli, state.outputs);
  return 0;
}

function forceUnlock(cli: Cli, fl: Flags): number {
  const id = fl.pos[0];
  if (!id) {
    cli.ctx.err('Expected a single argument: LOCK_ID\n');
    return 1;
  }
  const cfg = cli.config();
  const backend = cli.backend(cfg);
  const info: LockInfo | null = backend.lockInfo();
  if (!info || info.ID !== id) {
    throw new TfError([{ summary: 'Failed to unlock state: ' + (info ? `lock ID "${id}" does not match existing lock ID "${info.ID}"` : 'failed to retrieve lock info for lock ID "' + id + '"'), detail: '' }]);
  }
  if (!fl.f.force) {
    const ok = cli.confirm('Do you really want to force-unlock?', '  Terraform will remove the lock on the remote state.\n  This will allow local Terraform commands to modify this state, even though it\n  may still be in use. Only \'yes\' will be accepted to confirm.');
    if (!ok) {
      cli.out('force-unlock cancelled.\n');
      return 1;
    }
  }
  backend.unlock();
  cli.out('\nTerraform state has been successfully unlocked!\n\nThe state has been unlocked, and Terraform commands should now be able to\nobtain a new lock on the remote state.\n');
  return 0;
}

function taint(cli: Cli, fl: Flags, on: boolean): number {
  const addr = fl.pos[0];
  const cfg = cli.config();
  const { backend, state } = cli.readState(cfg);
  for (const r of state.resources) for (const i of r.instances) {
    if (instAddr(r.module ? r.module + '.' : '', r.mode, r.type, r.name, i.index_key) !== addr) continue;
    const ii = i as typeof i & { status?: string };
    if (on) ii.status = 'tainted';
    else delete ii.status;
    state.serial++;
    backend.write(state);
    cli.out(`Resource instance ${addr} has been ${on ? 'marked as tainted' : 'successfully untainted'}.\n`);
    return 0;
  }
  throw new TfError([{ summary: 'No such resource instance', detail: `There is no resource instance in the state with the address ${addr}. If the resource configuration has just been added, you must run "terraform apply" once to create the corresponding instance(s) before they can be tainted.` }]);
}

const HELP = `Usage: terraform [global options] <subcommand> [args]

The available commands for execution are listed below.
The primary workflow commands are given first, followed by
less common or more advanced commands.

Main commands:
  init          Prepare your working directory for other commands
  validate      Check whether the configuration is valid
  plan          Show changes required by the current configuration
  apply         Create or update infrastructure
  destroy       Destroy previously-created infrastructure

All other commands:
  fmt           Reformat your configuration in the standard style
  force-unlock  Release a stuck lock on the current workspace
  import        Associate existing infrastructure with a Terraform resource
  output        Show output values from your root module
  refresh       Update the state to match remote systems
  show          Show the current state or a saved plan
  state         Advanced state management
  taint         Mark a resource instance as not fully functional
  untaint       Remove the 'tainted' state from a resource instance
  version       Show the current Terraform version

Global options (use these before the subcommand, if any):
  -chdir=DIR    Switch to a different working directory before executing the
                given subcommand.
`;

export const terraform: CommandDef = {
  name: 'terraform',
  summary: 'infrastructure as code: init, plan, apply, destroy (aws, random, local, null providers)',
  run(ctx) {
    const args = [...ctx.args];
    let dir = ctx.state.cwd;
    while (args[0]?.startsWith('-chdir=')) dir = ctx.resolve(args.shift()!.slice(7));
    const sub = args.shift();
    if (!sub || sub === '-help' || sub === '--help' || sub === 'help') {
      (sub ? ctx.out : ctx.err)(HELP);
      return sub ? 0 : 127;
    }
    if (sub === 'version' || sub === '-version' || sub === '--version' || sub === '-v') {
      ctx.out(`Terraform v${TF_VERSION}\non linux_amd64\n`);
      try {
        const lock = ctx.vfs.readFile(`${dir}/.terraform.lock.hcl`);
        for (const m of lock.matchAll(/provider "registry\.terraform\.io\/([^"]+)" \{\n\s+version\s+= "([^"]+)"/g)) ctx.out(`+ provider registry.terraform.io/${m[1]} v${m[2]}\n`);
      } catch {
        /* no lock file */
      }
      return 0;
    }
    const cli = new Cli(ctx, dir);
    const fl = parseFlags(args);
    try {
      switch (sub) {
        case 'init':
          return init(cli, fl);
        case 'fmt':
          return fmt(cli, fl);
        case 'validate':
          return validate(cli);
        case 'plan':
          return run(cli, fl, 'plan');
        case 'apply':
          return run(cli, fl, fl.f.destroy ? 'destroy' : 'apply');
        case 'destroy':
          return run(cli, fl, 'destroy');
        case 'refresh': {
          fl.f['auto-approve'] = true;
          return run(cli, fl, 'apply');
        }
        case 'output':
          return outputCmd(cli, fl);
        case 'show':
          return show(cli, fl);
        case 'state':
          return stateCmd(cli, fl);
        case 'import':
          return importCmd(cli, fl);
        case 'force-unlock':
          return forceUnlock(cli, fl);
        case 'taint':
          return taint(cli, fl, true);
        case 'untaint':
          return taint(cli, fl, false);
        case 'workspace':
          if (fl.pos[0] === 'list') ctx.out('* default\n\n');
          else if (fl.pos[0] === 'show') ctx.out('default\n');
          else {
            ctx.err('devquest: only the default workspace is simulated (terraform workspace list / show)\n');
            return 1;
          }
          return 0;
        case 'console':
        case 'graph':
        case 'providers':
        case 'login':
        case 'test':
          ctx.err(`devquest: 'terraform ${sub}' is a real command, but it is not simulated\n`);
          return 1;
      }
      ctx.err(`Terraform has no command named "${sub}".\n\nTo see all of Terraform's top-level commands, run:\n  terraform -help\n\n`);
      return 1;
    } catch (e) {
      if (e instanceof TfError) {
        cli.err(e.diags);
        return 1;
      }
      throw e;
    }
  },
};
