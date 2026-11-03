import { useEffect, useRef, useState } from 'react';
import type { MissionSession } from '../../game/session';
import type { Lesson } from '../../game/types';
import type { CheckResult } from '../../game/validators';
import { Markdown } from '../Markdown';

interface Props {
  lesson: Lesson;
  missionIndex: number;
  session: MissionSession;
  /** Results of the last explicit "Check" press, if it failed. */
  feedback: CheckResult[] | null;
  mistakes: string[];
  onCheck: () => void;
  onHint: () => void;
  onReset: () => void;
  onNext: (() => void) | null;
}

const TYPE_LABEL = { guided: 'Guided', free: 'Free — no hints', boss: 'Boss fight' } as const;

export function MissionPane({ lesson, missionIndex, session, feedback, mistakes, onCheck, onHint, onReset, onNext }: Props) {
  const mission = session.mission;
  const [theoryOpen, setTheoryOpen] = useState(missionIndex === 0);
  const passed = session.status === 'passed';
  const stats = session.stats;
  const hints = session.revealedHints;
  const successRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (passed) successRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [passed]);

  return (
    <div className="mission-pane">
      <div className="lesson-head">
        <span className="branch">{lesson.branch.replace(/-/g, ' ')}</span>
        <h1>{lesson.title}</h1>
      </div>

      <details className="theory" open={theoryOpen} onToggle={(e) => setTheoryOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Theory</summary>
        <Markdown text={lesson.theory} />
      </details>

      <section className="mission">
        <div className="mission-meta">
          <span>
            Mission {missionIndex + 1}/{lesson.missions.length}
          </span>
          <span className={`badge ${mission.type}`}>{TYPE_LABEL[mission.type]}</span>
          <span className="badge xp">{mission.xp} XP</span>
          <span className="badge" title="Expected number of commands">par {mission.par}</span>
        </div>
        <h2>{mission.title}</h2>
        <Markdown text={mission.prompt} />

        {hints.length > 0 && (
          <ol className="hints">
            {hints.map((h, i) => (
              <li key={i}>
                <Markdown text={h.text} />
              </li>
            ))}
          </ol>
        )}

        {mistakes.length > 0 && (
          <div className="notice warn" role="alert">
            {mistakes.map((m, i) => (
              <Markdown key={i} text={'⚠ ' + m} />
            ))}
            {!passed && <p className="stats">This can't be undone here: press Reset to restore the starting machine.</p>}
          </div>
        )}

        {!passed && feedback && (
          <div className="notice error" role="status">
            <strong>Not yet:</strong>
            <ul>
              {feedback.map((r, i) => (
                <li key={i} className={r.passed ? 'ok' : 'todo'}>
                  <Markdown text={(r.passed ? '✓ ' : '✗ ') + r.message} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {passed ? (
          <div className="notice success" role="status" ref={successRef}>
            <h3>✔ Mission complete</h3>
            <p className="stats">
              {stats.commands} command{stats.commands === 1 ? '' : 's'} (par {stats.par}) · {stats.hintsUsed} hint
              {stats.hintsUsed === 1 ? '' : 's'} · {stats.failedChecks + stats.mistakes} mistake
              {stats.failedChecks + stats.mistakes === 1 ? '' : 's'}
            </p>
            {mission.explain && <Markdown text={mission.explain} />}
            <div className="actions">
              {onNext && (
                <button className="primary" onClick={onNext}>
                  Next mission →
                </button>
              )}
              <button onClick={onReset}>Replay</button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button className="primary" onClick={onCheck}>
              Check
            </button>
            {session.hasMoreHints && (
              <button onClick={onHint}>
                Hint ({hints.length + 1}/{mission.hints.length}, −{mission.hints[hints.length].cost} XP)
              </button>
            )}
            <button onClick={onReset} title="Restore the starting machine">
              Reset
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
