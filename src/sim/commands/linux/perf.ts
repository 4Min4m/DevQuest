import type { Process, SimState } from '../../state';
import type { CommandContext, CommandDef } from '../../shell/types';

const DEFAULT_PERF = {
  cpus: 1,
  load: [0, 0, 0] as [number, number, number],
  uptimeSec: 60,
  memTotalKb: 1024000,
  memUsedKb: 102400,
  memBuffCacheKb: 204800,
  swapTotalKb: 0,
  swapUsedKb: 0,
  cpu: { us: 0, sy: 0, id: 100, wa: 0 },
};

const perfOf = (state: SimState) => state.perf ?? DEFAULT_PERF;

function clockTime(ms: number): string {
  const d = new Date(ms);
  return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function upText(sec: number): string {
  const days = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const hm = h ? `${String(h).padStart(2)}:${String(m).padStart(2, '0')}` : `${m} min`;
  return days ? `${days} day${days === 1 ? '' : 's'}, ${hm}` : hm;
}

const loadText = (l: number[]) => l.map((n) => n.toFixed(2)).join(', ');

function procName(cmd: string): string {
  const first = cmd.split(/\s+/)[0].replace(/^-/, '').replace(/:$/, '');
  return first.split('/').pop() ?? first;
}

/** Processes this user may inspect (non-root can't see other users' fds). */
const visible = (ctx: CommandContext, p: Process) => ctx.state.user === 'root' || p.user === ctx.state.user;

function memNumbers(state: SimState) {
  const p = perfOf(state);
  const free = Math.max(0, p.memTotalKb - p.memUsedKb - p.memBuffCacheKb);
  // "available" estimates what new programs can get: free + most of the reclaimable cache.
  const available = Math.min(p.memTotalKb, free + Math.round(p.memBuffCacheKb * 0.97));
  return { ...p, free, available, shared: 1200 };
}

function human(kb: number): string {
  const units = ['Ki', 'Mi', 'Gi', 'Ti'];
  let v = kb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (kb === 0) return '0B';
  if (i === 0) return `${Math.round(v)}${units[0]}`;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

// ------------------------------------------------------------------ uptime / nproc

export const uptime: CommandDef = {
  name: 'uptime',
  summary: 'how long the system has been running, and the load averages',
  run(ctx) {
    const p = perfOf(ctx.state);
    if (ctx.args.includes('-p')) {
      let s = p.uptimeSec;
      const parts: string[] = [];
      const add = (n: number, unit: string) => n && parts.push(`${n} ${unit}${n === 1 ? '' : 's'}`);
      add(Math.floor(s / 604800), 'week');
      s %= 604800;
      add(Math.floor(s / 86400), 'day');
      s %= 86400;
      add(Math.floor(s / 3600), 'hour');
      s %= 3600;
      add(Math.floor(s / 60), 'minute');
      ctx.out(`up ${parts.join(', ') || '0 minutes'}\n`);
      return 0;
    }
    if (ctx.args.length) {
      ctx.err(`uptime: invalid option -- '${ctx.args[0].replace(/^-+/, '')}'\nTry 'uptime --help' for more information.\n`);
      return 1;
    }
    ctx.out(` ${clockTime(ctx.state.clock)} up ${upText(p.uptimeSec)},  1 user,  load average: ${loadText(p.load)}\n`);
    return 0;
  },
};

export const nproc: CommandDef = {
  name: 'nproc',
  summary: 'print the number of processing units',
  run(ctx) {
    ctx.out(`${perfOf(ctx.state).cpus}\n`);
    return 0;
  },
};

// ------------------------------------------------------------------ memory

export const free: CommandDef = {
  name: 'free',
  summary: 'display amount of free and used memory (-h, -m)',
  run(ctx) {
    let fmt: (kb: number) => string = (kb) => String(kb);
    for (const a of ctx.args) {
      if (a === '-h' || a === '--human') fmt = human;
      else if (a === '-m' || a === '--mega') fmt = (kb) => String(Math.floor(kb / 1024));
      else if (a === '-g' || a === '--giga') fmt = (kb) => String(Math.floor(kb / 1048576));
      else if (a === '-k' || a === '--kilo' || a === '-w' || a === '--wide' || a === '-t') continue;
      else {
        ctx.err(`free: invalid option -- '${a.replace(/^-+/, '')}'\n\nUsage:\n free [options]\n`);
        return 1;
      }
    }
    const m = memNumbers(ctx.state);
    const col = (v: string) => v.padStart(12);
    let out = `${' '.repeat(15)}total        used        free      shared  buff/cache   available\n`;
    out += `Mem:  ${col(fmt(m.memTotalKb))}${col(fmt(m.memUsedKb))}${col(fmt(m.free))}${col(fmt(m.shared))}${col(fmt(m.memBuffCacheKb))}${col(fmt(m.available))}\n`;
    out += `Swap: ${col(fmt(m.swapTotalKb))}${col(fmt(m.swapUsedKb))}${col(fmt(m.swapTotalKb - m.swapUsedKb))}\n`;
    ctx.out(out);
    return 0;
  },
};

// ------------------------------------------------------------------ top / vmstat

export const top: CommandDef = {
  name: 'top',
  summary: 'one snapshot of system load and the busiest processes',
  run(ctx) {
    let sortKey: 'cpu' | 'mem' = 'cpu';
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '-o') sortKey = /MEM/i.test(ctx.args[++i] ?? '') ? 'mem' : 'cpu';
      else if (a === '-n' || a === '-d' || a === '-p' || a === '-u') i++;
      else if (a === '-b' || a === '-c' || /^-bn\d+$/.test(a) || /^-n\d+$/.test(a)) continue;
      else {
        ctx.err(`top: unknown option '${a.replace(/^-+/, '')}'\n`);
        return 1;
      }
    }
    const p = perfOf(ctx.state);
    const m = memNumbers(ctx.state);
    const procs = [...ctx.state.processes];
    const running = procs.filter((q) => q.stat.startsWith('R')).length + 1;
    const zombie = procs.filter((q) => q.stat.startsWith('Z')).length;
    const stopped = procs.filter((q) => q.stat.startsWith('T')).length;
    const mib = (kb: number) => (kb / 1024).toFixed(1).padStart(8);
    let out = `top - ${clockTime(ctx.state.clock)} up ${upText(p.uptimeSec)},  1 user,  load average: ${loadText(p.load)}\n`;
    out += `Tasks: ${String(procs.length + 1).padStart(3)} total, ${String(running).padStart(3)} running, ${String(procs.length + 1 - running - zombie - stopped).padStart(3)} sleeping, ${String(stopped).padStart(3)} stopped, ${String(zombie).padStart(3)} zombie\n`;
    const f = (n: number) => n.toFixed(1).padStart(5);
    out += `%Cpu(s):${f(p.cpu.us)} us,${f(p.cpu.sy)} sy,  0.0 ni,${f(p.cpu.id)} id,${f(p.cpu.wa)} wa,  0.0 hi,  0.0 si,  0.0 st\n`;
    out += `MiB Mem : ${mib(m.memTotalKb)} total, ${mib(m.free)} free, ${mib(m.memUsedKb)} used, ${mib(m.memBuffCacheKb)} buff/cache\n`;
    out += `MiB Swap: ${mib(m.swapTotalKb)} total, ${mib(m.swapTotalKb - m.swapUsedKb)} free, ${mib(m.swapUsedKb)} used. ${mib(m.available)} avail Mem\n\n`;
    out += '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n';
    procs.sort((a, b) => (sortKey === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem) || a.pid - b.pid);
    for (const q of procs) {
      const [mm, ss] = q.time.split(':');
      out += `${String(q.pid).padStart(7)} ${q.user.slice(0, 8).padEnd(8)}  20   0 ${String(q.vsz).padStart(7)} ${String(q.rss).padStart(6)} ${String(Math.round(q.rss * 0.6)).padStart(6)} ${q.stat[0]} ${q.cpu.toFixed(1).padStart(5)} ${q.mem.toFixed(1).padStart(5)} ${`${mm}:${ss}.00`.padStart(9)} ${procName(q.command)}\n`;
    }
    ctx.out(out);
    ctx.note('devquest: top shows a single snapshot here (like top -bn1); press q is not needed\n');
    return 0;
  },
};

