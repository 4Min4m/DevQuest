import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { lessons } from '../content';
import { MissionSession, SessionEvent } from '../game/session';
import type { CheckResult } from '../game/validators';
import type { RunResult } from '../sim/shell/types';
import { LessonList } from './lesson/LessonList';
import { MissionPane } from './lesson/MissionPane';
import { TerminalPane } from './terminal/TerminalPane';

interface Pos {
  lesson: number;
  mission: number;
}

function nextPos(p: Pos): Pos | null {
  if (p.mission + 1 < lessons[p.lesson].missions.length) return { lesson: p.lesson, mission: p.mission + 1 };
  if (p.lesson + 1 < lessons.length) return { lesson: p.lesson + 1, mission: 0 };
  return null;
}

/** Strip markdown backticks for plain terminal output. */
const plain = (s: string) => s.replace(/`/g, '');

export function App() {
  const [pos, setPos] = useState<Pos>({ lesson: 0, mission: 0 });
  const [attempt, setAttempt] = useState(0);
  const [completed, setCompleted] = useState<Set<string>>(() => new Set());
  const [feedback, setFeedback] = useState<CheckResult[] | null>(null);
  const [mistakes, setMistakes] = useState<string[]>([]);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const lastEvents = useRef<SessionEvent[]>([]);

  const lesson = lessons[pos.lesson];
  const mission = lesson.missions[pos.mission];
  // A fresh machine for every mission and every reset.
  const session = useMemo(() => new MissionSession(mission), [mission, attempt]);

  const start = useCallback((p: Pos) => {
    setPos(p);
    setAttempt((a) => a + 1);
    setFeedback(null);
    setMistakes([]);
  }, []);

  const execute = useCallback(
    (line: string): RunResult => {
      const { result, events } = session.run(line);
      lastEvents.current = events;
      for (const e of events) {
        if (e.type === 'passed') {
          setCompleted((c) => new Set(c).add(session.mission.id));
          setFeedback(null);
        } else {
          setMistakes((m) => [...m, e.result.message]);
        }
      }
      rerender();
      return result;
    },
    [session],
  );

  const onCommand = useCallback(() => {
    let extra = '';
    for (const e of lastEvents.current) {
      if (e.type === 'passed') extra += '\n\x1b[1;32m✔ Mission complete!\x1b[0m See the lesson panel for what you learned.\n\n';
      else extra += `\x1b[33m⚠ ${plain(e.result.message)} Press Reset in the lesson panel to restore the machine.\x1b[0m\n`;
    }
    lastEvents.current = [];
    return extra;
  }, []);

  const next = nextPos(pos);
  const banner =
    `\x1b[1;36m${lesson.title}\x1b[0m — mission: \x1b[1m${mission.title}\x1b[0m\n` +
    'Read the task on the left, then use this terminal. Type \x1b[1mhelp\x1b[0m for available commands.\n\n';

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">⚙ DevOps Quest</span>
        <span className="subtitle">Linux &amp; Docker, hands-on</span>
      </header>
      <div className="workspace">
        <LessonList lessons={lessons} current={pos} completed={completed} onSelect={(l, m) => start({ lesson: l, mission: m })} />
        <MissionPane
          key={`${mission.id}-${attempt}`}
          lesson={lesson}
          missionIndex={pos.mission}
          session={session}
          feedback={feedback}
          mistakes={mistakes}
          onCheck={() => {
            const v = session.check();
            if (v.passed) setCompleted((c) => new Set(c).add(mission.id));
            setFeedback(v.passed ? null : v.results);
            rerender();
          }}
          onHint={() => {
            session.revealHint();
            rerender();
          }}
          onReset={() => start(pos)}
          onNext={next ? () => start(next) : null}
        />
        <main className="terminal-area">
          <TerminalPane key={`${mission.id}-${attempt}`} shell={session.shell} banner={banner} execute={execute} onCommand={onCommand} />
        </main>
      </div>
    </div>
  );
}
