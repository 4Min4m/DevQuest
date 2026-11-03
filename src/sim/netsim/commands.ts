import type { CommandDef } from '../shell/types';
import type { Process, SimState } from '../state';
import { dnsLookup, isIp, isLocalIp, pingable, remoteFor, resolveHost } from './resolve';
import type { DnsRecord, RecordType } from './types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SERVICES: Record<number, string> = { 22: 'ssh', 53: 'domain', 80: 'http', 443: 'https', 3306: 'mysql', 5432: 'postgresql', 6379: 'redis', 8080: 'http-alt', 9090: 'websm' };
const TYPES: RecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'PTR'];

const dot = (n: string) => (n.endsWith('.') ? n : n + '.');

/** Small deterministic jitter so repeated pings look real but tests stay stable. */
function jitter(base: number, i: number): number {
  return Math.round((base + ((i * 37) % 10) / 20 - 0.2) * 1000) / 1000;
}

// ------------------------------------------------------------------ DNS

function recordValue(r: DnsRecord): string {
  return r.type === 'CNAME' || r.type === 'NS' || r.type === 'PTR' ? dot(r.value) : r.type === 'MX' && !r.value.endsWith('.') ? dot(r.value) : r.value;
}

function reverseName(ip: string): string {
  return ip.split('.').reverse().join('.') + '.in-addr.arpa';
}

function serverOk(state: SimState, server: string): boolean {
  return (state.net?.nameservers ?? []).includes(server);
}

function whenStamp(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
}

export const dig: CommandDef = {
  name: 'dig',
  summary: 'DNS lookup (asks the DNS server directly; ignores /etc/hosts)',
  run(ctx) {
    const net = ctx.state.net;
    let name: string | undefined;
    let type: RecordType | 'ANY' = 'A';
    let server = net?.resolver ?? '127.0.0.53';
    let short = false;
    let typeGiven = false;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('@')) server = a.slice(1);
      else if (a === '+short') short = true;
      else if (a === '-x') {
        const ip = args[++i];
        if (!ip || !isIp(ip)) {
          ctx.err(`Invalid IP address ${ip ?? ''}\n`);
          return 1;
        }
        name = reverseName(ip);
        type = 'PTR';
        typeGiven = true;
      } else if (a === '-t') {
        type = (args[++i] ?? 'A').toUpperCase() as RecordType | 'ANY';
        typeGiven = true;
      } else if (a.startsWith('+')) {
        if (!['+noall', '+answer', '+nocmd', '+nostats', '+trace'].includes(a)) continue;
        if (a === '+trace') {
          ctx.err('devquest: dig +trace is not simulated; the resolution steps are: root → TLD → authoritative nameserver\n');
          return 1;
        }
      } else if (!name) name = a;
      else if (!typeGiven && [...TYPES, 'ANY'].includes(a.toUpperCase())) {
        type = a.toUpperCase() as RecordType | 'ANY';
        typeGiven = true;
      } else {
        ctx.err(`devquest: dig supports NAME [TYPE] [@SERVER] [+short] [-x IP] (got '${a}')\n`);
        return 1;
      }
    }
    if (!name) name = '.';
    const header = `; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ${ctx.args.join(' ')}`;
    if (!serverOk(ctx.state, server)) {
      ctx.out(`;; communications error to ${server}#53: timed out\n`.repeat(3));
      if (!short) ctx.out(`\n${header}\n; (1 server found)\n;; global options: +cmd\n`);
      ctx.out(';; no servers could be reached\n');
      return 9;
    }
    const types: RecordType[] = type === 'ANY' ? TYPES : [type];
    let chain: DnsRecord[] = [];
    const answers: DnsRecord[] = [];
    let exists = false;
    for (const t of types) {
      const r = dnsLookup(ctx.state, name, t);
      if (r) {
        exists = true;
        if (!chain.length) chain = r.chain;
        answers.push(...r.answers);
      }
    }
    const all = [...chain, ...answers.filter((a) => !chain.includes(a))];
    if (short) {
      for (const r of all) ctx.out(recordValue(r) + '\n');
      return 0;
    }
    const status = exists ? 'NOERROR' : 'NXDOMAIN';
    const id = 4242 + name.length * 7;
    let out = `\n${header}\n;; global options: +cmd\n;; Got answer:\n`;
    out += `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: ${id}\n`;
    out += `;; flags: qr rd ra; QUERY: 1, ANSWER: ${all.length}, AUTHORITY: 0, ADDITIONAL: 1\n\n`;
    out += ';; OPT PSEUDOSECTION:\n; EDNS: version: 0, flags:; udp: 65494\n';
    out += `;; QUESTION SECTION:\n;${dot(name)}\t\t\tIN\t${type}\n\n`;
    if (all.length) {
      out += ';; ANSWER SECTION:\n';
      for (const r of all) out += `${dot(r.name)}\t\t${r.ttl}\tIN\t${r.type}\t${recordValue(r)}\n`;
      out += '\n';
    }
    out += `;; Query time: ${8 + (name.length % 9)} msec\n;; SERVER: ${server}#53(${server}) (UDP)\n;; WHEN: ${whenStamp(ctx.state.clock)}\n;; MSG SIZE  rcvd: ${40 + all.length * 16}\n\n`;
    ctx.out(out);
    return 0;
  },
};

