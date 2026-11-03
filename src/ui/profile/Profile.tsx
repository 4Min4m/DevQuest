import { useRef, useState } from 'react';
import { lessons } from '../../content';
import { BADGES } from '../../game/badges';
import { formatClock } from '../../game/interview';
import { activeStreak, dayKey, levelInfo } from '../../game/progress';
import { totalReviews } from '../../game/review';
import { actions, useProgress } from '../state';

export function Profile() {
  const progress = useProgress();
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const lvl = levelInfo(progress.xp);
  const allMissions = lessons.flatMap((l) => l.missions);
  const records = Object.values(progress.missions);
  const done = allMissions.filter((m) => m.id in progress.missions).length;

  const download = () => {
    const blob = new Blob([actions().exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `devops-quest-progress-${dayKey(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage({ kind: 'ok', text: 'Progress exported.' });
  };

  const upload = async (file: File) => {
    try {
      actions().importJson(await file.text());
      setMessage({ kind: 'ok', text: 'Progress imported.' });
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    }
  };

  return (
    <div className="profile">
      <h1>Profile</h1>
      <div className="stat-grid">
        <div className="stat">
          <span className="stat-value">{lvl.level}</span>
          <span className="stat-label">Level</span>
        </div>
        <div className="stat">
          <span className="stat-value">{progress.xp}</span>
          <span className="stat-label">Total XP</span>
        </div>
        <div className="stat">
          <span className="stat-value">🔥 {activeStreak(progress.streak, new Date())}</span>
          <span className="stat-label">Day streak (best {progress.streak.best})</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {done}/{allMissions.length}
          </span>
          <span className="stat-label">Missions done</span>
        </div>
        <div className="stat">
          <span className="stat-value">{records.filter((r) => r.noHints).length}</span>
          <span className="stat-label">Solved without hints</span>
        </div>
        <div className="stat">
          <span className="stat-value">{records.filter((r) => r.onPar).length}</span>
          <span className="stat-label">Solved on par</span>
        </div>
        <div className="stat">
          <span className="stat-value">{totalReviews(progress)}</span>
          <span className="stat-label">Recall challenges done</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {progress.interviews.passed}/{progress.interviews.attempts}
          </span>
          <span className="stat-label">
            Interviews passed{progress.interviews.bestMs !== null ? ` (best ${formatClock(progress.interviews.bestMs)})` : ''}
          </span>
        </div>
      </div>

      <section>
        <h2 className="section-title">
          Badges <span className="muted">{Object.keys(progress.badges).length}/{BADGES.length}</span>
        </h2>
        <ul className="badge-grid">
          {BADGES.map((b) => {
            const at = progress.badges[b.id];
            return (
              <li key={b.id} className={at ? 'earned' : 'locked'} title={at ? `Earned ${at.slice(0, 10)}` : 'Not earned yet'}>
                <span className="badge-icon" aria-hidden>
                  {at ? b.icon : '🔒'}
                </span>
                <span className="badge-title">{b.title}</span>
                <span className="badge-desc">{b.description}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="data-section">
        <h2>Your data</h2>
        <p className="muted">
          Progress is saved in this browser only. Export it to back it up or move it to another device.
        </p>
        <div className="actions">
          <button className="primary" onClick={download}>
            Export progress
          </button>
          <button onClick={() => fileInput.current?.click()}>Import progress…</button>
          <button
            className="danger"
            onClick={() => {
              if (window.confirm('Reset all progress? This cannot be undone (export first if unsure).')) {
                actions().reset();
                setMessage({ kind: 'ok', text: 'Progress reset.' });
              }
            }}
          >
            Reset progress
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Progress file to import"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
        {message && (
          <p className={`notice ${message.kind === 'ok' ? 'success' : 'error'}`} role="status">
            {message.text}
          </p>
        )}
      </section>
    </div>
  );
}
