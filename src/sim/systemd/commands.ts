import type { CommandContext, CommandDef } from '../shell/types';
import { LoadedUnit, Systemd } from './manager';
import type { JournalEntry } from './types';
import { unitName } from './unitfile';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** "Tue 2026-11-03 09:00:01 UTC" */
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}

/** systemd's relative time: "45s", "2min 3s", "1h 5min", "3 days 2h". */
export function relative(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}min ${s % 60}s` : `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}min` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'}${h % 24 ? ` ${h % 24}h` : ''}`;
}

/** "Nov 03 09:00:01 devquest myapp[1234]: message" */
export function journalLine(e: JournalEntry, host: string): string {
  const d = new Date(e.time);
  return `${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${host} ${e.ident}[${e.pid}]: ${e.message}`;
}

function noSystemd(ctx: CommandContext): Systemd | number {
  if (!ctx.state.systemd || ctx.state.context) {
    ctx.err('System has not been booted with systemd as init system (PID 1). Can\'t operate.\nFailed to connect to bus: Host is down\n');
    return 1;
  }
  return new Systemd(ctx.state);
}

const isRoot = (ctx: CommandContext) => ctx.state.user === 'root';

function needRoot(ctx: CommandContext, verb: string, unit: string): boolean {
  if (isRoot(ctx)) return true;
  if (verb === 'reload-daemon') ctx.err('Failed to reload daemon: Interactive authentication required.\n');
  else {
    ctx.err(`Failed to ${verb} ${unit}: Interactive authentication required.\n`);
    if (verb !== 'enable' && verb !== 'disable') ctx.err(`See system logs and 'systemctl status ${unit}' for details.\n`);
  }
  return false;
}

function staleWarning(ctx: CommandContext, u: LoadedUnit): void {
  if (u.stale) {
    ctx.err(`Warning: The unit file, source configuration file or drop-ins of ${u.name} changed on disk. Run 'systemctl daemon-reload' to reload units.\n`);
  }
}

function statusBlock(ctx: CommandContext, sd: Systemd, u: LoadedUnit): void {
  const rt = u.runtime;
  const now = ctx.state.clock;
  const dot = rt.active === 'failed' ? '×' : rt.active === 'active' ? '●' : '○';
  const enabled = rt.enabled ? 'enabled' : 'disabled';
  ctx.out(`${dot} ${u.name} - ${u.config.description}\n`);
  ctx.out(`     Loaded: ${u.config.badSetting ? 'bad-setting' : 'loaded'} (${u.path}; ${enabled}; preset: enabled)\n`);
  if (u.config.badSetting) {
    ctx.out(`     Active: inactive (dead)\n\n`);
  } else if (rt.active === 'active') {
    ctx.out(`     Active: active (running) since ${stamp(rt.since)}; ${relative(now - rt.since)} ago\n`);
    const p = sd.mainProcess(u);
    const exe = u.config.execStart.split(/\s+/)[0];
    ctx.out(`   Main PID: ${rt.mainPid} (${exe.split('/').pop()})\n`);
    ctx.out(`      Tasks: ${p?.ports ? 7 : 1} (limit: 4620)\n`);
    ctx.out(`     Memory: ${((p?.rss ?? 4000) / 1024).toFixed(1)}M\n`);
    ctx.out(`        CPU: 120ms\n`);
    ctx.out(`     CGroup: /system.slice/${u.name}\n`);
    ctx.out(`             └─${rt.mainPid} ${u.config.execStart}\n`);
  } else if (rt.active === 'failed') {
    const status = rt.exitStatus === 203 ? '203/EXEC' : rt.exitStatus === 217 ? '217/USER' : `${rt.exitStatus ?? 1}/FAILURE`;
    ctx.out(`     Active: failed (Result: ${rt.result}) since ${stamp(rt.since)}; ${relative(now - rt.since)} ago\n`);
    if (rt.restarts) ctx.out(`   Duration: 41ms\n`);
    ctx.out(`    Process: ${rt.mainPid} ExecStart=${u.config.execStart} (code=exited, status=${status})\n`);
    ctx.out(`   Main PID: ${rt.mainPid} (code=exited, status=${status})\n`);
    ctx.out(`        CPU: 12ms\n`);
  } else {
    ctx.out(`     Active: inactive (dead)${rt.restarts || rt.mainPid ? ` since ${stamp(rt.since)}; ${relative(now - rt.since)} ago` : ''}\n`);
  }
  const lines = sd.journal([u.name]).slice(-10);
  if (lines.length) {
    ctx.out('\n');
    for (const e of lines) ctx.out(journalLine(e, ctx.state.hostname) + '\n');
  }
}

