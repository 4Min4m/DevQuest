import { useEffect, useRef, useState } from 'react';
import { MAX_HEARTS, Reward } from '../../game/progress';
import type { MissionSession } from '../../game/session';
import type { Lesson } from '../../game/types';
import type { CheckResult } from '../../game/validators';
import { Markdown } from '../Markdown';

interface Props {
  lesson: Lesson;
  missionIndex: number;
  session: MissionSession;
  hearts: number;
  /** Set once the mission has been completed and scored. */
  reward: Reward | null;
  /** Results of the last explicit "Check" press, if it failed. */
  feedback: CheckResult[] | null;
  mistakes: string[];
  onCheck: () => void;
  onHint: () => void;
  onReset: () => void;
  /** Out of hearts: refill and start the mission again. */
  onRetry: () => void;
  onNext: (() => void) | null;
  nextLabel: string;
}

const TYPE_LABEL = { guided: 'Guided', free: 'Free — no hints', boss: 'Boss fight' } as const;

export function Hearts({ count }: { count: number }) {
  return (
    <span className="hearts" aria-label={`${count} of ${MAX_HEARTS} hearts left`} title="Hearts: wrong checks and destructive mistakes cost one">
      {Array.from({ length: MAX_HEARTS }, (_, i) => (
        <span key={i} className={i < count ? 'heart full' : 'heart empty'} aria-hidden>
          {i < count ? '♥' : '♡'}
        </span>
      ))}
    </span>
  );
}

function RewardPanel({ reward }: { reward: Reward }) {
  const b = reward.breakdown;
  return (
    <div className="reward">
      <div className="reward-total">
        +{reward.awarded} XP
        {reward.levelAfter > reward.levelBefore && <span className="level-up">Level up! → {reward.levelAfter}</span>}
      </div>
      <ul className="reward-lines">
        <li>
          <span>Mission</span>
          <span>{b.base}</span>
        </li>
        {b.hintCost > 0 && (
          <li>
            <span>Hints used</span>
            <span>−{b.hintCost}</span>
          </li>
        )}
        {b.noHintBonus > 0 && (
          <li>
            <span>No-hint bonus</span>
            <span>+{b.noHintBonus}</span>
          </li>
        )}
        {b.parBonus > 0 && (
          <li>
            <span>On-par bonus</span>
            <span>+{b.parBonus}</span>
          </li>
        )}
        {reward.previousBest > 0 && (
          <li className="muted">
            <span>Previous best (already earned)</span>
            <span>−{Math.min(reward.previousBest, b.total)}</span>
          </li>
        )}
      </ul>
      {reward.streak > 0 && <p className="stats">🔥 {reward.streak}-day streak</p>}
    </div>
  );
}

export function MissionPane(props: Props) {
  const { lesson, missionIndex, session, hearts, reward, feedback, mistakes, onCheck, onHint, onReset, onRetry, onNext, nextLabel } = props;
  const mission = session.mission;
  const [theoryOpen, setTheoryOpen] = useState(missionIndex === 0);
  const passed = session.status === 'passed';
  const failed = session.status === 'failed';
  const stats = session.stats;
  const hints = session.revealedHints;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (passed || failed) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [passed, failed]);

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
          <span className="badge" title="Expected number of commands — meet it for a bonus">
            par {mission.par}
          </span>
          <Hearts count={hearts} />
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

        {mistakes.length > 0 && !failed && (
          <div className="notice warn" role="alert">
            {mistakes.map((m, i) => (
              <Markdown key={i} text={'⚠ ' + m + ' (−1 ♥)'} />
            ))}
            {!passed && <p className="stats">This can't be undone here: press Reset to restore the starting machine.</p>}
          </div>
        )}

        {!passed && !failed && feedback && (
          <div className="notice error" role="status">
            <strong>Not yet (−1 ♥):</strong>
            <ul>
              {feedback.map((r, i) => (
                <li key={i} className={r.passed ? 'ok' : 'todo'}>
                  <Markdown text={(r.passed ? '✓ ' : '✗ ') + r.message} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {failed && (
          <div className="notice error" role="alert" ref={endRef}>
            <h3>💔 Out of hearts</h3>
            <p>Wrong checks and destructive mistakes cost a heart. Take another look at the theory and try again — your hearts are refilled.</p>
            <div className="actions">
              <button className="primary" onClick={onRetry}>
                Retry mission
              </button>
            </div>
          </div>
        )}

        {passed && (
          <div className="notice success" role="status" ref={endRef}>
            <h3>✔ Mission complete</h3>
            {reward && <RewardPanel reward={reward} />}
            <p className="stats">
              {stats.commands} command{stats.commands === 1 ? '' : 's'} (par {stats.par}) · {stats.hintsUsed} hint
              {stats.hintsUsed === 1 ? '' : 's'} · {stats.failedChecks + stats.mistakes} mistake
              {stats.failedChecks + stats.mistakes === 1 ? '' : 's'}
            </p>
            {mission.explain && <Markdown text={mission.explain} />}
            <div className="actions">
              {onNext && (
                <button className="primary" onClick={onNext}>
                  {nextLabel}
                </button>
              )}
              <button onClick={onReset}>Replay</button>
            </div>
          </div>
        )}

        {!passed && !failed && (
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
