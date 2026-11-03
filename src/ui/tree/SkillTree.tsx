import { lessons } from '../../content';
import { heartsLeft, nextMissionIndex, NodeStatus, skillTree } from '../../game/progress';
import { Hearts } from '../lesson/MissionPane';
import { navigate } from '../router';
import { useProgress } from '../state';

const STATUS_LABEL: Record<NodeStatus, string> = {
  locked: 'Locked',
  available: 'Start',
  'in-progress': 'Continue',
  complete: 'Complete',
  'coming-soon': 'Coming soon',
};

export function SkillTree() {
  const progress = useProgress();
  const tree = skillTree(progress, lessons);
  return (
    <div className="skill-tree">
      <h1>Skill tree</h1>
      <p className="muted">Finish a branch to unlock the next one. Each lesson gives you 3 hearts; wrong checks and destructive mistakes cost one.</p>
      <ol className="branches">
        {tree.map((b) => (
          <li key={b.id} className={`branch-node ${b.status}`}>
            <div className="branch-icon" aria-hidden>
              {b.status === 'locked' ? '🔒' : b.icon}
            </div>
            <div className="branch-body">
              <div className="branch-title">
                <h2>{b.title}</h2>
                <span className={`status-chip ${b.status}`}>{STATUS_LABEL[b.status]}</span>
              </div>
              {b.lessons.map((n) => {
                const pct = Math.round((n.done / n.total) * 100);
                const open = n.status !== 'locked';
                return (
                  <button
                    key={n.lesson.id}
                    className={`lesson-node ${n.status}`}
                    disabled={!open}
                    onClick={() => navigate({ view: 'lesson', lessonId: n.lesson.id, mission: nextMissionIndex(progress, n.lesson) })}
                  >
                    <span className="lesson-node-title">{n.lesson.title}</span>
                    <span className="lesson-node-meta">
                      {open ? (
                        <>
                          {n.done}/{n.total} missions
                          {n.status !== 'complete' && <Hearts count={heartsLeft(progress, n.lesson.id)} />}
                        </>
                      ) : (
                        'Finish the previous branch to unlock'
                      )}
                    </span>
                    <span className="lesson-progress" aria-hidden>
                      <span style={{ width: `${pct}%` }} />
                    </span>
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
