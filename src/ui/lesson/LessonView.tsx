import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { lessons } from '../../content';
import { heartsLeft, isLessonComplete, isMissionDone, isMissionUnlocked, levelInfo, MAX_HEARTS } from '../../game/progress';
import { QuizSession } from '../../game/quiz';
import { MissionSession, SessionEvent } from '../../game/session';
import type { MissionReward, ReviewReward } from '../../game/store';
import type { Lesson } from '../../game/types';
import type { CheckResult } from '../../game/validators';
import type { RunResult } from '../../sim/shell/types';
import { navigate } from '../router';
import { actions, progressStore, useProgress } from '../state';
import { TerminalPane } from '../terminal/TerminalPane';
import { LessonList } from './LessonList';
import { MissionPane, RewardView } from './MissionPane';
import { QuizRunner } from './QuizRunner';

/** Strip markdown backticks for plain terminal output. */
const plain = (s: string) => s.replace(/`/g, '');

function nextTarget(lesson: Lesson, index: number): { lessonId: string; mission: number } | null {
  if (index + 1 < lesson.missions.length) return { lessonId: lesson.id, mission: index + 1 };
  return null;
}

function Locked({ text }: { text: string }) {
  return (
    <div className="locked-screen">
      <h2>🔒 Locked</h2>
      <p>{text}</p>
      <button className="primary" onClick={() => navigate({ view: 'tree' })}>
        Back to the skill tree
      </button>
    </div>
  );
}

export function LessonView({ lesson, missionIndex }: { lesson: Lesson; missionIndex: number }) {
  const progress = useProgress();
  if (!isMissionUnlocked(progress, lesson, missionIndex, lessons)) return <Locked text="Finish the earlier missions and lessons first." />;
  return <MissionScreen key={`${lesson.id}/${missionIndex}`} lesson={lesson} missionIndex={missionIndex} mode="lesson" />;
}

/** A recall challenge for a mission the learner already finished. */
export function ReviewView({ missionId }: { missionId: string }) {
  const done = useProgress((p) => isMissionDone(p, missionId));
  const lesson = lessons.find((l) => l.missions.some((m) => m.id === missionId));
  if (!lesson) return <Locked text="This mission doesn't exist." />;
  if (!done) return <Locked text="Recall challenges are for missions you've already completed." />;
  const index = lesson.missions.findIndex((m) => m.id === missionId);
  return <MissionScreen key={`review/${missionId}`} lesson={lesson} missionIndex={index} mode="review" />;
}

function missionRewardView(r: MissionReward, xpBefore: number): RewardView {
  const b = r.breakdown;
  const lines: [string, string][] = [['Mission', String(b.base)]];
  if (b.hintCost) lines.push(['Hints used', `−${b.hintCost}`]);
  if (b.noHintBonus) lines.push(['No-hint bonus', `+${b.noHintBonus}`]);
  if (b.parBonus) lines.push(['On-par bonus', `+${b.parBonus}`]);
  if (r.previousBest) lines.push(['Previous best (already earned)', `−${Math.min(r.previousBest, b.total)}`]);
  if (r.dailyBonus) lines.push(["📅 Today's daily mission", `+${r.dailyBonus}`]);
  const total = r.awarded + r.dailyBonus;
  const after = levelInfo(xpBefore + total).level;
  return { total, lines, levelUp: after > levelInfo(xpBefore).level ? after : undefined, streak: r.streak, badges: r.badges };
}

function reviewRewardView(r: ReviewReward, xpBefore: number): RewardView {
  const lines: [string, string][] = [['Recall challenge', `+${r.awarded}`]];
  if (r.dailyBonus) lines.push(["📅 Today's daily mission", `+${r.dailyBonus}`]);
  const total = r.awarded + r.dailyBonus;
  const after = levelInfo(xpBefore + total).level;
  return {
    total,
    lines,
    levelUp: after > levelInfo(xpBefore).level ? after : undefined,
    streak: r.streak,
    badges: r.badges,
    note: `This mission comes back for another recall in ${r.nextInDays} day${r.nextInDays === 1 ? '' : 's'}.`,
  };
}

function MissionScreen({ lesson, missionIndex, mode }: { lesson: Lesson; missionIndex: number; mode: 'lesson' | 'review' }) {
  const mission = lesson.missions[missionIndex];
  const review = mode === 'review';
  const storeHearts = useProgress((p) => heartsLeft(p, lesson.id));
  // Recall challenges use their own practice hearts; they never cost lesson hearts.
  const [reviewHearts, setReviewHearts] = useState(MAX_HEARTS);
  const reviewHeartsRef = useRef(MAX_HEARTS);
  const hearts = review ? reviewHearts : storeHearts;
  const [attempt, setAttempt] = useState(0);
  const [feedback, setFeedback] = useState<CheckResult[] | null>(null);
  const [mistakes, setMistakes] = useState<string[]>([]);
  const [reward, setReward] = useState<RewardView | null>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const lastEvents = useRef<SessionEvent[]>([]);

  const isQuiz = mission.type === 'quiz';
  // A fresh machine (or question set) for every attempt. Entering with no hearts left starts failed.
  const session = useMemo(() => {
    const s = isQuiz ? new QuizSession(mission, attempt + 1 + (review ? 7 : 0)) : new MissionSession(mission);
    if (!review && heartsLeft(progressStore.getState().progress, lesson.id) === 0) s.fail();
    return s;
  }, [mission, lesson.id, attempt, review, isQuiz]);

  const restart = useCallback(() => {
    setAttempt((a) => a + 1);
    setFeedback(null);
    setMistakes([]);
    setReward(null);
  }, []);

  /** A mistake costs a heart; at zero the attempt fails. */
  const penalize = useCallback(() => {
    if (review) {
      reviewHeartsRef.current = Math.max(0, reviewHeartsRef.current - 1);
      setReviewHearts(reviewHeartsRef.current);
      if (reviewHeartsRef.current === 0) {
        session.fail();
        actions().failReview(mission.id);
      }
      return;
    }
    if (actions().loseHeart(lesson.id) === 0) session.fail();
  }, [lesson.id, session, review, mission.id]);

  const onPassed = useCallback(() => {
    const xpBefore = progressStore.getState().progress.xp;
    if (review) {
      setReward(reviewRewardView(actions().completeReview(session.mission, session.stats), xpBefore));
    } else {
      const r = actions().completeMission(session.mission, session.stats);
      // Finishing a lesson refills its hearts (and may earn "Flawless").
      const lessonBadges = isLessonComplete(progressStore.getState().progress, lesson) ? actions().finishLesson(lesson) : [];
      setReward(missionRewardView({ ...r, badges: [...r.badges, ...lessonBadges] }, xpBefore));
    }
    setFeedback(null);
  }, [lesson, session, review]);

  const handleEvents = useCallback(
    (events: SessionEvent[]) => {
      lastEvents.current = events;
      for (const e of events) {
        if (e.type === 'passed') onPassed();
        else {
          setMistakes((m) => [...m, e.result.message]);
          penalize();
        }
      }
      rerender();
    },
    [onPassed, penalize],
  );

  const execute = useCallback(
    (line: string): RunResult => {
      const { result, events } = (session as MissionSession).run(line);
      handleEvents(events);
      return result;
    },
    [session, handleEvents],
  );

  const onCommand = useCallback(() => {
    let extra = '';
    for (const e of lastEvents.current) {
      if (e.type === 'passed') extra += '\n\x1b[1;32m✔ Mission complete!\x1b[0m See the lesson panel for your reward.\n\n';
      else extra += `\x1b[33m⚠ ${plain(e.result.message)} (−1 ♥)\x1b[0m\n`;
    }
    if (session.status === 'failed') extra += '\x1b[31m💔 Out of hearts — press "Retry mission" in the lesson panel.\x1b[0m\n';
    lastEvents.current = [];
    return extra;
  }, [session]);

  const next = review ? null : nextTarget(lesson, missionIndex);
  const banner =
    `\x1b[1;36m${review ? '🔄 Recall challenge' : lesson.title}\x1b[0m — mission: \x1b[1m${mission.title}\x1b[0m\n` +
    'Read the task on the left, then use this terminal. Type \x1b[1mhelp\x1b[0m for available commands.\n\n';

  return (
    <div className="workspace">
      <LessonList
        lessons={lessons}
        current={{ lessonId: review ? '' : lesson.id, mission: missionIndex }}
        onSelect={(lessonId, m) => navigate({ view: 'lesson', lessonId, mission: m })}
      />
      <MissionPane
        key={`${mission.id}-${attempt}`}
        lesson={lesson}
        missionIndex={missionIndex}
        session={session}
        hearts={hearts}
        reward={reward}
        mode={mode}
        feedback={feedback}
        mistakes={mistakes}
        onCheck={() => {
          if (session instanceof QuizSession) return;
          const v = session.check();
          if (v.passed) onPassed();
          else {
            setFeedback(v.results);
            penalize();
          }
          rerender();
        }}
        onHint={() => {
          session.revealHint();
          rerender();
        }}
        onReset={restart}
        onRetry={() => {
          if (review) {
            reviewHeartsRef.current = MAX_HEARTS;
            setReviewHearts(MAX_HEARTS);
          }
          else actions().refillHearts(lesson.id);
          restart();
        }}
        onNext={next ? () => navigate({ view: 'lesson', ...next }) : () => navigate({ view: 'tree' })}
        nextLabel={next ? 'Next mission →' : review ? "Back to today's plan" : 'Lesson complete — back to the skill tree'}
      />
      {session instanceof QuizSession ? (
        <main className="quiz-area">
          <QuizRunner
            key={`${mission.id}-${attempt}`}
            session={session}
            onAnswered={(correct) => {
              if (!correct) penalize();
              rerender();
            }}
            onPassed={() => {
              onPassed();
              rerender();
            }}
          />
        </main>
      ) : (
        <main className="terminal-area">
          <TerminalPane
            key={`${mission.id}-${attempt}`}
            shell={session.shell}
            banner={banner}
            execute={execute}
            onCommand={onCommand}
            onFileSaved={() => {
              handleEvents(session.reevaluate());
              return onCommand();
            }}
          />
        </main>
      )}
    </div>
  );
}
