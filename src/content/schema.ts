import type { Check, Lesson } from '../game/types';
import { CHECK_TYPES } from '../game/validators';

const BRANCHES = [
  'foundations', 'networking', 'storage-databases', 'system-design', 'sre',
  'linux-basics', 'files-permissions', 'processes', 'text-processing', 'docker-basics',
  'images-dockerfile', 'volumes-networks', 'compose', 'troubleshooting',
  'version-control', 'kubernetes', 'cicd', 'cloud-iac', 'observability', 'security',
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
    case 'containerAbsent':
    case 'containerEnv':
    case 'containerMount':
    case 'containerNetwork':
    case 'containerInspect':
    case 'containerFile':
    case 'containerPort':
      needs('name');
      if (c.type === 'containerEnv') needs('env');
      if (c.type === 'containerMount') needs('target');
      if (c.type === 'containerNetwork') needs('network');
      if (c.type === 'containerInspect') {
        needs('path');
        if (typeof c.equals !== 'string') p.add(where, 'containerInspect needs a string "equals"');
      }
      if (c.type === 'containerFile') needs('path');
      if (c.type === 'containerPort' && typeof c.hostPort !== 'number') p.add(where, 'containerPort needs a numeric hostPort');
      break;
    case 'containerRunning':
      if (!isStr(c.name) && !isStr(c.image)) p.add(where, 'containerRunning needs name or image');
      break;
    case 'imageExists':
    case 'imageInspect':
      needs('ref');
      if (c.type === 'imageInspect') needs('path');
      break;
    case 'volumeExists':
    case 'networkExists':
      needs('name');
      break;
    case 'httpResponds':
      needs('url');
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

function checkQuestion(q: unknown, where: string, p: Problems): void {
  if (!isObj(q)) return p.add(where, 'question must be an object');
  if (!isStr(q.prompt)) p.add(where, "missing 'prompt'");
  const opts = Array.isArray(q.options) ? q.options : null;
  const inRange = (i: unknown) => typeof i === 'number' && Number.isInteger(i) && !!opts && i >= 0 && i < opts.length;
  switch (q.kind) {
    case 'single':
      if (!opts || opts.length < 2 || !opts.every(isStr)) p.add(where, 'single needs at least 2 string options');
      if (!inRange(q.answer)) p.add(where, "single needs 'answer' = index of the correct option");
      break;
    case 'multi':
      if (!opts || opts.length < 2 || !opts.every(isStr)) p.add(where, 'multi needs at least 2 string options');
      if (!Array.isArray(q.answers) || !q.answers.length || !q.answers.every(inRange)) p.add(where, "multi needs 'answers' = indices of the correct options");
      else if (new Set(q.answers).size !== q.answers.length) p.add(where, 'multi answers must be unique');
      break;
    case 'number':
      if (typeof q.answer !== 'number' || !Number.isFinite(q.answer)) p.add(where, "number needs a numeric 'answer'");
      if (q.tolerance !== undefined && (typeof q.tolerance !== 'number' || q.tolerance < 0)) p.add(where, "'tolerance' must be a non-negative number");
      break;
    case 'order':
      if (!Array.isArray(q.items) || q.items.length < 2 || !q.items.every(isStr)) p.add(where, 'order needs at least 2 items (in the correct order)');
      else if (new Set(q.items).size !== q.items.length) p.add(where, 'order items must be unique');
      break;
    case 'text':
      if (!Array.isArray(q.accept) || !q.accept.length || !q.accept.every(isStr)) p.add(where, "text needs 'accept' (accepted answers)");
      else
        for (const a of q.accept as string[]) {
          const re = /^\/(.*)\/([a-z]*)$/.exec(a);
          if (re) {
            try {
              new RegExp(re[1], re[2]);
            } catch {
              p.add(where, `invalid regex '${a}'`);
            }
          }
        }
      break;
    default:
      p.add(where, `unknown question kind '${String(q.kind)}' (single, multi, number, order, text)`);
  }
}

function checkMission(m: unknown, where: string, p: Problems): void {
  if (!isObj(m)) return p.add(where, 'mission must be an object');
  for (const k of ['id', 'title', 'prompt']) if (!isStr(m[k])) p.add(where, `missing '${k}'`);
  if (!['guided', 'free', 'boss', 'quiz'].includes(String(m.type))) p.add(where, `type must be guided, free, boss or quiz`);
  if (m.type === 'quiz') {
    // Knowledge checks: questions instead of a machine, validator and solution.
    if (!Array.isArray(m.questions) || !m.questions.length) p.add(where, 'quiz needs questions');
    else m.questions.forEach((q, i) => checkQuestion(q, `${where}.questions[${i}]`, p));
    if (typeof m.xp !== 'number' || m.xp <= 0) p.add(where, "'xp' must be a positive number");
    for (const k of ['validator', 'solution', 'initialState']) if (k in m) p.add(where, `quiz missions don't take '${k}'`);
    if (Array.isArray(m.hints) && m.hints.length) p.add(where, 'quiz missions must not have hints');
    m.hints = [];
    m.validator = { checks: [] };
    m.solution = [];
    if (m.par === undefined && Array.isArray(m.questions)) m.par = m.questions.length;
    return;
  }
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
  if (data.sources !== undefined && (!Array.isArray(data.sources) || !data.sources.every(isStr))) p.add(source, "'sources' must be a list of note paths");
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
  const seen = new Set<string>();
  for (const l of lessons) {
    for (const pre of l.prerequisites) {
      if (!ids.has(pre)) problems.push(`${l.id}: unknown prerequisite '${pre}'`);
      else if (!seen.has(pre)) problems.push(`${l.id}: prerequisite '${pre}' must come earlier in the course`);
    }
    seen.add(l.id);
  }
  if (problems.length) throw new Error('Invalid lesson catalog:\n  ' + problems.join('\n  '));
}

