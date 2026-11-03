import { describe, expect, it } from 'vitest';
import * as P from './progress';
import { MissionSession } from './session';
import type { SessionStats } from './session';
import { createProgressStore, STORAGE_KEY } from './store';
import type { Lesson, Mission } from './types';

const mission = (id: string, xp = 20, par = 2): Mission => ({
  id,
  title: id,
  type: 'guided',
  prompt: 'p',
  hints: [{ text: 'h', cost: 5 }],
  validator: { checks: [{ type: 'fileExists', path: `/home/student/${id}` }] },
  xp,
  par,
  solution: [`touch ${id}`],
});

const lesson = (id: string, prerequisites: string[], missions: Mission[], branch: Lesson['branch'] = 'linux-basics'): Lesson => ({
  id,
  title: id,
  branch,
  prerequisites,
  theory: 't',
  missions,
});

const stats = (s: Partial<SessionStats> = {}): SessionStats => ({
  commands: 2,
  par: 2,
  hintsUsed: 0,
  hintXpCost: 0,
  failedChecks: 0,
  mistakes: 0,
  ...s,
});

const day = (iso: string) => new Date(iso + 'T12:00:00');

describe('scoring', () => {
  it('awards base + no-hint and par bonuses', () => {
    expect(P.scoreMission(mission('a', 20), stats())).toEqual({ base: 20, hintCost: 0, noHintBonus: 4, parBonus: 4, total: 28 });
  });
  it('subtracts hint costs and drops bonuses', () => {
    expect(P.scoreMission(mission('a', 20), stats({ hintsUsed: 2, hintXpCost: 10, commands: 5 }))).toEqual({
      base: 20,
      hintCost: 10,
      noHintBonus: 0,
      parBonus: 0,
      total: 10,
    });
  });
  it('never lets hints take more than 75% of the base', () => {
    expect(P.scoreMission(mission('a', 20), stats({ hintsUsed: 3, hintXpCost: 100, commands: 9 })).total).toBe(5);
  });
});

describe('levels', () => {
  it('uses growing thresholds', () => {
    expect([1, 2, 3, 4].map(P.xpForLevel)).toEqual([0, 100, 300, 600]);
    expect(P.levelInfo(0)).toEqual({ level: 1, intoLevel: 0, levelSize: 100, toNext: 100 });
    expect(P.levelInfo(99).level).toBe(1);
    expect(P.levelInfo(100)).toEqual({ level: 2, intoLevel: 0, levelSize: 200, toNext: 200 });
    expect(P.levelInfo(450)).toMatchObject({ level: 3, intoLevel: 150, toNext: 150 });
  });
});

describe('streaks', () => {
  const empty: P.StreakState = { current: 0, best: 0, lastDay: null };
  it('starts, extends on consecutive days and ignores repeats', () => {
    let s = P.touchStreak(empty, day('2026-11-01'));
    expect(s).toEqual({ current: 1, best: 1, lastDay: '2026-11-01' });
    s = P.touchStreak(s, day('2026-11-01'));
    expect(s.current).toBe(1);
    s = P.touchStreak(s, day('2026-11-02'));
    s = P.touchStreak(s, day('2026-11-03'));
    expect(s).toEqual({ current: 3, best: 3, lastDay: '2026-11-03' });
  });
  it('restarts after a missed day but keeps the best', () => {
    const s = P.touchStreak({ current: 5, best: 5, lastDay: '2026-10-01' }, day('2026-10-03'));
    expect(s).toEqual({ current: 1, best: 5, lastDay: '2026-10-03' });
  });
  it('works across month and year boundaries', () => {
    expect(P.touchStreak({ current: 2, best: 2, lastDay: '2026-12-31' }, day('2027-01-01')).current).toBe(3);
  });
  it('shows 0 once the streak is broken', () => {
    const s: P.StreakState = { current: 4, best: 4, lastDay: '2026-11-01' };
    expect(P.activeStreak(s, day('2026-11-02'))).toBe(4); // still alive today
    expect(P.activeStreak(s, day('2026-11-03'))).toBe(0);
    expect(P.activeStreak({ current: 0, best: 0, lastDay: null }, day('2026-11-03'))).toBe(0);
  });
});