export const vmstat: CommandDef = {
  name: 'vmstat',
  summary: 'report virtual memory, I/O and CPU statistics',
  run(ctx) {
    const nums = ctx.args.filter((a) => !a.startsWith('-'));
    if (nums.some((n) => !/^\d+$/.test(n))) {
      ctx.err(`vmstat: Invalid argument\n`);
      return 1;
    }
    const count = nums.length >= 2 ? Number(nums[1]) : 1;
    const p = perfOf(ctx.state);
    const m = memNumbers(ctx.state);
    const buff = Math.round(m.memBuffCacheKb * 0.05);
    const cache = m.memBuffCacheKb - buff;
    const r = Math.max(0, Math.round(p.load[0]));
    const b = p.cpu.wa > 20 ? Math.max(1, Math.round(p.cpu.wa / 15)) : 0;
    const bo = p.cpu.wa > 20 ? 48210 : 12;
    let out = 'procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n';
    out += ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n';
    for (let i = 0; i < count; i++) {
      out += `${String(r).padStart(2)} ${String(b).padStart(2)} ${String(m.swapUsedKb).padStart(6)} ${String(m.free).padStart(6)} ${String(buff).padStart(6)} ${String(cache).padStart(6)}    0    0 ${String(i ? 0 : 3).padStart(5)} ${String(i ? bo : 12).padStart(5)} ${String(45 + i).padStart(4)} ${String(80 + i * 3).padStart(4)} ${String(Math.round(p.cpu.us)).padStart(2)} ${String(Math.round(p.cpu.sy)).padStart(2)} ${String(Math.round(p.cpu.id)).padStart(2)} ${String(Math.round(p.cpu.wa)).padStart(2)}  0\n`;
    }
    ctx.out(out);
    return 0;
  },
};