export const nslookup: CommandDef = {
  name: 'nslookup',
  summary: 'query DNS for a name',
  run(ctx) {
    const [name, srv] = ctx.args;
    if (!name) {
      ctx.err('devquest: interactive nslookup is not supported; use nslookup NAME [SERVER]\n');
      return 1;
    }
    const server = srv ?? ctx.state.net?.resolver ?? '127.0.0.53';
    if (!serverOk(ctx.state, server)) {
      ctx.out(`;; communications error to ${server}#53: timed out\n`.repeat(3) + ';; no servers could be reached\n\n');
      return 1;
    }
    ctx.out(`Server:\t\t${server}\nAddress:\t${server}#53\n\n`);
    if (isIp(name)) {
      const r = dnsLookup(ctx.state, reverseName(name), 'PTR');
      if (!r?.answers.length) {
        ctx.out(`** server can't find ${reverseName(name)}: NXDOMAIN\n\n`);
        return 1;
      }
      ctx.out(`Non-authoritative answer:\n${reverseName(name)}\tname = ${dot(r.answers[0].value)}\n\nAuthoritative answers can be found from:\n\n`);
      return 0;
    }
    const a = dnsLookup(ctx.state, name, 'A');
    const aaaa = dnsLookup(ctx.state, name, 'AAAA');
    if (!a && !aaaa) {
      ctx.out(`** server can't find ${name}: NXDOMAIN\n\n`);
      return 1;
    }
    let out = 'Non-authoritative answer:\n';
    for (const c of a?.chain ?? []) out += `${c.name}\tcanonical name = ${dot(c.value)}\n`;
    for (const r of [...(a?.answers ?? []), ...(aaaa?.answers ?? [])]) out += `Name:\t${r.name}\nAddress: ${r.value}\n`;
    ctx.out(out + '\n');
    return 0;
  },
};

export const host: CommandDef = {
  name: 'host',
  summary: 'DNS lookup utility',
  run(ctx) {
    const name = ctx.args.find((a) => !a.startsWith('-'));
    if (!name) {
      ctx.err('Usage: host [-t type] hostname [server]\n');
      return 1;
    }
    if (isIp(name)) {
      const r = dnsLookup(ctx.state, reverseName(name), 'PTR');
      if (!r?.answers.length) {
        ctx.out(`Host ${reverseName(name)} not found: 3(NXDOMAIN)\n`);
        return 1;
      }
      ctx.out(`${reverseName(name)} domain name pointer ${dot(r.answers[0].value)}\n`);
      return 0;
    }
    const a = dnsLookup(ctx.state, name, 'A');
    if (!a) {
      ctx.out(`Host ${name} not found: 3(NXDOMAIN)\n`);
      return 1;
    }
    for (const c of a.chain) ctx.out(`${c.name} is an alias for ${dot(c.value)}\n`);
    const target = a.chain.length ? a.chain[a.chain.length - 1].value : name;
    for (const r of a.answers) ctx.out(`${target} has address ${r.value}\n`);
    for (const r of dnsLookup(ctx.state, target, 'AAAA')?.answers ?? []) ctx.out(`${target} has IPv6 address ${r.value}\n`);
    for (const r of dnsLookup(ctx.state, target, 'MX')?.answers ?? []) ctx.out(`${target} mail is handled by ${r.value}\n`);
    return 0;
  },
};

