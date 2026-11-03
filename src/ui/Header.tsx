import { activeStreak, levelInfo } from '../game/progress';
import { navigate, Route } from './router';
import { useProgress } from './state';

export function Header({ route }: { route: Route }) {
  const xp = useProgress((p) => p.xp);
  const streak = useProgress((p) => activeStreak(p.streak, new Date()));
  const lvl = levelInfo(xp);
  const pct = Math.round((lvl.intoLevel / lvl.levelSize) * 100);
  return (
    <header className="app-header">
      <button className="logo" onClick={() => navigate({ view: 'tree' })}>
        ⚙ DevOps Quest
      </button>
      <nav className="main-nav">
        <button className={route.view === 'tree' ? 'active' : ''} onClick={() => navigate({ view: 'tree' })}>
          Skill tree
        </button>
        <button className={route.view === 'profile' ? 'active' : ''} onClick={() => navigate({ view: 'profile' })}>
          Profile
        </button>
      </nav>
      <div className="player-stats">
        <span className="streak" title={streak ? `${streak}-day streak` : 'Complete a mission today to start a streak'}>
          🔥 {streak}
        </span>
        <span className="level" title={`${xp} XP total · ${lvl.toNext} XP to level ${lvl.level + 1}`}>
          <span className="level-num">Lv {lvl.level}</span>
          <span className="xp-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progress to next level">
            <span style={{ width: `${pct}%` }} />
          </span>
          <span className="xp-num">{xp} XP</span>
        </span>
      </div>
    </header>
  );
}
