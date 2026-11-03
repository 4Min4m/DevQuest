import { containerJson, imageJson } from '../sim/docker/cli/objects';
import { DockerEngine } from '../sim/docker/engine';
import type { Container } from '../sim/docker/types';
import { httpRequest, parseUrl } from '../sim/net';
import type { SimState } from '../sim/state';
import { diskUsage, mountFor } from '../sim/disk';
import { unitName } from '../sim/systemd/unitfile';
import { normalize } from '../sim/vfs/path';
import type { FsNode } from '../sim/vfs/types';
import { Vfs } from '../sim/vfs/vfs';
import type { Check, Validator } from './types';

/** What a validator can look at: the final machine plus what the learner saw. */
export interface ValidationContext {
  state: SimState;
  /** stdout of every command line run during the mission, in order. */
  outputs: string[];
}

export interface CheckResult {
  check: Check;
  passed: boolean;
  /** Feedback for the learner, phrased as the goal ("... should ..."). */
  message: string;
}

export interface ValidationResult {
  passed: boolean;
  results: CheckResult[];
}

/** Validators see the real machine, unrestricted by the learner's permissions. */
function lookup(state: SimState, path: string): FsNode | undefined {
  try {
    return new Vfs(state.fs, { name: 'root', groups: ['root'] }).lookup(normalize(path));
  } catch {
    return undefined;
  }
}

function procMatches(command: string, match: string): boolean {
  return command.includes(match);
}

/** Default goal-style description of a check, used when the content gives no message. */
export function describe(check: Check): string {
  switch (check.type) {
    case 'fileExists':
      return `\`${check.path}\` should exist${check.kind ? ` as a ${check.kind === 'dir' ? 'directory' : 'file'}` : ''}`;
    case 'fileMissing':
      return `\`${check.path}\` should not exist`;
    case 'fileContains':
      return `\`${check.path}\` should ${check.equals !== undefined ? 'have exactly the expected content' : 'contain the expected content'}`;
    case 'fileMode':
      return `\`${check.path}\` should have mode ${check.mode}`;
    case 'fileOwner':
      return `\`${check.path}\` should be owned by ${[check.owner, check.group].filter(Boolean).join(':')}`;
    case 'cwd':
      return `your current directory should be \`${check.path}\``;
    case 'varEquals':
      return `variable \`${check.name}\` should be \`${check.value}\`${check.exported ? ' and exported' : ''}`;
    case 'processRunning':
      return `a process matching \`${check.match}\` should be running`;
    case 'processAbsent':
      return `no process matching \`${check.match}\` should be running`;
    case 'commandUsed':
      return `use \`${[check.command, ...(check.argsInclude ?? [])].join(' ')}\``;
    case 'outputContains':
      return 'the expected answer should appear in your terminal output';
    case 'anyOf':
      return check.checks.map(describe).join(', or ');
    case 'not':
      return `not: ${describe(check.check)}`;
    case 'containerRunning':
      return `a container${check.name ? ` named \`${check.name}\`` : ''}${check.image ? ` from image \`${check.image}\`` : ''} should be running`;
    case 'containerAbsent':
      return `container \`${check.name}\` should be removed`;
    case 'containerPort':
      return `container \`${check.name}\` should publish port ${check.hostPort}${check.containerPort ? ` → ${check.containerPort}` : ''}`;
    case 'containerEnv':
      return `container \`${check.name}\` should have \`${check.env}\` in its environment`;
    case 'containerMount':
      return `container \`${check.name}\` should mount ${check.source ? `\`${check.source}\`` : 'something'} at \`${check.target}\``;
    case 'containerNetwork':
      return `container \`${check.name}\` should be on network \`${check.network}\``;
    case 'containerInspect':
      return `container \`${check.name}\`: ${check.path} should be \`${check.equals}\``;
    case 'containerFile':
      return `\`${check.path}\` inside container \`${check.name}\` should have the expected content`;
    case 'imageExists':
      return `image \`${check.ref}\` should exist`;
    case 'imageInspect':
      return `image \`${check.ref}\`: ${check.path} should be \`${check.equals}\``;
    case 'volumeExists':
      return `volume \`${check.name}\` should exist`;
    case 'networkExists':
      return `network \`${check.name}\` should exist`;
    case 'httpResponds':
      return `${check.url} should respond${check.contains ? ` with \`${check.contains}\`` : ''}`;
    case 'serviceActive':
      return `\`${unitName(check.unit)}\` should be ${check.state ?? 'active'}`;
    case 'serviceEnabled':
      return `\`${unitName(check.unit)}\` should be ${check.enabled === false ? 'disabled' : 'enabled'} at boot`;
    case 'diskUsageBelow':
      return `the filesystem holding \`${check.mount}\` should be under ${check.percent}% full`;
    case 'inodeUsageBelow':
      return `the filesystem holding \`${check.mount}\` should use under ${check.percent}% of its inodes`;
  }
}

