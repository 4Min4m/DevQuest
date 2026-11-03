import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { lessons } from '../../content';
import { heartsLeft, isLessonComplete, isMissionUnlocked, Reward } from '../../game/progress';
import { MissionSession, SessionEvent } from '../../game/session';
import type { Lesson } from '../../game/types';
import type { CheckResult } from '../../game/validators';
import type { RunResult } from '../../sim/shell/types';
import { navigate } from '../router';
import { actions, progressStore, useProgress } from '../state';
import { TerminalPane } from '../terminal/TerminalPane';
import { LessonList } from './LessonList';
import { MissionPane } from './MissionPane';

/** Strip markdown backticks for plain terminal output. */
const plain = (s: string) => s.replace(/`/g, '');

function nextTarget(lesson: Lesson, index: number): { lessonId: string; mission: number } | null {
  if (index + 1 < lesson.missions.length) return { lessonId: lesson.id, mission: index + 1 };
  return null;
}

export function LessonView({ lesson, missionIndex }: { lesson: Lesson; missionIndex: number }) {
  const progress = useProgress();
  const unlocked = isMissionUnlocked(progress, lesson, missionIndex, lessons);
  if (!unlocked) {
    return (
      <div className="locked-screen">
        <h2>🔒 Locked</h2>
        <p>Finish the earlier missions and lessons first.</p>
        <button className="primary" onClick={() => navigate({ view: 'tree' })}>
          Back to the skill tree
        </button>
      </div>
    );
  }
  return <MissionScreen key={`${lesson.id}/${missionIndex}`} lesson={lesson} missionIndex={missionIndex} />;
}

function MissionScreen({ lesson, missionIndex }: { lesson: Lesson; missionIndex: number }) {
  const mission = lesson.missions[missionIndex];
  const hearts = useProgress((p) => heartsLeft(p, lesson.id));
  const [attempt, setAttempt] = useState(0);
  const [feedback, setFeedback] = useState<CheckResult[] | null>(null);
  const [mistakes, setMistakes] = useState<string[]>([]);
  const [reward, setReward] = useState<Reward | null>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const lastEvents = useRef<SessionEvent[]>([]);

  // A fresh machine for every attempt. Entering with no hearts left starts in the failed state.
  const session = useMemo(() => {
    const s = new MissionSession(mission);
    if (heartsLeft(progressStore.getState().progress, lesson.id) === 0) s.fail();
    return s;
  }, [mission, lesson.id, attempt]);

  const restart = useCallback(() => {
    setAttempt((a) => a + 1);
    setFeedback(null);
    setMistakes([]);
    setReward(null);
  }, []);

  /** A mistake costs a heart; at zero the attempt fails. */
  const penalize = useCallback(() => {
    if (actions().loseHeart(lesson.id) === 0) session.fail();
  }, [lesson.id, session]);

  const onPassed = useCallback(() => {
    setReward(actions().completeMission(session.mission, session.stats));
    setFeedback(null);
    // Finishing a lesson refills its hearts for future replays.
    if (isLessonComplete(progressStore.getState().progress, lesson)) actions().refillHearts(lesson.id);
  }, [lesson, session]);

  const execute = useCallback(
    (line: string): RunResult => {
      const { result, events } = session.run(line);
      lastEvents.current = events;
      for (const e of events) {
        if (e.type === 'passed') onPassed();
        else {
          setMistakes((m) => [...m, e.result.message]);
          penalize();
        }
      }
      rerender();
      return result;
    },
    [session, onPassed, penalize],
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

  const next = nextTarget(lesson, missionIndex);
  const banner =
    `\x1b[1;36m${lesson.title}\x1b[0m — mission: \x1b[1m${mission.title}\x1b[0m\n` +
    'Read the task on the left, then use this terminal. Type \x1b[1mhelp\x1b[0m for available commands.\n\n';

  return (
    <div className="workspace">
      <LessonList
        lessons={lessons}
        current={{ lessonId: lesson.id, mission: missionIndex }}
        onSelect={(lessonId, m) => navigate({ view: 'lesson', lessonId, mission: m })}
      />
      <MissionPane
        key={`${mission.id}-${attempt}`}
        lesson={lesson}
        missionIndex={missionIndex}
        session={session}
        hearts={hearts}
        reward={reward}
        feedback={feedback}
        mistakes={mistakes}
        onCheck={() => {
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
          actions().refillHearts(lesson.id);
          restart();
        }}
        onNext={next ? () => navigate({ view: 'lesson', ...next }) : () => navigate({ view: 'tree' })}
        nextLabel={next ? 'Next mission →' : 'Lesson complete — back to the skill tree'}
      />
      <main className="terminal-area">
        <TerminalPane key={`${mission.id}-${attempt}`} shell={session.shell} banner={banner} execute={execute} onCommand={onCommand} />
      </main>
    </div>
  );
}
