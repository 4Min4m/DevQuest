import { lessons } from '../../content';
import { BranchNode, heartsLeft, nextMissionIndex, NodeStatus, ProgressState, skillTree, TRACKS } from '../../game/progress';
import { Hearts } from '../lesson/MissionPane';
import { navigate } from '../router';
import { TodayPanel } from './TodayPanel';
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
      <TodayPanel />
      <h1>Skill tree</h1>
      <p className="muted">
        Hands-on branches unlock in order; theory checks are open any time. Each lesson gives you 3 hearts: wrong answers and
        destructive mistakes cost one.
      </p>
      {TRACKS.map((track) => {
        const branches = tree.filter((b) => b.track === track.id);
        if (branches.every((b) => b.status === 'coming-soon')) return null;
        return (
          <section key={track.id} className="track">
            <h2 className="track-title">{track.title}</h2>
            <p className="muted track-desc">{track.description}</p>
            <BranchList branches={branches} progress={progress} />
          </section>
        );
      })}
      <section className="track">
        <h2 className="track-title">Coming next</h2>
        <ul className="coming-soon-list">
          {tree
            .filter((b) => b.status === 'coming-soon')
            .map((b) => (
              <li key={b.id}>
                <span aria-hidden>{b.icon}</span> {b.title}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

function BranchList({ branches, progress }: { branches: BranchNode[]; progress: ProgressState }) {
  return (
      <ol className="branches">
        {branches.filter((b) => b.status !== 'coming-soon').map((b) => (
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
                        'Finish the previous lesson to unlock'
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
  );
}
