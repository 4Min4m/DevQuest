import { useEffect, useRef, useState } from 'react';
import type { BadgeDef } from '../../game/badges';
import { MAX_HEARTS } from '../../game/progress';
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
  reward: RewardView | null;
  /** Recall challenges hide hints and the theory. */
  mode: 'lesson' | 'review';
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

/** Display model for any reward (lesson completion or recall challenge). */
export interface RewardView {
  total: number;
  lines: [string, string][];
  levelUp?: number;
  streak?: number;
  badges: BadgeDef[];
  note?: string;
}

function RewardPanel({ reward }: { reward: RewardView }) {
  return (
    <div className="reward">
      <div className="reward-total">
        +{reward.total} XP
        {reward.levelUp && <span className="level-up">Level up! → {reward.levelUp}</span>}
      </div>
      <ul className="reward-lines">
        {reward.lines.map(([label, value]) => (
          <li key={label} className={label.startsWith('Previous best') ? 'muted' : ''}>
            <span>{label}</span>
            <span>{value}</span>
          </li>
        ))}
      </ul>
      {reward.badges.length > 0 && (
        <div className="new-badges">
          {reward.badges.map((b) => (
            <div key={b.id} className="new-badge" title={b.description}>
              <span className="badge-icon" aria-hidden>
                {b.icon}
              </span>
              <span>
                <strong>Badge unlocked: {b.title}</strong>
                <br />
                <span className="muted">{b.description}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {reward.note && <p className="stats">{reward.note}</p>}
      {!!reward.streak && <p className="stats">🔥 {reward.streak}-day streak</p>}
    </div>
  );
}

export function MissionPane(props: Props) {
  const { lesson, missionIndex, session, hearts, reward, feedback, mistakes, onCheck, onHint, onReset, onRetry, onNext, nextLabel, mode } = props;
  const mission = session.mission;
  const review = mode === 'review';
  const [theoryOpen, setTheoryOpen] = useState(missionIndex === 0 && !review);
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
          {review ? (
            <span className="badge review">🔄 Recall challenge</span>
          ) : (
            <span>
              Mission {missionIndex + 1}/{lesson.missions.length}
            </span>
          )}
          <span className={`badge ${mission.type}`}>{TYPE_LABEL[mission.type]}</span>
          <span className="badge xp">{mission.xp} XP</span>
          <span className="badge" title="Expected number of commands — meet it for a bonus">
            par {mission.par}
          </span>
          <Hearts count={hearts} />
        </div>
        <h2>{mission.title}</h2>
        {review && <p className="stats">You solved this before. No hints this time: can you still do it?</p>}
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
            {session.hasMoreHints && !review && (
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
