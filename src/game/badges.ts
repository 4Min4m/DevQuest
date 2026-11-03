/** Badges: pure predicates over progress; earned ones are stored with a timestamp. */
import { isLessonComplete, levelInfo, ProgressState } from './progress';
import { totalReviews } from './review';
import type { Lesson } from './types';

export interface BadgeDef {
  id: string;
  title: string;
  description: string;
  icon: string;
  earned(p: ProgressState, lessons: Lesson[]): boolean;
}

const lessonDone = (id: string) => (p: ProgressState, lessons: Lesson[]) => {
  const l = lessons.find((x) => x.id === id);
  return !!l && isLessonComplete(p, l);
};

const LINUX = ['linux-basics', 'files-permissions', 'processes', 'text-processing'];

export const BADGES: BadgeDef[] = [
  { id: 'first-mission', title: 'First steps', description: 'Complete your first mission', icon: '🎯', earned: (p) => Object.keys(p.missions).length > 0 },
  {
    id: 'linux-graduate',
    title: 'Linux graduate',
    description: 'Complete every Linux branch',
    icon: '🐧',
    earned: (p, l) => LINUX.every((id) => lessonDone(id)(p, l)),
  },
  { id: 'container-captain', title: 'Container captain', description: 'Complete Docker Basics', icon: '🐳', earned: lessonDone('docker-basics') },
  { id: 'image-smith', title: 'Image smith', description: 'Complete Images & Dockerfile', icon: '📦', earned: lessonDone('images-dockerfile') },
  { id: 'conductor', title: 'Conductor', description: 'Complete Docker Compose', icon: '🧩', earned: lessonDone('compose') },
  { id: 'crashloop-fixer', title: 'CrashLoop fixer', description: 'Fix your first crash-looping container', icon: '🔁', earned: (p) => 'crashloop' in p.missions },
  {
    id: 'boss-slayer',
    title: 'Boss slayer',
    description: 'Beat every boss fight',
    icon: '☠️',
    earned: (p, l) => {
      const bosses = l.flatMap((x) => x.missions).filter((m) => m.type === 'boss');
      return bosses.length > 0 && bosses.every((m) => m.id in p.missions);
    },
  },
  { id: 'no-hints-10', title: 'Hint-free', description: 'Complete 10 missions without hints', icon: '🧠', earned: (p) => Object.values(p.missions).filter((m) => m.noHints).length >= 10 },
  { id: 'on-par-5', title: 'Efficient', description: 'Finish 5 missions within par', icon: '⚡', earned: (p) => Object.values(p.missions).filter((m) => m.onPar).length >= 5 },
  { id: 'streak-3', title: 'On a roll', description: 'Reach a 3-day streak', icon: '🔥', earned: (p) => p.streak.best >= 3 },
  { id: 'streak-7', title: 'Week warrior', description: 'Reach a 7-day streak', icon: '📆', earned: (p) => p.streak.best >= 7 },
  { id: 'perfect-lesson', title: 'Flawless', description: 'Finish a lesson without losing a heart', icon: '💯', earned: (p) => p.perfectLessons.length > 0 },
  { id: 'daily-3', title: 'Daily habit', description: 'Complete 3 daily missions', icon: '📅', earned: (p) => p.daily.count >= 3 },
  { id: 'reviewer-5', title: 'Total recall', description: 'Complete 5 recall challenges', icon: '🔄', earned: (p) => totalReviews(p) >= 5 },
  { id: 'interview-pass', title: 'Hired!', description: 'Pass an Interview Mode session', icon: '🎤', earned: (p) => p.interviews.passed > 0 },
  { id: 'level-5', title: 'Level 5', description: 'Reach level 5', icon: '⭐', earned: (p) => levelInfo(p.xp).level >= 5 },
];

/** Award any newly earned badges. Returns the updated progress and the new badges. */
export function awardBadges(p: ProgressState, lessons: Lesson[], now: Date): { progress: ProgressState; earned: BadgeDef[] } {
  const earned = BADGES.filter((b) => !(b.id in p.badges) && b.earned(p, lessons));
  if (!earned.length) return { progress: p, earned };
  const badges = { ...p.badges };
  for (const b of earned) badges[b.id] = now.toISOString();
  return { progress: { ...p, badges }, earned };
}
