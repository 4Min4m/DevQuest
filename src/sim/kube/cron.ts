/** Standard 5-field cron schedules (as CronJobs use them), evaluated in UTC. */

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

function field(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    let lo = min;
    let hi = max;
    if (m[2] !== undefined) {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && max === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): Cron | null {
  const e = MACROS[expr.trim()] ?? expr.trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mo, dow] = parts;
  const sets = [field(mi, 0, 59), field(h, 0, 23), field(dom, 1, 31), field(mo, 1, 12), field(dow, 0, 7)];
  if (sets.some((x) => !x)) return null;
  return { minute: sets[0]!, hour: sets[1]!, dom: sets[2]!, month: sets[3]!, dow: sets[4]!, domStar: dom === '*', dowStar: dow === '*' };
}

function matches(c: Cron, d: Date): boolean {
  if (!c.minute.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()) || !c.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  if (c.domStar || c.dowStar) return domOk && dowOk;
  return domOk || dowOk;
}

/** Scheduled times in (from, to], at most `limit`. */
export function scheduleTimes(c: Cron, from: number, to: number, limit = 50): number[] {
  const out: number[] = [];
  let t = Math.floor(from / 60000) * 60000 + 60000;
  // Jump a whole day when the hour can't match, to keep long ranges cheap.
  while (t <= to && out.length < limit) {
    const d = new Date(t);
    if (!c.hour.has(d.getUTCHours())) {
      t = Math.floor(t / 3600000) * 3600000 + 3600000;
      continue;
    }
    if (matches(c, d)) out.push(t);
    t += 60000;
  }
  return out;
}
