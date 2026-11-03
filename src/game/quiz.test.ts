import { describe, expect, it } from 'vitest';
import { parseLesson } from '../content';
import { correctAnswerText, grade, parseNumber, QuizSession, shuffled } from './quiz';
import type { Mission, Question } from './types';

const single: Question = { kind: 'single', prompt: 'p', options: ['a', 'b', 'c'], answer: 1 };
const multi: Question = { kind: 'multi', prompt: 'p', options: ['a', 'b', 'c', 'd'], answers: [0, 2] };
const num: Question = { kind: 'number', prompt: 'p', answer: 43.2, tolerance: 0.5, unit: 'min' };
const order: Question = { kind: 'order', prompt: 'p', items: ['x', 'y', 'z'] };
const text: Question = { kind: 'text', prompt: 'p', accept: ['durability', '/^api\\.prod(uction)?$/'] };

describe('grading', () => {
  it('single and multi choice', () => {
    expect(grade(single, 1)).toBe(true);
    expect(grade(single, 0)).toBe(false);
    expect(grade(multi, [2, 0])).toBe(true); // order doesn't matter
    expect(grade(multi, [0])).toBe(false);
    expect(grade(multi, [0, 2, 3])).toBe(false);
  });
  it('numbers accept tolerance, commas and units', () => {
    expect(grade(num, '43')).toBe(true);
    expect(grade(num, '43.6 min')).toBe(true);
    expect(grade(num, '44')).toBe(false);
    expect(grade({ kind: 'number', prompt: 'p', answer: 1000 }, '1,000')).toBe(true);
    expect(grade(num, 'about forty')).toBe(false);
    expect(parseNumber(' 1,728 RPS')).toBe(1728);
    expect(parseNumber('abc')).toBeNull();
  });
  it('ordering and free text', () => {
    expect(grade(order, [0, 1, 2])).toBe(true);
    expect(grade(order, [1, 0, 2])).toBe(false);
    expect(grade(text, '  Durability ')).toBe(true);
    expect(grade(text, 'API.production')).toBe(true); // regexes are case-insensitive
    expect(grade(text, 'availability')).toBe(false);
  });
  it('describes the correct answer', () => {
    expect(correctAnswerText(single)).toBe('b');
    expect(correctAnswerText(multi)).toBe('a · c');
    expect(correctAnswerText(num)).toBe('43.2 min');
    expect(correctAnswerText(order)).toBe('1. x  2. y  3. z');
    expect(correctAnswerText(text)).toBe('durability');
  });
  it('shuffles deterministically and keeps original indices', () => {
    const a = shuffled(['a', 'b', 'c', 'd'], 3);
    expect(a).toEqual(shuffled(['a', 'b', 'c', 'd'], 3));
    expect(a.map((x) => x.index).sort()).toEqual([0, 1, 2, 3]);
    expect(a.every((x) => ['a', 'b', 'c', 'd'][x.index] === x.item)).toBe(true);
  });
});

const quiz: Mission = {
  id: 'q',
  title: 'Q',
  type: 'quiz',
  prompt: 'p',
  hints: [],
  validator: { checks: [] },
  solution: [],
  xp: 20,
  par: 2,
  questions: [single, num],
};

describe('QuizSession', () => {
  it('a wrong answer comes back at the end; the quiz passes when all are right', () => {
    const s = new QuizSession(quiz);
    expect(s.current).toBe(single);
    expect(s.answer(0)).toEqual({ correct: false, explain: undefined, correctAnswer: 'b' });
    expect(() => s.answer(1)).toThrow(); // must continue first
    expect(s.next()).toBe(false);
    expect(s.current).toBe(num);
    s.answer('43.2');
    expect(s.solved).toBe(1);
    s.next();
    expect(s.current).toBe(single); // requeued
    s.answer(1);
    expect(s.next()).toBe(true);
    expect(s.status).toBe('passed');
    expect(s.current).toBeNull();
    expect(s.stats).toEqual({ commands: 3, par: 2, hintsUsed: 0, hintXpCost: 0, failedChecks: 1, mistakes: 0 });
  });

  it('fail() ends the attempt', () => {
    const s = new QuizSession(quiz);
    s.fail();
    expect(s.status).toBe('failed');
    expect(s.current).toBeNull();
    expect(() => s.answer(1)).toThrow();
    expect(s.hasMoreHints).toBe(false);
  });
});

describe('quiz schema', () => {
  const lesson = (questions: string) => `
id: t
title: T
branch: foundations
prerequisites: []
theory: x
missions:
  - id: m
    title: M
    type: quiz
    prompt: p
    xp: 10
    questions:
${questions}
`;

  it('fills defaults for quiz missions', () => {
    const l = parseLesson(lesson('      - {kind: single, prompt: p, options: [a, b], answer: 1}\n      - {kind: text, prompt: p, accept: [x]}'), 't.yaml');
    expect(l.missions[0]).toMatchObject({ hints: [], solution: [], validator: { checks: [] }, par: 2 });
  });

  it('reports broken questions', () => {
    const bad = lesson(
      [
        '      - {kind: single, prompt: p, options: [a, b], answer: 5}',
        '      - {kind: multi, prompt: p, options: [a, b], answers: []}',
        '      - {kind: order, prompt: p, items: [a, a]}',
        "      - {kind: text, prompt: p, accept: ['/(/']}",
        '      - {kind: essay, prompt: p}',
      ].join('\n'),
    );
    expect(() => parseLesson(bad, 'b.yaml')).toThrowError(
      /answer' = index[\s\S]*indices of the correct options[\s\S]*order items must be unique[\s\S]*invalid regex[\s\S]*unknown question kind 'essay'/,
    );
  });

  it('rejects terminal-only fields on quizzes', () => {
    const bad = lesson('      - {kind: single, prompt: p, options: [a, b], answer: 1}').replace('    xp: 10', '    xp: 10\n    solution: [ls]');
    expect(() => parseLesson(bad, 'c.yaml')).toThrowError(/quiz missions don't take 'solution'/);
  });
});
