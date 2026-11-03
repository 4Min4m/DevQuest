import type { SimState } from '../sim/state';
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
  }
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
];
