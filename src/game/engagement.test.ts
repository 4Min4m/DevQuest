import { describe, expect, it } from 'vitest';
import { lessons as realLessons } from '../content';
import { awardBadges, BADGES } from './badges';
import { chooseDaily, claimDaily, DAILY_BONUS, ensureDaily } from './daily';
import { formatClock, INTERVIEW_TIME_MS, interviewPool, pickInterview, recordInterview, scoreInterview } from './interview';
import * as P from './progress';
import { completeReview, failReview, reviewsDue, totalReviews } from './review';
import type { SessionStats } from './session';
import { createProgressStore } from './store';
import type { Lesson, Mission } from './types';

const mission = (id: string, type: Mission['type'] = 'guided'): Mission => ({
  id,
  title: id,
  type,
  prompt: 'p',
  hints: [],
  validator: { checks: [{ type: 'cwd', path: '/' }] },
  xp: 20,
  par: 2,
  solution: ['cd /'],
});
const lesson = (id: string, prereq: string[], ms: Mission[]): Lesson => ({ id, title: id, branch: 'linux-basics', prerequisites: prereq, theory: 't', missions: ms });
const L = [lesson('l1', [], [mission('a'), mission('b')]), lesson('l2', ['l1'], [mission('c'), mission('boss1', 'boss')])];
const stats = (s: Partial<SessionStats> = {}): SessionStats => ({ commands: 1, par: 2, hintsUsed: 0, hintXpCost: 0, failedChecks: 0, mistakes: 0, ...s });
const day = (d: string) => new Date(`${d}T12:00:00`);
const done = (p: P.ProgressState, id: string, d = '2026-11-03') => P.completeMission(p, mission(id), stats(), day(d)).progress;

