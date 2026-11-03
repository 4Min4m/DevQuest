import { parse } from 'yaml';
import type { Lesson } from '../game/types';
import { assertCatalog, assertLesson } from './schema';

/** Lesson files are bundled at build time: no network access at runtime. */
const files = import.meta.glob('./lessons/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

export function parseLesson(yamlText: string, source: string): Lesson {
  return assertLesson(parse(yamlText), source);
}

/** All lessons, ordered by file name (01-, 02-, ...). */
export const lessons: Lesson[] = Object.keys(files)
  .sort()
  .map((path) => parseLesson(files[path], path));

assertCatalog(lessons);

export function findLesson(id: string): Lesson | undefined {
  return lessons.find((l) => l.id === id);
}
