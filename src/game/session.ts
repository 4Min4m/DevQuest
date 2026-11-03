import { createShell } from '../sim';
import type { Shell } from '../sim/shell/shell';
import type { RunResult } from '../sim/shell/types';
import { buildInitialState } from './initialState';
import type { Hint, Mission } from './types';
import { brokenGuards, CheckResult, validate, ValidationContext, ValidationResult } from './validators';

export type SessionEvent =
  | { type: 'passed' }
  | { type: 'guardBroken'; result: CheckResult };

export interface SessionStats {
  commands: number;
  par: number;
  hintsUsed: number;
  hintXpCost: number;
  /** Manual "Check" presses that failed. */
  failedChecks: number;
  /** Guards broken (destructive mistakes). */
  mistakes: number;
}

/**
 * One attempt at one mission: owns the simulated machine, counts commands,
 * hints and mistakes, and validates the result. Scoring (XP, hearts) builds on
 * the stats exposed here.
 */
export class MissionSession {
  readonly shell: Shell;
  status: 'active' | 'passed' | 'failed' = 'active';
  hintsRevealed = 0;
  failedChecks = 0;
  commands = 0;
  readonly brokenGuardList: CheckResult[] = [];
  lastValidation: ValidationResult | null = null;
  private readonly outputs: string[] = [];
  private readonly brokenGuardIdx = new Set<string>();

  constructor(readonly mission: Mission) {
    this.shell = createShell(buildInitialState(mission.initialState));
  }

  private ctx(): ValidationContext {
    return { state: this.shell.state, outputs: this.outputs };
  }

  /** Run a command line in the mission's machine and re-evaluate the mission. */
  run(line: string): { result: RunResult; events: SessionEvent[] } {
    const result = this.shell.run(line);
    const events: SessionEvent[] = [];
    if (!line.trim()) return { result, events };
    this.outputs.push(result.output.filter((c) => c.stream === 'stdout').map((c) => c.text).join(''));
    if (this.status !== 'active') return { result, events };
    this.commands++;
    return { result, events: this.evaluate() };
  }

  /** Re-check the mission without a command (e.g. after saving a file in the editor). */
  reevaluate(): SessionEvent[] {
    return this.status === 'active' ? this.evaluate() : [];
  }

  private evaluate(): SessionEvent[] {
    const events: SessionEvent[] = [];
    const broken = brokenGuards(this.mission.validator, this.ctx());
    for (const g of broken) {
      const key = JSON.stringify(g.check);
      if (this.brokenGuardIdx.has(key)) continue;
      this.brokenGuardIdx.add(key);
      this.brokenGuardList.push(g);
      events.push({ type: 'guardBroken', result: g });
    }
    // A broken guard (e.g. the web server you were told to keep) blocks success until reset.
    const v = validate(this.mission.validator, this.ctx());
    if (v.passed && broken.length === 0) {
      this.status = 'passed';
      this.lastValidation = v;
      events.push({ type: 'passed' });
    }
    return events;
  }

  /** Explicit "Check" button: a failed check counts as a mistake. Broken guards are reported too. */
  check(): ValidationResult {
    const base = validate(this.mission.validator, this.ctx());
    const broken = brokenGuards(this.mission.validator, this.ctx());
    const v: ValidationResult = { passed: base.passed && broken.length === 0, results: [...base.results, ...broken] };
    if (this.status !== 'active') return v; // finished attempts don't change any more
    this.lastValidation = v;
    if (v.passed) this.status = 'passed';
    else this.failedChecks++;
    return v;
  }

  /** End the attempt without success (e.g. out of hearts). */
  fail(): void {
    if (this.status === 'active') this.status = 'failed';
  }

  get revealedHints(): Hint[] {
    return this.mission.hints.slice(0, this.hintsRevealed);
  }

  get hasMoreHints(): boolean {
    return this.status === 'active' && this.hintsRevealed < this.mission.hints.length;
  }

  revealHint(): Hint | undefined {
    if (!this.hasMoreHints) return undefined;
    return this.mission.hints[this.hintsRevealed++];
  }

  get stats(): SessionStats {
    return {
      commands: this.commands,
      par: this.mission.par,
      hintsUsed: this.hintsRevealed,
      hintXpCost: this.revealedHints.reduce((s, h) => s + h.cost, 0),
      failedChecks: this.failedChecks,
      mistakes: this.brokenGuardList.length,
    };
  }
}
