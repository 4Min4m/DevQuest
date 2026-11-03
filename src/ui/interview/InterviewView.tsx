import { useCallback, useEffect, useMemo, useState } from 'react';
import { lessons } from '../../content';
import type { BadgeDef } from '../../game/badges';
import {
  formatClock,
  INTERVIEW_QUESTIONS,
  INTERVIEW_TIME_MS,
  interviewPool,
  InterviewResult,
  pickInterview,
  scoreInterview,
} from '../../game/interview';
import { MissionSession } from '../../game/session';
import type { Mission } from '../../game/types';
import { Markdown } from '../Markdown';
import { navigate } from '../router';
import { actions, useProgress } from '../state';
import { TerminalPane } from '../terminal/TerminalPane';

type Phase = { kind: 'intro' } | { kind: 'running'; questions: Mission[]; index: number; solved: boolean[]; startedAt: number } | { kind: 'done'; result: InterviewResult; badges: BadgeDef[] };

export function InterviewView() {
  const progress = useProgress();
  const pool = interviewPool(progress, lessons);
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' });

  const start = () =>
    setPhase({ kind: 'running', questions: pickInterview(pool, INTERVIEW_QUESTIONS, Date.now()), index: 0, solved: [], startedAt: Date.now() });

  const finish = useCallback((solved: boolean[], total: number, startedAt: number) => {
    const result = scoreInterview(solved.filter(Boolean).length, total, Date.now() - startedAt);
    const badges = actions().recordInterview(result);
    setPhase({ kind: 'done', result, badges });
  }, []);

  if (phase.kind === 'intro') {
    return (
      <div className="interview-intro">
        <h1>🎤 Interview Mode</h1>
        <p>
          You'll get <strong>{INTERVIEW_QUESTIONS} random missions</strong> you have already completed, with{' '}
          <strong>{formatClock(INTERVIEW_TIME_MS)} minutes</strong> on the clock. No hints, no theory; just you and the terminal, like a
          practical interview.
        </p>
        <ul>
          <li>Each solved question earns XP; solving all of them in time is a pass (+bonus).</li>
          <li>You can skip a question, but it counts as unsolved.</li>
          <li>Wrong checks don't cost hearts here, but the clock keeps running.</li>
        </ul>
        {progress.interviews.attempts > 0 && (
          <p className="muted">
            Your record: {progress.interviews.passed}/{progress.interviews.attempts} passed
            {progress.interviews.bestMs !== null && `, best time ${formatClock(progress.interviews.bestMs)}`}.
          </p>
        )}
        <div className="actions">
          <button className="primary" disabled={pool.length < INTERVIEW_QUESTIONS} onClick={start}>
            {pool.length < INTERVIEW_QUESTIONS ? `Complete ${INTERVIEW_QUESTIONS} missions first` : 'Start the clock'}
          </button>
          <button onClick={() => navigate({ view: 'tree' })}>Back</button>
        </div>
      </div>
    );
  }

  if (phase.kind === 'done') {
    const r = phase.result;
    return (
      <div className="interview-intro">
        <h1>{r.passed ? '🎉 You passed!' : '📋 Interview over'}</h1>
        <p>
          Solved <strong>{r.solved}/{r.total}</strong> in <strong>{formatClock(r.elapsedMs)}</strong>
          {!r.passed && r.elapsedMs > INTERVIEW_TIME_MS && ' (over time)'}.
        </p>
        <p className="reward-total">+{r.xp} XP</p>
        {phase.badges.map((b) => (
          <p key={b.id}>
            {b.icon} <strong>Badge unlocked: {b.title}</strong>
          </p>
        ))}
        <div className="actions">
          <button className="primary" onClick={() => setPhase({ kind: 'intro' })}>
            Try another
          </button>
          <button onClick={() => navigate({ view: 'tree' })}>Back to the skill tree</button>
        </div>
      </div>
    );
  }

  return (
    <Question
      key={phase.index}
      mission={phase.questions[phase.index]}
      number={phase.index + 1}
      total={phase.questions.length}
      startedAt={phase.startedAt}
      onDone={(ok) => {
        const solved = [...phase.solved, ok];
        if (phase.index + 1 >= phase.questions.length) finish(solved, phase.questions.length, phase.startedAt);
        else setPhase({ ...phase, index: phase.index + 1, solved });
      }}
      onTimeout={() => finish(phase.solved, phase.questions.length, phase.startedAt)}
    />
  );
}

function Question(props: { mission: Mission; number: number; total: number; startedAt: number; onDone: (solved: boolean) => void; onTimeout: () => void }) {
  const { mission, number, total, startedAt, onDone, onTimeout } = props;
  const session = useMemo(() => new MissionSession(mission), [mission]);
  const [now, setNow] = useState(Date.now());
  const [feedback, setFeedback] = useState<string | null>(null);
  const [solved, setSolved] = useState(false);
  const left = INTERVIEW_TIME_MS - (now - startedAt);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left <= 0) onTimeout();
  }, [left, onTimeout]);

  return (
    <div className="workspace interview">
      <div className="mission-pane">
        <div className="interview-bar">
          <span>
            Question {number}/{total}
          </span>
          <span className={`clock${left < 60_000 ? ' urgent' : ''}`} aria-live="polite">
            ⏱ {formatClock(left)}
          </span>
        </div>
        <h2>{mission.title}</h2>
        <Markdown text={mission.prompt} />
        {feedback && <div className="notice error">{feedback}</div>}
        {solved ? (
          <div className="notice success">
            <h3>✔ Solved</h3>
            <div className="actions">
              <button className="primary" onClick={() => onDone(true)}>
                {number < total ? 'Next question →' : 'Finish interview'}
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button
              className="primary"
              onClick={() => {
                const v = session.check();
                if (v.passed) setSolved(true);
                else setFeedback(`Not yet: ${v.results.filter((r) => !r.passed).length} requirement(s) unmet.`);
              }}
            >
              Check
            </button>
            <button onClick={() => onDone(false)}>Skip</button>
          </div>
        )}
      </div>
      <main className="terminal-area">
        <TerminalPane
          shell={session.shell}
          banner={`\x1b[1;35m🎤 Interview\x1b[0m — question ${number}/${total}: \x1b[1m${mission.title}\x1b[0m\n\n`}
          execute={(line) => {
            const { result, events } = session.run(line);
            if (events.some((e) => e.type === 'passed')) setSolved(true);
            return result;
          }}
          onCommand={() => (session.status === 'passed' ? '\n\x1b[1;32m✔ Solved!\x1b[0m\n\n' : undefined)}
          onFileSaved={() => {
            if (session.reevaluate().some((e) => e.type === 'passed')) setSolved(true);
          }}
        />
      </main>
    </div>
  );
}
