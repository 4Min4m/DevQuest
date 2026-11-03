import { useEffect, useState } from 'react';

/** Tiny hash router: works on any static host (GitHub Pages, Cloudflare Pages) and survives refresh. */
export type Route =
  | { view: 'tree' }
  | { view: 'profile' }
  | { view: 'sandbox' }
  | { view: 'interview' }
  | { view: 'review'; missionId: string }
  | { view: 'lesson'; lessonId: string; mission: number };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'profile') return { view: 'profile' };
  if (parts[0] === 'sandbox') return { view: 'sandbox' };
  if (parts[0] === 'interview') return { view: 'interview' };
  if (parts[0] === 'review' && parts[1]) return { view: 'review', missionId: parts[1] };
  if (parts[0] === 'lesson' && parts[1]) {
    const n = Number(parts[2] ?? '1');
    return { view: 'lesson', lessonId: parts[1], mission: Number.isInteger(n) && n >= 1 ? n - 1 : 0 };
  }
  return { view: 'tree' };
}

export function routeHash(r: Route): string {
  if (r.view === 'profile') return '#/profile';
  if (r.view === 'sandbox') return '#/sandbox';
  if (r.view === 'interview') return '#/interview';
  if (r.view === 'review') return `#/review/${encodeURIComponent(r.missionId)}`;
  if (r.view === 'lesson') return `#/lesson/${encodeURIComponent(r.lessonId)}/${r.mission + 1}`;
  return '#/tree';
}

export function navigate(r: Route): void {
  window.location.hash = routeHash(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