// ------------------------------------------------------------------ reachability

export const ping: CommandDef = {
  name: 'ping',
  summary: 'send ICMP echo requests (defaults to 4 in devquest)',
  run(ctx) {
    let count: number | null = null;
    let target: string | undefined;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-c') count = Number(args[++i]);
      else if (/^-c\d+$/.test(a)) count = Number(a.slice(2));
      else if (a === '-W' || a === '-i' || a === '-w' || a === '-s') i++;
      else if (a.startsWith('-')) continue;
      else target = a;
    }
    if (!target) {
      ctx.err('ping: usage error: Destination address required\n');
      return 1;
    }
    if (count !== null && (!Number.isInteger(count) || count <= 0)) {
      ctx.err(`ping: invalid argument: '${count}': out of range: 1 <= value <= 9223372036854775807\n`);
      return 1;
    }
    const ip = resolveHost(ctx.state, target);
    if (!ip) {
      ctx.err(`ping: ${target}: Name or service not known\n`);
      return 2;
    }
    const n = count ?? 4;
    const reach = pingable(ctx.state, ip);
    ctx.out(`PING ${target} (${ip}) 56(84) bytes of data.\n`);
    const times: number[] = [];
    if (reach.ok) {
      for (let i = 1; i <= n; i++) {
        const t = jitter(reach.latency, i);
        times.push(t);
        ctx.out(`64 bytes from ${ip === target ? ip : `${remoteFor(ctx.state, ip)?.name ?? target} (${ip})`}: icmp_seq=${i} ttl=${isLocalIp(ctx.state, ip) ? 64 : 56} time=${t} ms\n`);
      }
    }
    ctx.out(`\n--- ${target} ping statistics ---\n`);
    const recv = times.length;
    ctx.out(`${n} packets transmitted, ${recv} received, ${Math.round(((n - recv) / n) * 100)}% packet loss, time ${(n - 1) * 1001 + (recv ? 2 : 60)}ms\n`);
    if (recv) {
      const min = Math.min(...times);
      const max = Math.max(...times);
      const avg = times.reduce((s, t) => s + t, 0) / recv;
      const mdev = Math.sqrt(times.reduce((s, t) => s + (t - avg) ** 2, 0) / recv);
      ctx.out(`rtt min/avg/max/mdev = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)}/${mdev.toFixed(3)} ms\n`);
    } else ctx.out('\n');
    if (count === null) ctx.note('devquest: a real ping runs until Ctrl+C; here it stops after 4 (use -c N)\n');
    return recv ? 0 : 1;
  },
};

export const traceroute: CommandDef = {
  name: 'traceroute',
  summary: 'print the route packets take to a host',
  run(ctx) {
    const target = ctx.args.find((a) => !a.startsWith('-'));
    if (!target) {
      ctx.err('Usage:\n  traceroute [ -46dFITnreAUDV ] [ -f first_ttl ] [ -m max_ttl ] host [ packetlen ]\n');
      return 2;
    }
    const ip = resolveHost(ctx.state, target);
    if (!ip) {
      ctx.err(`${target}: Name or service not known\nCannot handle "host" cmdline arg \`${target}' on position 1 (argc 1)\n`);
      return 2;
    }
    ctx.out(`traceroute to ${target} (${ip}), 30 hops max, 60 byte packets\n`);
    const row = (n: number, label: string, base: number) =>
      ` ${String(n).padStart(2)}  ${label}  ${[1, 2, 3].map((k) => `${jitter(base, n * 3 + k).toFixed(3)} ms`).join('  ')}\n`;
    if (isLocalIp(ctx.state, ip)) {
      ctx.out(row(1, `localhost (${ip})`, 0.04));
      return 0;
    }
    const remote = remoteFor(ctx.state, ip);
    const hops = remote?.hops ?? [`_gateway (${ctx.state.net?.gateway ?? '10.0.1.1'})`];
    let n = 0;
    for (const h of hops) {
      n++;
      if (h === '*') ctx.out(` ${String(n).padStart(2)}  * * *\n`);
      else ctx.out(row(n, h.includes('(') ? h : `${h} (${h})`, (remote?.latency ?? 5) * (n / (hops.length + 1)) + 0.3));
    }
    if (remote?.up) {
      ctx.out(row(n + 1, `${remote.name ?? target} (${ip})`, remote.latency));
      return 0;
    }
    for (let k = 1; k <= 3; k++) ctx.out(` ${String(n + k).padStart(2)}  * * *\n`);
    ctx.note('devquest: no reply from the destination (a real traceroute keeps probing up to 30 hops)\n');
    return 0;
  },
};

