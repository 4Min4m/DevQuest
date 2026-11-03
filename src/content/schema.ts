import type { Check, Lesson } from '../game/types';
import { CHECK_TYPES } from '../game/validators';

const BRANCHES = [
  'linux-basics', 'files-permissions', 'processes', 'text-processing', 'docker-basics',
  'images-dockerfile', 'volumes-networks', 'compose', 'troubleshooting',
];

/** Collects every problem in a lesson file, so authors see them all at once. */
class Problems {
  list: string[] = [];
  add(where: string, msg: string) {
    this.list.push(`${where}: ${msg}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function checkCheck(c: unknown, where: string, p: Problems): void {
  if (!isObj(c)) return p.add(where, 'check must be an object');
  if (!CHECK_TYPES.includes(c.type as Check['type'])) return p.add(where, `unknown check type '${String(c.type)}'`);
  const needs = (k: string) => {
    if (!isStr(c[k])) p.add(where, `${String(c.type)} needs '${k}'`);
  };
  switch (c.type) {
    case 'fileExists':
    case 'fileMissing':
    case 'fileOwner':
    case 'cwd':
      needs('path');
      break;
    case 'fileContains':
      needs('path');
      if (c.text === undefined && c.regex === undefined && c.equals === undefined) {
        p.add(where, 'fileContains needs text, regex or equals');
      }
      break;
    case 'fileMode':
      needs('path');
      if (!/^[0-7]{3,4}$/.test(String(c.mode))) p.add(where, `fileMode needs an octal string mode, got '${String(c.mode)}'`);
      break;
    case 'varEquals':
      needs('name');
      break;
    case 'processRunning':
    case 'processAbsent':
      needs('match');
      break;
    case 'commandUsed':
      needs('command');
      break;
    case 'outputContains':
      if (c.text === undefined && c.regex === undefined) p.add(where, 'outputContains needs text or regex');
      break;
    case 'anyOf':
      if (!Array.isArray(c.checks) || !c.checks.length) p.add(where, 'anyOf needs checks');
      else c.checks.forEach((x, i) => checkCheck(x, `${where}.checks[${i}]`, p));
      break;
    case 'not':
      checkCheck(c.check, `${where}.check`, p);
      break;
  }
  for (const key of ['regex'] as const) {
    if (typeof c[key] === 'string') {
      try {
        new RegExp(c[key] as string);
      } catch {
        p.add(where, `invalid regex '${String(c[key])}'`);
      }
    }
  }
}

function checkMission(m: unknown, where: string, p: Problems): void {
  if (!isObj(m)) return p.add(where, 'mission must be an object');
  for (const k of ['id', 'title', 'prompt']) if (!isStr(m[k])) p.add(where, `missing '${k}'`);
  if (!['guided', 'free', 'boss'].includes(String(m.type))) p.add(where, `type must be guided, free or boss`);
  if (!Array.isArray(m.hints)) p.add(where, "missing 'hints' (use [] for none)");
  else {
    m.hints.forEach((h, i) => {
      if (!isObj(h) || !isStr(h.text) || typeof h.cost !== 'number') p.add(`${where}.hints[${i}]`, 'hint needs text and numeric cost');
    });
    if (m.type !== 'guided' && m.hints.length) p.add(where, `${String(m.type)} missions must not have hints`);
  }
  if (typeof m.xp !== 'number' || m.xp <= 0) p.add(where, "'xp' must be a positive number");
  if (typeof m.par !== 'number' || m.par <= 0) p.add(where, "'par' must be a positive number");
  if (!Array.isArray(m.solution) || !m.solution.length) p.add(where, "missing 'solution' (reference command lines)");
  const v = m.validator;
  if (!isObj(v) || !Array.isArray(v.checks) || !v.checks.length) p.add(where, 'validator needs at least one check');
  else {
    v.checks.forEach((c, i) => checkCheck(c, `${where}.validator.checks[${i}]`, p));
    if (v.guards !== undefined) {
      if (!Array.isArray(v.guards)) p.add(where, 'validator.guards must be a list');
      else v.guards.forEach((c, i) => checkCheck(c, `${where}.validator.guards[${i}]`, p));
    }
  }
}

/** Validate an untrusted parsed lesson. Throws with every problem listed. */
export function assertLesson(data: unknown, source: string): Lesson {
  const p = new Problems();
  if (!isObj(data)) throw new Error(`${source}: lesson must be an object`);
  for (const k of ['id', 'title', 'theory']) if (!isStr(data[k])) p.add(source, `missing '${k}'`);
  if (!BRANCHES.includes(String(data.branch))) p.add(source, `unknown branch '${String(data.branch)}'`);
  if (!Array.isArray(data.prerequisites)) p.add(source, "missing 'prerequisites' (use [] for none)");
  if (!Array.isArray(data.missions) || !data.missions.length) p.add(source, 'lesson needs missions');
  else {
    const ids = new Set<string>();
    data.missions.forEach((m, i) => {
      checkMission(m, `${source} missions[${i}]`, p);
      const id = isObj(m) ? String(m.id) : '';
      if (ids.has(id)) p.add(source, `duplicate mission id '${id}'`);
      ids.add(id);
    });
  }
  if (p.list.length) throw new Error('Invalid lesson content:\n  ' + p.list.join('\n  '));
  return data as unknown as Lesson;
}

/** Cross-lesson checks: unique ids and prerequisites that exist. */
export function assertCatalog(lessons: Lesson[]): void {
  const ids = new Set(lessons.map((l) => l.id));
  const problems: string[] = [];
  if (ids.size !== lessons.length) problems.push('duplicate lesson ids');
  for (const l of lessons) {
    for (const pre of l.prerequisites) if (!ids.has(pre)) problems.push(`${l.id}: unknown prerequisite '${pre}'`);
  }
  if (problems.length) throw new Error('Invalid lesson catalog:\n  ' + problems.join('\n  '));
}

