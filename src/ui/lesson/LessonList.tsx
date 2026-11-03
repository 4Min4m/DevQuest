import type { Lesson } from '../../game/types';

interface Props {
  lessons: Lesson[];
  current: { lesson: number; mission: number };
  completed: Set<string>;
  onSelect: (lesson: number, mission: number) => void;
}

const TYPE_ICON = { guided: '◆', free: '◇', boss: '☠' } as const;

/** Sidebar listing every lesson and its missions. (Locking arrives with the skill tree.) */
export function LessonList({ lessons, current, completed, onSelect }: Props) {
  return (
    <nav className="lesson-list" aria-label="Lessons">
      {lessons.map((lesson, li) => (
        <section key={lesson.id}>
          <h3>{lesson.title}</h3>
          <ol>
            {lesson.missions.map((m, mi) => {
              const active = li === current.lesson && mi === current.mission;
              const done = completed.has(m.id);
              return (
                <li key={m.id}>
                  <button
                    className={`mission-link${active ? ' active' : ''}${done ? ' done' : ''}`}
                    aria-current={active ? 'step' : undefined}
                    onClick={() => onSelect(li, mi)}
                  >
                    <span className="mission-icon" aria-hidden>
                      {done ? '✓' : TYPE_ICON[m.type]}
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