// ------------------------------------------------------------------ sockets

interface Listener {
  proto: 'tcp' | 'udp';
  addr: string;
  port: number;
  proc: Process | { pid: number; user: string; command: string };
}

/** Everything listening on this host: processes with ports and docker-proxy for published container ports. */
export function listeners(state: SimState): Listener[] {
  const out: Listener[] = [];
  for (const p of state.processes) for (const port of p.ports ?? []) out.push({ proto: 'tcp', addr: '0.0.0.0', port, proc: p });
  let fakePid = 3100;
  for (const c of state.docker?.containers ?? []) {
    if (c.status !== 'running') continue;
    for (const b of c.ports) {
      out.push({ proto: b.proto, addr: b.hostIp, port: b.hostPort, proc: { pid: fakePid++, user: 'root', command: '/usr/bin/docker-proxy' } });
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

const procName = (cmd: string) => cmd.split(/[\s:]/)[0].split('/').pop()!;

export const ss: CommandDef = {
  name: 'ss',
  summary: 'show sockets (ss -tlnp: listening TCP ports and their processes)',
  run(ctx) {
    const flags = new Set(ctx.args.filter((a) => /^-[a-z]+$/.test(a)).flatMap((a) => [...a.slice(1)]));
    const unknown = ctx.args.filter((a) => !/^-[a-z]+$/.test(a));
    if (unknown.length) {
      ctx.err(`devquest: ss filters aren't supported (got '${unknown.join(' ')}'); pipe to grep, e.g. ss -tlnp | grep :8080\n`);
      return 1;
    }
    const all = listeners(ctx.state);
    if (flags.has('s')) {
      const tcp = all.filter((l) => l.proto === 'tcp').length;
      ctx.out(`Total: ${120 + all.length}\nTCP:   ${tcp + 3} (estab 1, closed 0, orphaned 0, timewait 0)\n\nTransport Total     IP        IPv6\nRAW\t  0         0         0\nUDP\t  1         1         0\nTCP\t  ${tcp + 3}         ${tcp + 2}         1\n`);
      return 0;
    }
    const wantTcp = flags.has('t') || !flags.has('u');
    const wantUdp = flags.has('u');
    const numeric = flags.has('n');
    const showProc = flags.has('p');
    const rows = all.filter((l) => (l.proto === 'tcp' ? wantTcp : wantUdp));
    const multi = wantTcp && wantUdp;
    const portStr = (p: number) => (numeric ? String(p) : SERVICES[p] ?? String(p));
    const head = `${multi ? 'Netid ' : ''}State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port${showProc ? ' Process' : ''}`;
    ctx.out(head + '\n');
    for (const l of rows) {
      const local = `${l.addr === '0.0.0.0' && !numeric ? '*' : l.addr}:${portStr(l.port)}`;
      const peer = `${l.addr === '0.0.0.0' && !numeric ? '*' : '0.0.0.0'}:*`;
      // Without root, ss can't see other users' processes.
      const mine = ctx.state.user === 'root' || l.proc.user === ctx.state.user;
      const proc = showProc && mine ? ` users:(("${procName(l.proc.command)}",pid=${l.proc.pid},fd=3))` : '';
      ctx.out(`${multi ? `${l.proto.padEnd(5)} ` : ''}${(l.proto === 'udp' ? 'UNCONN' : 'LISTEN').padEnd(6)} 0      ${l.proto === 'udp' ? '0     ' : '4096  '}  ${local.padStart(18)}   ${peer.padStart(15)}${proc}\n`);
    }
    return 0;
  },
};

export const netstat: CommandDef = {
  name: 'netstat',
  summary: 'print network connections (legacy; prefer ss)',
  run(ctx) {
    const flags = new Set(ctx.args.filter((a) => a.startsWith('-')).flatMap((a) => [...a.slice(1)]));
    if (!flags.has('l')) {
      ctx.err('devquest: netstat supports listening sockets (-tlnp / -tulnp); use ss for more\n');
      return 1;
    }
    const numeric = flags.has('n');
    const showProc = flags.has('p');
    const rows = listeners(ctx.state).filter((l) => (l.proto === 'tcp' ? flags.has('t') || !flags.has('u') : flags.has('u')));
    if (showProc && ctx.state.user !== 'root') {
      ctx.out('(Not all processes could be identified, non-owned process info\n will not be shown, you would have to be root to see it all.)\n');
    }
    ctx.out('Active Internet connections (only servers)\n');
    ctx.out(`Proto Recv-Q Send-Q Local Address           Foreign Address         State      ${showProc ? ' PID/Program name' : ''}\n`);
    for (const l of rows) {
      const local = `${l.addr}:${numeric ? l.port : SERVICES[l.port] ?? l.port}`;
      const mine = ctx.state.user === 'root' || l.proc.user === ctx.state.user;
      const pidCol = showProc ? (mine ? `${l.proc.pid}/${procName(l.proc.command)}` : '-') : '';
      ctx.out(`${l.proto.padEnd(5)}      0      0 ${local.padEnd(23)} ${'0.0.0.0:*'.padEnd(23)} ${l.proto === 'tcp' ? 'LISTEN     ' : '           '}${pidCol}\n`);
    }
    return 0;
  },
};

export const ip: CommandDef = {
  name: 'ip',
  summary: 'show addresses (ip addr) and routes (ip route)',
  run(ctx) {
    const [obj] = ctx.args;
    const net = ctx.state.net;
    if (!net) return 1;
    if (obj && 'address'.startsWith(obj)) {
      net.interfaces.forEach((iface, i) => {
        const lo = iface.name === 'lo';
        ctx.out(
          `${i + 1}: ${iface.name}: <${lo ? 'LOOPBACK' : 'BROADCAST,MULTICAST'},UP,LOWER_UP> mtu ${lo ? 65536 : 1500} qdisc ${lo ? 'noqueue' : 'mq'} state ${lo ? 'UNKNOWN' : 'UP'} group default qlen 1000\n`,
        );
        ctx.out(`    link/${lo ? 'loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00' : `ether ${iface.mac ?? '02:00:00:00:00:01'} brd ff:ff:ff:ff:ff:ff`}\n`);
        const brd = lo ? '' : ` brd ${iface.ip.split('.').slice(0, 3).join('.')}.255`;
        ctx.out(`    inet ${iface.ip}/${iface.prefix}${brd} scope ${lo ? 'host' : 'global'} ${iface.name}\n       valid_lft forever preferred_lft forever\n`);
      });
      return 0;
    }
    if (obj && 'route'.startsWith(obj)) {
      const eth = net.interfaces.find((i) => i.name !== 'lo');
      if (eth) {
        const subnet = eth.ip.split('.').slice(0, 3).join('.') + '.0';
        ctx.out(`default via ${net.gateway} dev ${eth.name} proto dhcp src ${eth.ip} metric 100\n${subnet}/${eth.prefix} dev ${eth.name} proto kernel scope link src ${eth.ip} metric 100\n`);
      }
      return 0;
    }
    ctx.err('devquest: ip supports `ip addr` and `ip route`\n');
    return 1;
  },
};

export const hostname: CommandDef = {
  name: 'hostname',
  summary: 'show the host name (-I: its IP addresses)',
  run(ctx) {
    if (ctx.args.includes('-I')) {
      ctx.out((ctx.state.net?.interfaces.filter((i) => i.name !== 'lo').map((i) => i.ip).join(' ') ?? '') + ' \n');
      return 0;
    }
    if (ctx.args.length) {
      ctx.err('hostname: you must be root to change the host name\n');
      return 1;
    }
    ctx.out(ctx.state.hostname + '\n');
    return 0;
  },
};

export const netCommands: CommandDef[] = [dig, nslookup, host, ping, traceroute, ss, netstat, ip, hostname];
