import { useEffect } from 'react';
import { lessons } from '../../content';
import { DAILY_BONUS, dailyClaimedToday } from '../../game/daily';
import { INTERVIEW_QUESTIONS, interviewPool } from '../../game/interview';
import { isMissionDone } from '../../game/progress';
import { reviewsDue } from '../../game/review';
import { navigate } from '../router';
import { actions, useProgress } from '../state';

function findMission(id: string) {
  for (const lesson of lessons) {
    const index = lesson.missions.findIndex((m) => m.id === id);
    if (index >= 0) return { lesson, index, mission: lesson.missions[index] };
  }
  return null;
}

/** Daily mission, recall challenges due, and the way into Interview Mode. */
export function TodayPanel() {
  const progress = useProgress();
  useEffect(() => actions().ensureDaily(), []);
  const now = new Date();
  const pick = progress.daily.pick;
  const daily = pick ? findMission(pick.missionId) : null;
  const claimed = dailyClaimedToday(progress, now);
  const due = reviewsDue(progress, now).map((d) => ({ ...d, found: findMission(d.missionId) })).filter((d) => d.found);
  const pool = interviewPool(progress, lessons);

  const openDaily = () => {
    if (!daily || !pick) return;
    if (pick.kind === 'review' && isMissionDone(progress, pick.missionId)) navigate({ view: 'review', missionId: pick.missionId });
    else navigate({ view: 'lesson', lessonId: daily.lesson.id, mission: daily.index });
  };

  return (
    <section className="today" aria-label="Today">
      <div className={`today-card daily${claimed ? ' claimed' : ''}`}>
        <div className="today-label">📅 Daily mission</div>
        {daily ? (
          <>
            <div className="today-title">{daily.mission.title}</div>
            <div className="muted">
              {pick?.kind === 'review' ? 'Recall challenge' : 'New mission'} · {daily.lesson.title}
            </div>
            {claimed ? (
              <div className="today-done">✓ Done for today, see you tomorrow</div>
            ) : (
              <button className="primary" onClick={openDaily}>
                Play (+{DAILY_BONUS} XP bonus)
              </button>
            )}
          </>
        ) : (
          <div className="muted">Nothing to pick yet.</div>
        )}
      </div>

      <div className="today-card">
        <div className="today-label">🔄 Recall challenges</div>
        {due.length ? (
          <>
            <div className="muted">{due.length} mission{due.length === 1 ? '' : 's'} due for review: solve them again without hints.</div>
            <ul className="due-list">
              {due.slice(0, 4).map((d) => (
                <li key={d.missionId}>
                  <button onClick={() => navigate({ view: 'review', missionId: d.missionId })}>
                    {d.found!.mission.title}
                    {d.overdue > 0 && <span className="muted"> · {d.overdue}d overdue</span>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="muted">Nothing due. Finished missions come back here after 1, 3, 7, 14… days.</div>
        )}
      </div>

      <div className="today-card">
        <div className="today-label">🎤 Interview Mode</div>
        <div className="muted">
          {INTERVIEW_QUESTIONS} random missions you've completed, 10 minutes, no hints.
          {progress.interviews.passed > 0 && ` Passed ${progress.interviews.passed}×.`}
        </div>
        <button disabled={pool.length < INTERVIEW_QUESTIONS} onClick={() => navigate({ view: 'interview' })}>
          {pool.length < INTERVIEW_QUESTIONS ? `Unlocks after ${INTERVIEW_QUESTIONS} missions` : 'Start an interview'}
        </button>
      </div>
    </section>
  );
}
