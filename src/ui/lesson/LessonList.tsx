import { isMissionDone, isMissionUnlocked } from '../../game/progress';
import type { Lesson } from '../../game/types';
import { useProgress } from '../state';

interface Props {
  lessons: Lesson[];
  current: { lessonId: string; mission: number };
  onSelect: (lessonId: string, mission: number) => void;
}

const TYPE_ICON = { guided: '◆', free: '◇', boss: '☠', quiz: '?' } as const;

/** Sidebar listing every lesson and its missions, with completion and locks. */
export function LessonList({ lessons, current, onSelect }: Props) {
  const progress = useProgress();
  return (
    <nav className="lesson-list" aria-label="Lessons">
      {lessons.map((lesson) => (
        <section key={lesson.id}>
          <h3>{lesson.title}</h3>
          <ol>
            {lesson.missions.map((m, mi) => {
              const active = lesson.id === current.lessonId && mi === current.mission;
              const done = isMissionDone(progress, m.id);
              const unlocked = isMissionUnlocked(progress, lesson, mi, lessons);
              return (
                <li key={m.id}>
                  <button
                    className={`mission-link${active ? ' active' : ''}${done ? ' done' : ''}`}
                    aria-current={active ? 'step' : undefined}
                    disabled={!unlocked}
                    title={unlocked ? undefined : 'Finish the previous missions to unlock'}
                    onClick={() => onSelect(lesson.id, mi)}
                  >
                    <span className="mission-icon" aria-hidden>
                      {done ? '✓' : unlocked ? TYPE_ICON[m.type] : '🔒'}
                    </span>
                    {m.title}
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </nav>
  );
}