describe('hearts', () => {
  it('start full, decrease to zero, refill', () => {
    let p = P.initialProgress();
    expect(P.heartsLeft(p, 'l')).toBe(3);
    for (let i = 0; i < 5; i++) p = P.loseHeart(p, 'l');
    expect(P.heartsLeft(p, 'l')).toBe(0);
    expect(P.heartsLeft(p, 'other')).toBe(3);
    p = P.refillHearts(p, 'l');
    expect(P.heartsLeft(p, 'l')).toBe(3);
  });
});

describe('completing missions', () => {
  it('adds XP, records the mission and touches the streak', () => {
    const { progress, reward } = P.completeMission(P.initialProgress(), mission('a'), stats(), day('2026-11-03'));
    expect(progress.xp).toBe(28);
    expect(progress.missions.a).toMatchObject({ bestXp: 28, completions: 1, noHints: true, onPar: true });
    expect(progress.streak.current).toBe(1);
    expect(reward).toMatchObject({ awarded: 28, previousBest: 0, levelBefore: 1, levelAfter: 1, firstCompletion: true });
  });
  it('replays only award the improvement', () => {
    let p = P.completeMission(P.initialProgress(), mission('a'), stats({ hintsUsed: 1, hintXpCost: 5, commands: 9 }), day('2026-11-03')).progress;
    expect(p.xp).toBe(15);
    const again = P.completeMission(p, mission('a'), stats({ hintsUsed: 1, hintXpCost: 5, commands: 9 }), day('2026-11-03'));
    expect(again.reward.awarded).toBe(0);
    const better = P.completeMission(again.progress, mission('a'), stats(), day('2026-11-03'));
    expect(better.reward.awarded).toBe(13);
    p = better.progress;
    expect(p.xp).toBe(28);
    expect(p.missions.a).toMatchObject({ bestXp: 28, completions: 3, noHints: true });
  });
  it('reports level ups', () => {
    const p = { ...P.initialProgress(), xp: 90 };
    expect(P.completeMission(p, mission('a'), stats(), day('2026-11-03')).reward).toMatchObject({ levelBefore: 1, levelAfter: 2 });
  });
});

describe('unlocking and skill tree', () => {
  const l1 = lesson('l1', [], [mission('m1'), mission('m2')]);
  const l2 = lesson('l2', ['l1'], [mission('m3')], 'files-permissions');
  const all = [l1, l2];
  const done = (p: P.ProgressState, id: string) => P.completeMission(p, mission(id), stats(), day('2026-11-03')).progress;

  it('unlocks lessons by prerequisites and missions in order', () => {
    let p = P.initialProgress();
    expect(P.isLessonUnlocked(p, l1, all)).toBe(true);
    expect(P.isLessonUnlocked(p, l2, all)).toBe(false);
    expect(P.isMissionUnlocked(p, l1, 0, all)).toBe(true);
    expect(P.isMissionUnlocked(p, l1, 1, all)).toBe(false);
    p = done(p, 'm1');
    expect(P.isMissionUnlocked(p, l1, 1, all)).toBe(true);
    expect(P.nextMissionIndex(p, l1)).toBe(1);
    p = done(p, 'm2');
    expect(P.isLessonComplete(p, l1)).toBe(true);
    expect(P.isLessonUnlocked(p, l2, all)).toBe(true);
    expect(P.nextMissionIndex(p, l1)).toBe(0);
  });

  it('builds every branch, grouped into tracks, with statuses', () => {
    let p = P.initialProgress();
    let tree = P.skillTree(p, all);
    const status = (id: string) => tree.find((b) => b.id === id)!.status;
    expect(tree.map((b) => b.id)).toEqual(P.BRANCHES.map((b) => b.id));
    expect(tree.every((b) => P.TRACKS.some((t) => t.id === b.track))).toBe(true);
    expect([status('linux-basics'), status('files-permissions'), status('processes')]).toEqual(['available', 'locked', 'coming-soon']);
    p = done(p, 'm1');
    tree = P.skillTree(p, all);
    expect(status('linux-basics')).toBe('in-progress');
    expect(tree.find((b) => b.id === 'linux-basics')!.lessons[0]).toMatchObject({ status: 'in-progress', done: 1, total: 2 });
    p = done(p, 'm2');
    tree = P.skillTree(p, all);
    expect([status('linux-basics'), status('files-permissions')]).toEqual(['complete', 'available']);
  });
});