describe('dates', () => {
  it('addDays crosses months and years', () => {
    expect(P.addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(P.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(P.addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('spaced review', () => {
  it('schedules a first review the day after completion', () => {
    const p = done(P.initialProgress(), 'a');
    expect(p.reviews.a).toEqual({ reps: 0, due: '2026-11-04', done: 0 });
    expect(reviewsDue(p, day('2026-11-03'))).toEqual([]);
    expect(reviewsDue(p, day('2026-11-06'))).toEqual([{ missionId: 'a', due: '2026-11-04', overdue: 2 }]);
    // replays don't reschedule
    expect(done(p, 'a', '2026-11-05').reviews.a.due).toBe('2026-11-04');
  });

  it('successful recalls grow the interval; failures start over', () => {
    let p = done(P.initialProgress(), 'a');
    let r = completeReview(p, mission('a'), stats(), day('2026-11-04'));
    expect(r.reward).toMatchObject({ awarded: 6, nextInDays: 3 });
    p = r.progress;
    expect(p.reviews.a).toEqual({ reps: 1, due: '2026-11-07', done: 1 });
    r = completeReview(p, mission('a'), stats({ failedChecks: 1 }), day('2026-11-07'));
    expect(r.reward).toMatchObject({ awarded: 3, nextInDays: 7 }); // half reward when not clean
    p = failReview(r.progress, 'a', day('2026-11-14'));
    expect(p.reviews.a).toMatchObject({ reps: 0, due: '2026-11-15', done: 2 });
    expect(totalReviews(p)).toBe(2);
    expect(p.missions.a.completions).toBe(3);
  });
});

describe('daily mission', () => {
  it('picks the next new mission, then overdue reviews', () => {
    let p = P.initialProgress();
    expect(chooseDaily(p, L, day('2026-11-03'))).toEqual({ day: '2026-11-03', missionId: 'a', kind: 'new' });
    p = done(p, 'a');
    expect(chooseDaily(p, L, day('2026-11-03'))?.missionId).toBe('b');
    expect(chooseDaily(p, L, day('2026-11-05'))).toEqual({ day: '2026-11-05', missionId: 'a', kind: 'review' });
  });

  it('is fixed for the day and pays its bonus once', () => {
    let p = ensureDaily(P.initialProgress(), L, day('2026-11-03'));
    expect(p.daily.pick?.missionId).toBe('a');
    p = done(p, 'a');
    expect(ensureDaily(p, L, day('2026-11-03')).daily.pick?.missionId).toBe('a'); // unchanged today
    const c = claimDaily(p, 'a', day('2026-11-03'));
    expect(c.bonus).toBe(DAILY_BONUS);
    expect(claimDaily(c.progress, 'a', day('2026-11-03')).bonus).toBe(0);
    expect(claimDaily(p, 'b', day('2026-11-03')).bonus).toBe(0);
    expect(ensureDaily(c.progress, L, day('2026-11-04')).daily.pick?.day).toBe('2026-11-04');
  });

  it('falls back to a finished mission when everything is done', () => {
    let p = P.initialProgress();
    for (const id of ['a', 'b', 'c', 'boss1']) p = done(p, id, '2026-11-01');
    p = { ...p, reviews: {} };
    expect(chooseDaily(p, L, day('2026-11-03'))?.kind).toBe('review');
    expect(chooseDaily(P.initialProgress(), [], day('2026-11-03'))).toBeNull();
  });
});

describe('interview mode', () => {
  it('pool is finished missions; picks are deterministic per seed', () => {
    let p = P.initialProgress();
    for (const id of ['a', 'b', 'c']) p = done(p, id);
    const pool = interviewPool(p, L);
    expect(pool.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(pickInterview(pool, 2, 42)).toEqual(pickInterview(pool, 2, 42));
    expect(pickInterview(pool, 3, 7).map((m) => m.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('scores: all solved in time passes', () => {
    expect(scoreInterview(3, 3, 5 * 60_000)).toMatchObject({ passed: true, xp: 75 });
    expect(scoreInterview(3, 3, INTERVIEW_TIME_MS + 1)).toMatchObject({ passed: false, xp: 45 });
    expect(scoreInterview(2, 3, 60_000)).toMatchObject({ passed: false, xp: 30 });
    let p = recordInterview(P.initialProgress(), scoreInterview(3, 3, 300_000));
    p = recordInterview(p, scoreInterview(3, 3, 200_000));
    p = recordInterview(p, scoreInterview(1, 3, 100_000));
    expect(p.interviews).toEqual({ attempts: 3, passed: 2, bestMs: 200_000 });
    expect(formatClock(65_400)).toBe('1:06');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('badges', () => {
  it('are awarded once, when earned', () => {
    let p = done(P.initialProgress(), 'a');
    let r = awardBadges(p, L, day('2026-11-03'));
    expect(r.earned.map((b) => b.id)).toEqual(['first-mission']);
    expect(awardBadges(r.progress, L, day('2026-11-03')).earned).toEqual([]);
    p = done(r.progress, 'boss1');
    r = awardBadges(p, L, day('2026-11-03'));
    expect(r.earned.map((b) => b.id)).toContain('boss-slayer');
  });

  it('every badge has a unique id and works on the real catalog', () => {
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
    let p = P.initialProgress();
    for (const m of realLessons.flatMap((l) => l.missions)) p = P.completeMission(p, m, stats({ commands: 1, par: 1 }), day('2026-11-03')).progress;
    const ids = awardBadges(p, realLessons, day('2026-11-03')).earned.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['linux-graduate', 'container-captain', 'image-smith', 'conductor', 'crashloop-fixer', 'boss-slayer', 'no-hints-10', 'on-par-5', 'level-5']));
  });
});

describe('progress v2 migration', () => {
  it('upgrades v1 exports and schedules reviews', () => {
    const v1 = {
      app: 'devops-quest',
      version: 1,
      xp: 50,
      missions: { a: { bestXp: 28, completions: 1, firstCompletedAt: '2026-11-01T10:00:00.000Z', noHints: true, onPar: true } },
      hearts: {},
      streak: { current: 1, best: 1, lastDay: '2026-11-01' },
    };
    const p = P.importProgress(JSON.stringify(v1));
    expect(p.version).toBe(2);
    expect(p.reviews.a).toEqual({ reps: 0, due: '2026-11-02', done: 0 });
    expect(p.badges).toEqual({});
    expect(p.interviews).toEqual({ attempts: 0, passed: 0, bestMs: null });
  });
  it('round-trips v2 data', () => {
    let p = done(P.initialProgress(), 'a');
    p = ensureDaily(p, L, day('2026-11-03'));
    p = recordInterview(p, scoreInterview(3, 3, 1000));
    p = { ...p, perfectLessons: ['l1'], badges: { 'first-mission': '2026-11-03T12:00:00.000Z' } };
    expect(P.importProgress(P.exportProgress(p))).toEqual(p);
  });
  it('rejects broken review data', () => {
    const bad = { ...JSON.parse(P.exportProgress(P.initialProgress())), reviews: { a: { reps: 0, due: 'soon' } } };
    expect(() => P.importProgress(JSON.stringify(bad))).toThrow('invalid review for "a"');
  });
});

describe('store integration', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };

  it('completion pays the daily bonus and awards badges', () => {
    const s = createProgressStore(memory(), L);
    s.getState().ensureDaily(day('2026-11-03'));
    const r = s.getState().completeMission(mission('a'), stats(), day('2026-11-03'));
    expect(r.dailyBonus).toBe(DAILY_BONUS);
    expect(r.badges.map((b) => b.id)).toEqual(['first-mission']);
    expect(s.getState().progress.xp).toBe(28 + DAILY_BONUS);
  });

  it('finishLesson records a perfect run and refills hearts', () => {
    const s = createProgressStore(memory(), L);
    s.getState().completeMission(mission('a'), stats(), day('2026-11-03'));
    expect(s.getState().finishLesson(L[0], day('2026-11-03'))).toEqual([]); // not complete yet
    s.getState().completeMission(mission('b'), stats(), day('2026-11-03'));
    expect(s.getState().finishLesson(L[0], day('2026-11-03')).map((b) => b.id)).toContain('perfect-lesson');
    expect(s.getState().progress.perfectLessons).toEqual(['l1']);
  });

  it('no perfect lesson after losing a heart', () => {
    const s = createProgressStore(memory(), L);
    s.getState().loseHeart('l1');
    s.getState().completeMission(mission('a'), stats(), day('2026-11-03'));
    s.getState().completeMission(mission('b'), stats(), day('2026-11-03'));
    s.getState().finishLesson(L[0], day('2026-11-03'));
    expect(s.getState().progress.perfectLessons).toEqual([]);
    expect(P.heartsLeft(s.getState().progress, 'l1')).toBe(3);
  });

  it('reviews and interviews through the store', () => {
    const s = createProgressStore(memory(), L);
    s.getState().completeMission(mission('a'), stats(), day('2026-11-03'));
    const r = s.getState().completeReview(mission('a'), stats(), day('2026-11-04'));
    expect(r.nextInDays).toBe(3);
    s.getState().failReview('a', day('2026-11-08'));
    expect(s.getState().progress.reviews.a.due).toBe('2026-11-09');
    expect(s.getState().recordInterview(scoreInterview(3, 3, 1000)).map((b) => b.id)).toContain('interview-pass');
  });

  it('opening the home screen grants badges already earned', () => {
    const storage = memory();
    const s = createProgressStore(storage, L);
    s.getState().importJson(
      JSON.stringify({ app: 'devops-quest', version: 1, xp: 10, missions: { a: { bestXp: 10, completions: 1, firstCompletedAt: '2026-11-01T00:00:00.000Z' } }, hearts: {}, streak: { current: 0, best: 3, lastDay: null } }),
    );
    expect(s.getState().progress.badges).toEqual({});
    s.getState().ensureDaily(day('2026-11-03'));
    expect(Object.keys(s.getState().progress.badges).sort()).toEqual(['first-mission', 'streak-3']);
  });

  it('loads v1 saves from storage', () => {
    const storage = memory();
    storage.setItem(
      'devops-quest-progress',
      JSON.stringify({ state: { progress: { version: 1, xp: 99, missions: {}, hearts: {}, streak: { current: 0, best: 0, lastDay: null } } }, version: 1 }),
    );
    const s = createProgressStore(storage, L);
    expect(s.getState().progress).toMatchObject({ version: 2, xp: 99, badges: {} });
  });
});
