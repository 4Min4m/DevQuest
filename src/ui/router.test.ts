import { describe, expect, it } from 'vitest';
import { parseHash, routeHash } from './router';

describe('hash router', () => {
  it('parses routes', () => {
    expect(parseHash('')).toEqual({ view: 'tree' });
    expect(parseHash('#/tree')).toEqual({ view: 'tree' });
    expect(parseHash('#/profile')).toEqual({ view: 'profile' });
    expect(parseHash('#/sandbox')).toEqual({ view: 'sandbox' });
    expect(parseHash('#/lesson/processes/2')).toEqual({ view: 'lesson', lessonId: 'processes', mission: 1 });
    expect(parseHash('#/lesson/processes')).toEqual({ view: 'lesson', lessonId: 'processes', mission: 0 });
    expect(parseHash('#/lesson/x/abc')).toEqual({ view: 'lesson', lessonId: 'x', mission: 0 });
    expect(parseHash('#/nonsense')).toEqual({ view: 'tree' });
  });
  it('round-trips', () => {
    for (const r of [{ view: 'tree' }, { view: 'profile' }, { view: 'lesson', lessonId: 'a b', mission: 3 }] as const) {
      expect(parseHash(routeHash(r))).toEqual(r);
    }
  });
});
