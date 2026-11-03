/**
 * Knowledge checks: question grading and a QuizSession that behaves like a
 * MissionSession (status, stats, hints...) so XP, hearts, recall and dailies
 * work the same for theory and hands-on missions.
 */
import type { SessionStats } from './session';
import type { Hint, Mission, Question } from './types';

/** What the learner submitted: an option index, several indices, a number, an ordering or text. */
export type Response = number | number[] | string;

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
}

/** Parse "1,000", "43.2", "43 min" etc. */
export function parseNumber(s: string): number | null {
  const m = /^\s*(-?[\d,]*\.?\d+)/.exec(s.replace(/\s+/g, ' '));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Is `response` a correct answer to `q`? (For `order`, the response is item indices in the chosen order.) */
export function grade(q: Question, response: Response): boolean {
  switch (q.kind) {
    case 'single':
      return response === q.answer;
    case 'multi':
      return Array.isArray(response) && sameSet(response, q.answers);
    case 'number': {
      const n = typeof response === 'number' ? response : typeof response === 'string' ? parseNumber(response) : null;
      return n !== null && Math.abs(n - q.answer) <= (q.tolerance ?? 0);
    }
    case 'order':
      return Array.isArray(response) && response.length === q.items.length && response.every((v, i) => v === i);
    case 'text': {
      if (typeof response !== 'string') return false;
      return q.accept.some((a) => {
        const re = /^\/(.*)\/([a-z]*)$/.exec(a);
        if (re) return new RegExp(re[1], re[2].includes('i') ? re[2] : re[2] + 'i').test(response.trim());
        return normalize(a) === normalize(response);
      });
    }
  }
}

/** The correct answer, phrased for display after a wrong attempt. */
export function correctAnswerText(q: Question): string {
  switch (q.kind) {
    case 'single':
      return q.options[q.answer];
    case 'multi':
      return q.answers.map((i) => q.options[i]).join(' · ');
    case 'number':
      return `${q.answer}${q.unit ? ' ' + q.unit : ''}`;
    case 'order':
      return q.items.map((x, i) => `${i + 1}. ${x}`).join('  ');
    case 'text':
      return q.accept.find((a) => !a.startsWith('/')) ?? q.accept[0].replace(/^\/|\/[a-z]*$/g, '');
  }
}

/** Deterministic shuffle (so an attempt is stable across re-renders). */
export function shuffled<T>(items: T[], seed: number): { item: T; index: number }[] {
  let a = (seed * 2654435761) >>> 0 || 1;
  const rand = () => {
    a ^= a << 13;
    a ^= a >>> 17;
    a ^= a << 5;
    return (a >>> 0) / 4294967296;
  };
  const out = items.map((item, index) => ({ item, index }));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface AnswerResult {
  correct: boolean;
  /** Shown after answering (always for wrong answers). */
  explain?: string;
  correctAnswer: string;
}

/**
 * One attempt at a quiz mission. Questions are asked in order; a wrong answer
 * costs a heart (handled by the caller) and the question comes back at the end,
 * so the mission is passed once every question has been answered correctly.
 */
export class QuizSession {
  status: 'active' | 'passed' | 'failed' = 'active';
  /** Queue of question indices still to answer correctly. */
  private queue: number[];
  /** Answer submissions so far. */
  submissions = 0;
  wrong = 0;
  /** Has the current question been answered (waiting for "Continue")? */
  answered: AnswerResult | null = null;
  readonly questions: Question[];

  constructor(
    readonly mission: Mission,
    readonly seed = 1,
  ) {
    this.questions = mission.questions ?? [];
    this.queue = this.questions.map((_, i) => i);
  }

  get current(): Question | null {
    return this.status === 'active' || this.answered ? this.questions[this.queue[0]] ?? null : null;
  }

  get currentIndex(): number {
    return this.queue[0] ?? -1;
  }

  /** Correctly answered so far. */
  get solved(): number {
    return this.questions.length - this.queue.length + (this.answered?.correct ? 1 : 0);
  }

  answer(response: Response): AnswerResult {
    if (this.status !== 'active' || this.answered) throw new Error('not expecting an answer now');
    const q = this.questions[this.queue[0]];
    const correct = grade(q, response);
    this.submissions++;
    if (!correct) this.wrong++;
    this.answered = { correct, explain: q.explain, correctAnswer: correctAnswerText(q) };
    return this.answered;
  }

  /** Move on after an answer. Returns true when the quiz is complete. */
  next(): boolean {
    if (!this.answered) return false;
    const idx = this.queue.shift()!;
    if (!this.answered.correct) this.queue.push(idx);
    this.answered = null;
    if (!this.queue.length && this.status === 'active') this.status = 'passed';
    return this.status === 'passed';
  }

  fail(): void {
    if (this.status === 'active') this.status = 'failed';
  }

  // ---- MissionSession-compatible surface (used by the mission pane)
  readonly revealedHints: Hint[] = [];
  readonly hasMoreHints = false;
  revealHint(): undefined {
    return undefined;
  }

  get stats(): SessionStats {
    return {
      commands: this.submissions,
      par: this.questions.length,
      hintsUsed: 0,
      hintXpCost: 0,
      failedChecks: this.wrong,
      mistakes: 0,
    };
  }
}