// ------------------------------------------------------------------ pgrep / lsof

export const pgrep: CommandDef = {
  name: 'pgrep',
  summary: 'find process IDs by name (-a: with command line, -f: match full command)',
  run(ctx) {
    let full = false;
    let listName = false;
    let listFull = false;
    let user: string | undefined;
    let pattern: string | undefined;
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '-u') user = ctx.args[++i];
      else if (/^-[falx]+$/.test(a)) {
        if (a.includes('f')) full = true;
        if (a.includes('l')) listName = true;
        if (a.includes('a')) listFull = true;
      } else if (a.startsWith('-')) {
        ctx.err(`pgrep: invalid option -- '${a.slice(1)}'\nUsage:\n pgrep [options] <pattern>\n`);
        return 2;
      } else pattern = a;
    }
    if (!pattern && !user) {
      ctx.err('pgrep: no matching criteria specified\nTry `pgrep --help\' for more information.\n');
      return 2;
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern ?? '');
    } catch {
      ctx.err(`pgrep: invalid regex: ${pattern}\n`);
      return 2;
    }
    const hits = ctx.state.processes.filter((p) => (!user || p.user === user) && re.test(full ? p.command : procName(p.command)));
    for (const p of hits) ctx.out(listFull ? `${p.pid} ${p.command}\n` : listName ? `${p.pid} ${procName(p.command)}\n` : `${p.pid}\n`);
    return hits.length ? 0 : 1;
  },
};

interface LsofRow {
  p: Process;
  fd: string;
  type: string;
  size: string;
  node: string;
  name: string;
  port?: number;
}

const SERVICE_NAMES: Record<number, string> = { 22: 'ssh', 80: 'http', 443: 'https', 5432: 'postgresql', 6379: 'redis', 8080: 'http-alt' };

function lsofRows(p: Process, numericPorts: boolean): LsofRow[] {
  const rows: LsofRow[] = [
    { p, fd: 'cwd', type: 'DIR', size: '4096', node: '2', name: '/' },
    { p, fd: 'rtd', type: 'DIR', size: '4096', node: '2', name: '/' },
    { p, fd: 'txt', type: 'REG', size: '1265648', node: String(1000 + (p.pid % 997)), name: p.command.split(/\s+/).find((w) => w.startsWith('/')) ?? `/usr/bin/${procName(p.command)}` },
  ];
  let fd = 3;
  for (const f of p.files ?? []) rows.push({ p, fd: `${fd++}w`, type: 'REG', size: '0', node: String(4000 + fd), name: f });
  for (const port of p.ports ?? []) {
    rows.push({ p, port, fd: `${fd++}u`, type: 'IPv4', size: '0t0', node: 'TCP', name: `*:${numericPorts ? port : SERVICE_NAMES[port] ?? port} (LISTEN)` });
  }
  return rows;
}

