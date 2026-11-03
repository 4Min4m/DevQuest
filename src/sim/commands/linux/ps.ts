import type { Process } from '../../state';
import type { CommandContext, CommandDef } from '../../shell/types';

const CURRENT_TTY = 'pts/0';

function longTime(t: string): string {
  const [m, s] = t.split(':').map(Number);
  const h = Math.floor(m / 60);
  return [h, m % 60, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function shortName(command: string): string {
  const first = command.split(' ')[0].replace(/^-/, '');
  return first.split('/').pop() ?? first;
}

/** The `ps` process itself shows up in its own output, just like on a real system. */
function selfProcess(ctx: CommandContext): Process {
  const pid = ctx.state.nextPid++;
  return {
    pid,
    ppid: 1001,
    user: ctx.state.user,
    command: ['ps', ...ctx.args].join(' '),
    tty: CURRENT_TTY,
    stat: 'R+',
    cpu: 0,
    mem: 0.0,
    vsz: 10072,
    rss: 3400,
    start: '09:00',
    time: '0:00',
  };
}

export const ps: CommandDef = {
  name: 'ps',
  summary: 'report a snapshot of the current processes',
  run(ctx) {
    const mode = ctx.args.join(' ');
    const all = [...ctx.state.processes, selfProcess(ctx)].sort((a, b) => a.pid - b.pid);
    if (mode === '') {
      ctx.out('    PID TTY          TIME CMD\n');
      for (const p of all.filter((p) => p.tty === CURRENT_TTY && p.user === ctx.state.user)) {
        ctx.out(`${String(p.pid).padStart(7)} ${p.tty.padEnd(8)} ${longTime(p.time)} ${shortName(p.command)}\n`);
      }
      return 0;
    }
    if (mode === 'aux' || mode === '-aux' || mode === 'ax' || mode === '-A' || mode === '-e') {
      if (mode === '-A' || mode === '-e') {
        ctx.out('    PID TTY          TIME CMD\n');
        for (const p of all) ctx.out(`${String(p.pid).padStart(7)} ${p.tty.padEnd(8)} ${longTime(p.time)} ${shortName(p.command)}\n`);
        return 0;
      }
      ctx.out('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n');
      for (const p of all) {
        ctx.out(
          `${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ` +
            `${String(p.vsz).padStart(6)} ${String(p.rss).padStart(5)} ${p.tty.padEnd(8)} ${p.stat.padEnd(4)} ` +
            `${p.start.padStart(5)} ${p.time.padStart(6)} ${p.command}\n`,
        );
      }
      return 0;
    }
    if (mode === '-ef' || mode === '-fe' || mode === '-e -f') {
      ctx.out('UID          PID    PPID  C STIME TTY          TIME CMD\n');
      for (const p of all) {
        ctx.out(
          `${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)} ${String(Math.round(p.cpu)).padStart(2)} ` +
            `${p.start.padStart(5)} ${p.tty.padEnd(8)} ${longTime(p.time)} ${p.command}\n`,
        );
      }
      return 0;
    }
    ctx.err(`ps: '${mode}' is not supported in devquest (supported: ps, ps aux, ps -ef, ps -e)\n`);
    return 1;
  },
};
