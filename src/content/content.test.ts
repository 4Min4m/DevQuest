import { describe, expect, it } from 'vitest';
import { correctAnswerText, grade, QuizSession, Response } from '../game/quiz';
import { MissionSession } from '../game/session';
import type { Question } from '../game/types';
import { brokenGuards, validate } from '../game/validators';
import { lessons, parseLesson } from './index';
import { assertCatalog } from './schema';

describe('lesson catalog', () => {
  it('loads the hands-on and theory lessons', () => {
    expect(lessons.map((l) => l.branch)).toEqual([
      'linux-basics', 'files-permissions', 'processes', 'text-processing',
      'docker-basics', 'images-dockerfile', 'volumes-networks', 'compose', 'troubleshooting',
      'foundations', 'networking', 'storage-databases', 'system-design', 'sre',
      'systemd', 'network-tools', 'performance',
      'version-control', 'git-branching', 'git-remotes',
      'kubernetes', 'k8s-networking', 'k8s-troubleshooting',
      'k8s-storage', 'k8s-scheduling', 'k8s-traffic', 'k8s-rbac-helm',
      'cicd', 'cicd-gitlab', 'deploy-strategies', 'gitops',
    ]);
    const missions = lessons.flatMap((l) => l.missions);
    expect(missions.filter((m) => m.type === 'guided' || m.type === 'free')).toHaveLength(73); // 8 Linux + 8 Docker + 7 services/network/performance + 13 Git + 25 Kubernetes + 12 CI/CD
    expect(missions.filter((m) => m.type === 'boss')).toHaveLength(21);
    expect(missions.filter((m) => m.type === 'quiz').length).toBeGreaterThanOrEqual(20);
  });

  it('hands-on lessons build on earlier ones; theory lessons are open from the start', () => {
    const handsOn = lessons.filter((l) => l.missions.some((m) => m.type !== 'quiz'));
    handsOn.slice(1).forEach((l, i) => {
      const earlier = handsOn.slice(0, i + 1).map((x) => x.id);
      expect(l.prerequisites.length, l.id).toBe(1);
      expect(earlier, l.id).toContain(l.prerequisites[0]);
    });
    for (const l of lessons.filter((x) => x.missions.every((m) => m.type === 'quiz'))) {
      expect(l.prerequisites).toEqual([]);
      expect(l.sources?.length).toBeGreaterThan(0);
    }
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
const terminalMissions = lessons.flatMap((l) => l.missions.filter((m) => m.type !== 'quiz').map((m) => [`${l.id} / ${m.id}`, m] as const));
const quizMissions = lessons.flatMap((l) => l.missions.filter((m) => m.type === 'quiz').map((m) => [`${l.id} / ${m.id}`, m] as const));

/** The correct response for a question, in the shape the UI submits. */
function rightAnswer(q: Question): Response {
  switch (q.kind) {
    case 'single':
      return q.answer;
    case 'multi':
      return [...q.answers];
    case 'number':
      return String(q.answer);
    case 'order':
      return q.items.map((_, i) => i);
    case 'text':
      return correctAnswerText(q);
  }
}

/** A plausible wrong response. */
function wrongAnswer(q: Question): Response {
  switch (q.kind) {
    case 'single':
      return (q.answer + 1) % q.options.length;
    case 'multi':
      return q.answers.length > 1 ? q.answers.slice(1) : [...q.answers, (q.answers[0] + 1) % q.options.length];
    case 'number':
      return String(q.answer + (q.tolerance ?? 0) + Math.max(1, Math.abs(q.answer) * 0.5));
    case 'order':
      return q.items.map((_, i) => i).reverse();
    case 'text':
      return 'definitely not the answer';
  }
}

/** Knowledge-check QA: every question is gradable, answers are unambiguous, and a clean run passes. */
describe.each(quizMissions)('knowledge check %s', (_name, mission) => {
  it('accepts the right answers and rejects wrong ones', () => {
    for (const q of mission.questions!) {
      expect(grade(q, rightAnswer(q)), q.prompt).toBe(true);
      expect(grade(q, wrongAnswer(q)), q.prompt).toBe(false);
      if (q.kind === 'single' || q.kind === 'multi') expect(new Set(q.options).size, `duplicate options: ${q.prompt}`).toBe(q.options.length);
    }
  });

  it('a perfect run passes with no mistakes, at par', () => {
    const s = new QuizSession(mission);
    for (const q of mission.questions!) {
      expect(s.answer(rightAnswer(q)).correct).toBe(true);
      s.next();
    }
    expect(s.status).toBe('passed');
    expect(s.stats).toMatchObject({ commands: mission.questions!.length, par: mission.par, failedChecks: 0 });
  });
});

describe.each(terminalMissions)('mission %s', (_name, mission) => {
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
      expect(result.exitCode, `exit code of '${line}'`).toBe(0);
      // Progress notes are fine, `docker logs` replays the container's own stderr, and
      // `cmd || true` marks a step that is expected to fail (e.g. a merge that stops on a conflict).
      // `kubectl drain` prints a real "Warning: ignoring DaemonSet-managed Pods" line on stderr.
      // Jest (npm test) reports on stderr, like the real one.
      if (/^docker( compose)? logs\b/.test(line) || /^kubectl drain\b/.test(line) || /^npm (test|t|run test)\b/.test(line) || /\|\| true$/.test(line)) continue;
      const stderr = result.output.filter((c) => c.stream === 'stderr' && !c.note).map((c) => c.text).join('');
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