function engineOf(state: SimState): DockerEngine | null {
  return state.docker ? new DockerEngine(state, { silent: true }) : null;
}

function container(state: SimState, name: string): Container | undefined {
  try {
    return engineOf(state)?.findContainer(name);
  } catch {
    return undefined;
  }
}

/** Read a dotted path ("State.Status") out of inspect JSON. */
function pathValue(obj: unknown, path: string): string {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === 'object' ? JSON.stringify(cur) : String(cur ?? '');
}

function imageMatches(c: Container, ref: string): boolean {
  const withTag = ref.includes(':') ? ref : `${ref}:latest`;
  const img = c.image.includes(':') ? c.image : `${c.image}:latest`;
  return img === withTag;
}

function evaluate(check: Check, ctx: ValidationContext): boolean {
  const { state } = ctx;
  switch (check.type) {
    case 'fileExists': {
      const node = lookup(state, check.path);
      if (!node) return false;
      return !check.kind || (check.kind === 'dir' ? node.type === 'dir' : node.type === 'file');
    }
    case 'fileMissing':
      return lookup(state, check.path) === undefined;
    case 'fileContains': {
      const node = lookup(state, check.path);
      if (!node || node.type !== 'file') return false;
      if (check.equals !== undefined && node.content !== check.equals) return false;
      if (check.text !== undefined && !node.content.includes(check.text)) return false;
      if (check.regex !== undefined && !new RegExp(check.regex).test(node.content)) return false;
      return true;
    }
    case 'fileMode': {
      const node = lookup(state, check.path);
      return !!node && node.mode === parseInt(check.mode, 8);
    }
    case 'fileOwner': {
      const node = lookup(state, check.path);
      if (!node) return false;
      return (!check.owner || node.owner === check.owner) && (!check.group || node.group === check.group);
    }
    case 'cwd':
      return state.cwd === normalize(check.path);
    case 'varEquals':
      return state.vars[check.name] === check.value && (!check.exported || state.exported.includes(check.name));
    case 'processRunning':
      return state.processes.some((p) => procMatches(p.command, check.match));
    case 'processAbsent':
      return !state.processes.some((p) => procMatches(p.command, check.match));
    case 'commandUsed':
      return state.commandLog.some(
        (e) =>
          e.argv[0] === check.command &&
          (!check.succeeded || e.exitCode === 0) &&
          (check.argsInclude ?? []).every((a) => e.argv.slice(1).includes(a)),
      );
    case 'outputContains': {
      const re = check.regex !== undefined ? new RegExp(check.regex) : null;
      return ctx.outputs.some((o) => (re ? re.test(o) : check.text !== undefined && o.includes(check.text)));
    }
    case 'anyOf':
      return check.checks.some((c) => evaluate(c, ctx));
    case 'not':
      return !evaluate(check.check, ctx);
    case 'containerRunning':
      return (state.docker?.containers ?? []).some(
        (c) => c.status === 'running' && (!check.name || c.name === check.name) && (!check.image || imageMatches(c, check.image)),
      );
    case 'containerAbsent':
      return !(state.docker?.containers ?? []).some((c) => c.name === check.name);
    case 'containerPort': {
      const c = container(state, check.name);
      return (
        !!c &&
        c.status === 'running' &&
        c.ports.some((p) => p.hostPort === check.hostPort && (check.containerPort === undefined || p.containerPort === check.containerPort))
      );
    }
    case 'containerEnv': {
      const c = container(state, check.name);
      if (!c) return false;
      return check.env.includes('=') ? c.env.includes(check.env) : c.env.some((e) => e.startsWith(check.env + '='));
    }
    case 'containerMount': {
      const c = container(state, check.name);
      return !!c?.mounts.some(
        (m) => m.target === check.target && (!check.source || m.source === check.source) && (!check.mountType || m.type === check.mountType),
      );
    }
    case 'containerNetwork': {
      const c = container(state, check.name);
      return !!c && check.network in c.networks;
    }
    case 'containerInspect': {
      const e = engineOf(state);
      const c = container(state, check.name);
      return !!e && !!c && pathValue(containerJson(e, c), check.path) === check.equals;
    }
    case 'containerFile': {
      const c = container(state, check.name);
      if (!c) return false;
      try {
        const content = new Vfs(c.fs, { name: 'root', groups: ['root'] }).readFile(normalize(check.path));
        if (check.text !== undefined && !content.includes(check.text)) return false;
        if (check.regex !== undefined && !new RegExp(check.regex).test(content)) return false;
        return true;
      } catch {
        return false;
      }
    }
    case 'imageExists':
      return !!engineOf(state)?.findImage(check.ref);
    case 'imageInspect': {
      const img = engineOf(state)?.findImage(check.ref);
      return !!img && pathValue(imageJson(img), check.path) === check.equals;
    }
    case 'volumeExists':
      return !!engineOf(state)?.findVolume(check.name);
    case 'networkExists':
      return !!engineOf(state)?.findNetwork(check.name);
    case 'httpResponds': {
      const req = parseUrl(check.url);
      if (!req) return false;
      const r = httpRequest(state, req, { silent: true });
      if (r.kind !== 'response') return false;
      if (check.status !== undefined ? r.res.status !== check.status : r.res.status >= 400) return false;
      return check.contains === undefined || r.res.body.includes(check.contains);
    }
    case 'serviceActive': {
      const rt = state.systemd?.units[unitName(check.unit)];
      return (rt?.active ?? 'inactive') === (check.state ?? 'active');
    }
    case 'serviceEnabled': {
      const rt = state.systemd?.units[unitName(check.unit)];
      return (rt?.enabled ?? false) === (check.enabled ?? true);
    }
    case 'diskUsageBelow':
    case 'inodeUsageBelow': {
      const d = mountFor(state.disks, normalize(check.mount));
      if (!d) return false;
      const u = diskUsage(state, d);
      const pct = check.type === 'diskUsageBelow' ? (u.usedKb / (u.usedKb + u.availKb)) * 100 : (u.inodesUsed / u.inodes) * 100;
      return pct < check.percent;
    }
  }
}

export function runCheck(check: Check, ctx: ValidationContext): CheckResult {
  return { check, passed: evaluate(check, ctx), message: check.message ?? describe(check) };
}

export function validate(validator: Validator, ctx: ValidationContext): ValidationResult {
  const results = validator.checks.map((c) => runCheck(c, ctx));
  return { passed: results.every((r) => r.passed), results };
}

/** Guards that are currently broken. */
export function brokenGuards(validator: Validator, ctx: ValidationContext): CheckResult[] {
  return (validator.guards ?? []).map((c) => runCheck(c, ctx)).filter((r) => !r.passed);
}

export const CHECK_TYPES: readonly Check['type'][] = [
  'fileExists', 'fileMissing', 'fileContains', 'fileMode', 'fileOwner', 'cwd', 'varEquals',
  'processRunning', 'processAbsent', 'commandUsed', 'outputContains', 'anyOf', 'not',
  'containerRunning', 'containerAbsent', 'containerPort', 'containerEnv', 'containerMount', 'containerNetwork',
  'containerInspect', 'containerFile', 'imageExists', 'imageInspect', 'volumeExists', 'networkExists', 'httpResponds',
  'serviceActive', 'serviceEnabled', 'diskUsageBelow', 'inodeUsageBelow',
];
