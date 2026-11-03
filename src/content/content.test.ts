import { describe, expect, it } from 'vitest';
import { MissionSession } from '../game/session';
import { brokenGuards, validate } from '../game/validators';
import { lessons, parseLesson } from './index';
import { assertCatalog } from './schema';

describe('lesson catalog', () => {
  it('loads the Linux lessons in skill-tree order', () => {
    expect(lessons.map((l) => l.branch)).toEqual(['linux-basics', 'files-permissions', 'processes', 'text-processing']);
    expect(lessons.flatMap((l) => l.missions)).toHaveLength(8);
  });

  it('has unique mission ids across lessons', () => {
    const ids = lessons.flatMap((l) => l.missions.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * Content QA: every mission must start unsolved, and its reference solution
 * must solve it without errors, without breaking guards and within par.
 */
describe.each(lessons.flatMap((l) => l.missions.map((m) => [`${l.id} / ${m.id}`, m] as const)))('mission %s', (_name, mission) => {
  it('starts unsolved with all guards intact', () => {
    const s = new MissionSession(mission);
    const ctx = { state: s.shell.state, outputs: [] };
    expect(validate(mission.validator, ctx).passed).toBe(false);
    expect(brokenGuards(mission.validator, ctx)).toEqual([]);
  });

  it('is solved by its reference solution', () => {
    const s = new MissionSession(mission);
    for (const line of mission.solution) {
      const { result } = s.run(line);
      const stderr = result.output.filter((c) => c.stream === 'stderr').map((c) => c.text).join('');
      expect(stderr, `stderr of '${line}'`).toBe('');
    }
    expect(s.status).toBe('passed');
    expect(s.stats.mistakes).toBe(0);
    expect(mission.solution.length).toBeLessThanOrEqual(mission.par);
  });
});

describe('schema validation', () => {
  const base = `
id: x
title: X
branch: linux-basics
prerequisites: []
theory: hi
missions:
  - id: m
    title: M
    type: guided
    prompt: do it
    hints: []
    xp: 10
    par: 1
    solution: [pwd]
    validator:
      checks:
        - type: cwd
          path: /tmp
`;

  it('accepts a minimal lesson', () => {
    expect(parseLesson(base, 'ok.yaml').missions[0].id).toBe('m');
  });

  it('reports every problem with its location', () => {
    const bad = base
      .replace('branch: linux-basics', 'branch: cooking')
      .replace('type: cwd', 'type: teleport')
      .replace('xp: 10', 'xp: -1');
    expect(() => parseLesson(bad, 'bad.yaml')).toThrowError(
      /bad.yaml: unknown branch 'cooking'[\s\S]*'xp' must be a positive number[\s\S]*unknown check type 'teleport'/,
    );
  });

  it('rejects hints on free missions and broken regexes', () => {
    const bad = base
      .replace('type: guided', 'type: free')
      .replace('hints: []', 'hints: [{text: a, cost: 1}]')
      .replace('type: cwd\n          path: /tmp', "type: fileContains\n          path: /x\n          regex: '('");
    expect(() => parseLesson(bad, 'b.yaml')).toThrowError(/free missions must not have hints[\s\S]*invalid regex/);
  });

  it('rejects unknown prerequisites', () => {
    const l = parseLesson(base.replace('prerequisites: []', 'prerequisites: [nope]'), 'p.yaml');
    expect(() => assertCatalog([l])).toThrowError(/unknown prerequisite 'nope'/);
  });
});