function lifecycle(ctx: CommandContext, sd: Systemd, verb: 'start' | 'stop' | 'restart', units: string[]): number {
  let code = 0;
  for (const raw of units) {
    const name = unitName(raw);
    if (!sd.unitPath(name)) {
      ctx.err(`Failed to ${verb} ${name}: Unit ${name} not found.\n`);
      code = 5;
      continue;
    }
    if (!needRoot(ctx, verb, name)) {
      code = 1;
      continue;
    }
    const before = sd.load(name)!;
    staleWarning(ctx, before);
    if (before.config.badSetting && verb !== 'stop') {
      ctx.err(`Failed to ${verb} ${name}: Unit ${name} has a bad unit file setting.\nSee system logs and 'systemctl status ${name}' for details.\n`);
      sd.log('systemd', 1, name, before.config.badSetting, 3);
      code = 1;
      continue;
    }
    // Type=simple: systemctl returns once the process is forked, even if it dies a moment later.
    if (verb === 'start') sd.start(name);
    else if (verb === 'stop') sd.stop(name);
    else sd.restart(name);
  }
  return code;
}

export const systemctl: CommandDef = {
  name: 'systemctl',
  summary: 'control systemd services (status, start, stop, enable, daemon-reload...)',
  run(ctx) {
    const sd = noSystemd(ctx);
    if (typeof sd === 'number') return sd;
    const flags = ctx.args.filter((a) => a.startsWith('-'));
    const args = ctx.args.filter((a) => !a.startsWith('-'));
    const [verb, ...units] = args;
    const all = flags.includes('--all') || flags.includes('-a');
    const now = flags.includes('--now');
    switch (verb) {
      case undefined:
      case 'list-units': {
        const failedOnly = flags.includes('--failed') || flags.includes('--state=failed');
        const rows = sd
          .allUnits()
          .map((n) => sd.load(n)!)
          .filter((u) => u && (all || u.runtime.active !== 'inactive'))
          .filter((u) => !failedOnly || u.runtime.active === 'failed');
        const w = Math.max(4, ...rows.map((u) => u.name.length));
        ctx.out(`  ${'UNIT'.padEnd(w)} LOAD   ACTIVE   SUB     DESCRIPTION\n`);
        for (const u of rows) {
          const mark = u.runtime.active === 'failed' ? '●' : ' ';
          ctx.out(`${mark} ${u.name.padEnd(w)} loaded ${u.runtime.active.padEnd(8)} ${u.runtime.sub.padEnd(7)} ${u.config.description}\n`);
        }
        ctx.out('\nLegend: LOAD   → Reflects whether the unit definition was properly loaded.\n');
        ctx.out('        ACTIVE → The high-level unit activation state, i.e. generalization of SUB.\n');
        ctx.out('        SUB    → The low-level unit activation state, values depend on unit type.\n\n');
        ctx.out(`${rows.length} loaded units listed.${all ? '' : ' Pass --all to see loaded but inactive units, too.'}\n`);
        return 0;
      }
      case 'status': {
        if (!units.length) {
          const failed = sd.allUnits().filter((n) => sd.load(n)?.runtime.active === 'failed').length;
          ctx.out(`● ${ctx.state.hostname}\n    State: ${failed ? 'degraded' : 'running'}\n    Units: ${sd.allUnits().length} loaded (incl. loaded aliases)\n     Jobs: 0 queued\n   Failed: ${failed} units\n`);
          return 0;
        }
        let code = 0;
        units.forEach((raw, i) => {
          const name = unitName(raw);
          const u = sd.unitPath(name) ? sd.load(name) : null;
          if (!u) {
            ctx.err(`Unit ${name} could not be found.\n`);
            code = 4;
            return;
          }
          staleWarning(ctx, u);
          if (i > 0) ctx.out('\n');
          statusBlock(ctx, sd, u);
          if (u.runtime.active !== 'active' && code === 0) code = 3;
        });
        return code;
      }
      case 'start':
      case 'stop':
      case 'restart': {
        if (!units.length) {
          ctx.err(`Too few arguments.\n`);
          return 1;
        }
        return lifecycle(ctx, sd, verb, units);
      }
      case 'reload': {
        const name = unitName(units[0] ?? '');
        const u = sd.load(name);
        if (!u) {
          ctx.err(`Failed to reload ${name}: Unit ${name} not found.\n`);
          return 5;
        }
        if (!needRoot(ctx, 'reload', name)) return 1;
        if (!u.config.execReload) {
          ctx.err(`Failed to reload ${name}: Job type reload is not applicable for unit ${name}.\n`);
          return 1;
        }
        sd.log('systemd', 1, name, `Reloading ${name} - ${u.config.description}...`);
        sd.log('systemd', 1, name, `Reloaded ${name} - ${u.config.description}.`);
        return 0;
      }
      case 'enable':
      case 'disable': {
        let code = 0;
        for (const raw of units) {
          const name = unitName(raw);
          const u = sd.load(name);
          if (!u) {
            ctx.err(`Failed to ${verb} unit: Unit file ${name} does not exist.\n`);
            code = 1;
            continue;
          }
          if (!needRoot(ctx, verb, name)) {
            code = 1;
            continue;
          }
          const target = u.config.wantedBy[0];
          if (verb === 'enable') {
            if (!target) {
              ctx.err(
                `The unit files have no installation config (WantedBy=, RequiredBy=, UpheldBy=,\nAlso=, or Alias= settings in the [Install] section, and DefaultInstance= for\ntemplate units). This means they are not meant to be enabled or disabled using systemctl.\n`,
              );
            } else if (!u.runtime.enabled) {
              ctx.out(`Created symlink /etc/systemd/system/${target}.wants/${name} → ${u.path}.\n`);
              u.runtime.enabled = true;
            }
            if (now) lifecycle(ctx, sd, 'start', [name]);
          } else {
            if (u.runtime.enabled) ctx.out(`Removed "/etc/systemd/system/${target ?? 'multi-user.target'}.wants/${name}".\n`);
            u.runtime.enabled = false;
            if (now) lifecycle(ctx, sd, 'stop', [name]);
          }
        }
        return code;
      }
      case 'is-active':
      case 'is-enabled':
      case 'is-failed': {
        let code = 0;
        for (const raw of units) {
          const name = unitName(raw);
          const u = sd.unitPath(name) ? sd.load(name) : null;
          if (verb === 'is-enabled') {
            if (!u) {
              ctx.err(`Failed to get unit file state for ${name}: No such file or directory\n`);
              code = 1;
              continue;
            }
            ctx.out((u.runtime.enabled ? 'enabled' : 'disabled') + '\n');
            if (!u.runtime.enabled) code = 1;
            continue;
          }
          const active = u?.runtime.active ?? 'inactive';
          ctx.out(active + '\n');
          if (verb === 'is-active' ? active !== 'active' : active !== 'failed') code = verb === 'is-active' ? 3 : 1;
        }
        return code;
      }
      case 'cat': {
        let code = 0;
        for (const raw of units) {
          const name = unitName(raw);
          const path = sd.unitPath(name);
          if (!path) {
            ctx.err(`No files found for ${name}.\n`);
            code = 1;
            continue;
          }
          const u = sd.load(name)!;
          staleWarning(ctx, u);
          ctx.out(`# ${path}\n${u.runtime.loadedSource ?? ''}`);
        }
        return code;
      }
      case 'daemon-reload':
        if (!needRoot(ctx, 'reload-daemon', '')) return 1;
        sd.daemonReload();
        return 0;
      case 'reset-failed':
        if (!needRoot(ctx, 'reset-failed', units[0] ?? '')) return 1;
        for (const n of units.length ? units.map(unitName) : sd.allUnits()) {
          const u = sd.load(n);
          if (u && u.runtime.active === 'failed') {
            u.runtime.active = 'inactive';
            u.runtime.sub = 'dead';
            u.runtime.restarts = 0;
          }
        }
        return 0;
      default:
        ctx.err(`Unknown command verb '${verb}'.\n(devquest supports: status, start, stop, restart, reload, enable, disable, is-active, is-enabled, is-failed, cat, daemon-reload, list-units, reset-failed)\n`);
        return 1;
    }
  },
};