export const lsof: CommandDef = {
  name: 'lsof',
  summary: 'list open files (-i :PORT who listens on a port, -p PID files of a process)',
  run(ctx) {
    let inet: string | null = null;
    let pid: number | null = null;
    let numericPorts = false;
    const paths: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '-i') inet = ctx.args[i + 1] && !ctx.args[i + 1].startsWith('-') ? ctx.args[++i] : '';
      else if (a.startsWith('-i') && a.length > 2) inet = a.slice(2);
      else if (a === '-p') pid = Number(ctx.args[++i]);
      else if (a === '-P' || a === '-nP' || a === '-Pn') numericPorts = true;
      else if (a === '-n') continue;
      else if (a.startsWith('-')) {
        ctx.err(`lsof: unsupported option in devquest: ${a} (try -i :PORT, -p PID, or a path)\n`);
        return 1;
      } else paths.push(ctx.resolve(a));
    }
    if (inet !== null) numericPorts = numericPorts || /\d/.test(inet);
    let rows = ctx.state.processes.filter((p) => visible(ctx, p)).flatMap((p) => lsofRows(p, numericPorts));
    if (inet !== null) {
      const m = /^(?:tcp|TCP)?:?(\d+)?$/.exec(inet);
      if (!m) {
        ctx.err(`lsof: unacceptable Internet address: ${inet}\n`);
        return 1;
      }
      rows = rows.filter((r) => r.port !== undefined && (!m[1] || r.port === Number(m[1])));
    }
    if (pid !== null) rows = rows.filter((r) => r.p.pid === pid);
    if (paths.length) rows = rows.filter((r) => paths.some((p) => r.name === p || r.name.startsWith(p + '/') || r.name.startsWith(p + ' ')));
    if (!rows.length) return 1;
    let out = 'COMMAND   PID     USER   FD   TYPE DEVICE SIZE/OFF    NODE NAME\n';
    for (const r of rows) {
      out += `${procName(r.p.command).slice(0, 9).padEnd(9)} ${String(r.p.pid).padStart(5)} ${r.p.user.padStart(8)} ${r.fd.padStart(4)} ${r.type.padStart(6)} ${(r.type === 'IPv4' ? '18920' : '8,1').padStart(6)} ${r.size.padStart(8)} ${r.node.padStart(7)} ${r.name}\n`;
    }
    ctx.out(out);
    return 0;
  },
};

// ------------------------------------------------------------------ ulimit (bash builtin)

export const ulimit: CommandDef = {
  name: 'ulimit',
  summary: 'show or set shell resource limits (ulimit -n: open files)',
  run(ctx) {
    const lim = (ctx.state.limits ??= { nofileSoft: 1024, nofileHard: 1048576 });
    let soft = false;
    let hard = false;
    let all = false;
    let value: string | undefined;
    for (const a of ctx.args) {
      if (/^-[SHna]+$/.test(a)) {
        if (a.includes('S')) soft = true;
        if (a.includes('H')) hard = true;
        if (a.includes('a')) all = true;
      } else if (a.startsWith('-')) {
        ctx.err(`bash: ulimit: ${a}: invalid option\nulimit: usage: ulimit [-SHabcdefiklmnpqrstuvxPRT] [limit]\n`);
        return 2;
      } else value = a;
    }
    const show = (n: number) => (n === Infinity ? 'unlimited' : String(n));
    if (all) {
      const nofile = hard && !soft ? lim.nofileHard : lim.nofileSoft;
      ctx.out(
        [
          'real-time non-blocking time  (microseconds, -R) unlimited',
          'core file size              (blocks, -c) 0',
          'data seg size               (kbytes, -d) unlimited',
          'file size                   (blocks, -f) unlimited',
          'max locked memory           (kbytes, -l) 8192',
          'max memory size             (kbytes, -m) unlimited',
          `open files                          (-n) ${show(nofile)}`,
          'pipe size                (512 bytes, -p) 8',
          'stack size                  (kbytes, -s) 8192',
          'cpu time                   (seconds, -t) unlimited',
          'max user processes                  (-u) 15421',
          'virtual memory              (kbytes, -v) unlimited',
        ].join('\n') + '\n',
      );
      return 0;
    }
    if (value === undefined) {
      ctx.out(`${show(hard && !soft ? lim.nofileHard : lim.nofileSoft)}\n`);
      return 0;
    }
    const n = value === 'unlimited' ? Infinity : Number(value);
    if (!Number.isInteger(n) && n !== Infinity) {
      ctx.err(`bash: ulimit: ${value}: invalid number\n`);
      return 1;
    }
    // Without -S/-H, bash sets both limits.
    const setSoft = soft || !hard;
    const setHard = hard || !soft;
    const root = ctx.state.user === 'root';
    if ((setHard && n > lim.nofileHard && !root) || (setSoft && !setHard && n > lim.nofileHard)) {
      ctx.err(`bash: ulimit: open files: cannot modify limit: ${setHard && !root ? 'Operation not permitted' : 'Invalid argument'}\n`);
      return 1;
    }
    if (setHard) lim.nofileHard = n;
    if (setSoft) lim.nofileSoft = n;
    return 0;
  },
};

export const perfCommands: CommandDef[] = [uptime, nproc, free, top, vmstat, pgrep, lsof, ulimit];
