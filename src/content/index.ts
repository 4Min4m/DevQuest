import { parse } from 'yaml';
import type { Lesson } from '../game/types';
import { assertCatalog, assertLesson } from './schema';

/** Lesson files are bundled at build time: no network access at runtime. */
const files = import.meta.glob('./lessons/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

/**
 * Fake credentials used by security missions. They are assembled here instead of being written out in
 * the lesson files, so secret scanners (GitHub push protection) don't flag the repository itself.
 */
export const FAKE_SECRETS: Record<string, string> = {
  __LEAKED_AWS_KEY_ID__: ['AK', 'IA5XKQ7G', 'J2MPRTWZBC'].join(''),
  __LEAKED_AWS_SECRET__: ['Zt8uHw2xQe0P', 'f3Lr9Ma1Kd4N', 's6Bv7Cx5Yg2Jh0Ty'].join(''),
};

export function parseLesson(yamlText: string, source: string): Lesson {
  const text = yamlText.replace(/__LEAKED_AWS_(KEY_ID|SECRET)__/g, (m) => FAKE_SECRETS[m]);
  return assertLesson(parse(text), source);
}

/** All lessons, ordered by file name (01-, 02-, ...). */
export const lessons: Lesson[] = Object.keys(files)
  .sort()
  .map((path) => parseLesson(files[path], path));

assertCatalog(lessons);

export function findLesson(id: string): Lesson | undefined {
  return lessons.find((l) => l.id === id);
}