export const journalctl: CommandDef = {
  name: 'journalctl',
  summary: 'show the systemd journal (-u UNIT, -n N, -p err, -xe)',
  run(ctx) {
    const sd = noSystemd(ctx);
    if (typeof sd === 'number') return sd;
    const units: string[] = [];
    let lines: number | null = null;
    let maxPrio = 7;
    let follow = false;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-u' || a === '--unit') units.push(unitName(args[++i] ?? ''));
      else if (a.startsWith('--unit=')) units.push(unitName(a.slice(7)));
      else if (a === '-n' || a === '--lines') lines = Number(args[++i]);
      else if (/^-n\d+$/.test(a)) lines = Number(a.slice(2));
      else if (a === '-p' || a === '--priority') {
        const v = args[++i] ?? '';
        const map: Record<string, number> = { emerg: 0, alert: 1, crit: 2, err: 3, warning: 4, notice: 5, info: 6, debug: 7 };
        maxPrio = map[v] ?? Number(v);
      } else if (a === '-f' || a === '--follow') follow = true;
      else if (a === '--since' || a === '--until' || a === '-S' || a === '-U') i++;
      else if (/^-[xebq]+$/.test(a) || a === '--no-pager') {
        if (a.includes('e') && lines === null) lines = 1000;
      } else if (/^-[xe]*u$/.test(a)) units.push(unitName(args[++i] ?? ''));
      else {
        ctx.err(`journalctl: devquest supports -u UNIT, -n N, -p PRIORITY, -f, -x, -e, --since/--until (got ${a})\n`);
        return 1;
      }
    }
    let entries = sd.journal(units).filter((e) => e.priority <= maxPrio);
    if (lines !== null) entries = entries.slice(-lines);
    if (!entries.length) {
      ctx.out('-- No entries --\n');
      return 0;
    }
    for (const e of entries) ctx.out(journalLine(e, ctx.state.hostname) + '\n');
    if (follow) ctx.note('devquest: -f (follow) is not supported; showing the journal so far\n');
    return 0;
  },
};