describe('import / export', () => {
  it('round-trips', () => {
    const p = P.completeMission(P.loseHeart(P.initialProgress(), 'l1'), mission('a'), stats(), day('2026-11-03')).progress;
    expect(P.importProgress(P.exportProgress(p))).toEqual(p);
  });
  it('rejects invalid files with readable errors', () => {
    expect(() => P.importProgress('nope')).toThrow('not valid JSON');
    expect(() => P.importProgress('{"hello":1}')).toThrow('not a DevOps Quest progress file');
    const good = JSON.parse(P.exportProgress(P.initialProgress()));
    expect(() => P.importProgress(JSON.stringify({ ...good, version: 99 }))).toThrow('Unsupported progress version');
    expect(() => P.importProgress(JSON.stringify({ ...good, xp: -5 }))).toThrow('invalid "xp"');
    expect(() => P.importProgress(JSON.stringify({ ...good, hearts: { l: 7 } }))).toThrow('invalid hearts');
    expect(() => P.importProgress(JSON.stringify({ ...good, missions: { a: { bestXp: 'x' } } }))).toThrow('mission "a"');
    expect(() => P.importProgress(JSON.stringify({ ...good, streak: { current: 1, best: 1, lastDay: 'yesterday' } }))).toThrow(
      'invalid streak',
    );
  });
});

describe('progress store', () => {
  function memory() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  }

  it('persists progress and restores it in a new store', () => {
    const storage = memory();
    const a = createProgressStore(storage);
    const reward = a.getState().completeMission(mission('a'), stats(), day('2026-11-03'));
    expect(reward.awarded).toBe(28);
    expect(a.getState().loseHeart('l1')).toBe(2);
    expect(storage.data.get(STORAGE_KEY)).toContain('"xp":28');
    const b = createProgressStore(storage);
    expect(b.getState().progress.xp).toBe(28);
    expect(P.heartsLeft(b.getState().progress, 'l1')).toBe(2);
  });

  it('ignores corrupt saved data', () => {
    const storage = memory();
    storage.setItem(STORAGE_KEY, '{"state":{"progress":{"xp":"lots"}},"version":1}');
    expect(createProgressStore(storage).getState().progress).toEqual(P.initialProgress());
    storage.setItem(STORAGE_KEY, 'not json');
    expect(createProgressStore(storage).getState().progress).toEqual(P.initialProgress());
  });

  it('exports, imports and resets', () => {
    const store = createProgressStore(memory());
    store.getState().completeMission(mission('a'), stats(), day('2026-11-03'));
    expect(store.getState().progress.xp).toBe(28);
    const json = store.getState().exportJson();
    store.getState().reset();
    expect(store.getState().progress).toEqual(P.initialProgress());
    const t = createProgressStore(memory());
    t.getState().importJson(json);
    expect(t.getState().progress.xp).toBe(28);
    expect(() => t.getState().importJson('{}')).toThrow();
    expect(t.getState().progress.xp).toBe(28); // failed import leaves progress untouched
  });
});

describe('MissionSession failure', () => {
  it('fail() ends the attempt; later commands and checks change nothing', () => {
    const s = new MissionSession(mission('x'));
    s.fail();
    expect(s.status).toBe('failed');
    expect(s.run('touch x').events).toEqual([]);
    expect(s.check().passed).toBe(true); // reports the truth...
    expect(s.status).toBe('failed'); // ...but the attempt stays failed
    expect(s.stats.failedChecks).toBe(0);
    expect(s.hasMoreHints).toBe(false);
  });
});
