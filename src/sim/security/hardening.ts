/** Host hardening: ufw (a firewall the network honours) and sshd's configuration (sshd -t / -T). */
import { registerMachineGate } from '../machines';
import type { CommandDef } from '../shell/types';
import type { SimState } from '../state';
import { reloadHooks, startHooks } from '../systemd/hooks';
import { Vfs } from '../vfs/vfs';

export interface FwRule {
  port: number;
  proto: 'tcp' | 'udp' | 'any';
  action: 'allow' | 'deny' | 'limit';
  from?: string;
  /** How the user wrote it (shown in status). */
  label: string;
}

export interface Firewall {
  enabled: boolean;
  defaultIncoming: 'deny' | 'allow';
  rules: FwRule[];
}

declare module '../state' {
  interface SimState {
    firewall?: Firewall;
    /** sshd_config as the running sshd loaded it (reload/restart picks up edits). */
    sshdLoaded?: string;
  }
}

const APPS: Record<string, { ports: number[]; label: string }> = {
  openssh: { ports: [22], label: 'OpenSSH' },
  ssh: { ports: [22], label: '22/tcp' },
  http: { ports: [80], label: '80/tcp' },
  https: { ports: [443], label: '443/tcp' },
  'nginx http': { ports: [80], label: 'Nginx HTTP' },
  'nginx https': { ports: [443], label: 'Nginx HTTPS' },
  'nginx full': { ports: [80, 443], label: 'Nginx Full' },
};

function inCidr(ip: string, cidr: string): boolean {
  if (cidr === 'any') return true;
  const [base, bits = '32'] = cidr.split('/');
  const n = (x: string) => x.split('.').reduce((a, o) => a * 256 + Number(o), 0);
  const size = 2 ** (32 - Number(bits));
  return Math.floor(n(ip) / size) === Math.floor(n(base) / size);
}

/** Does the firewall let a TCP connection from `from` reach `port`? */
export function fwAllows(fw: Firewall | undefined, port: number, from: string): boolean {
  if (!fw?.enabled) return true;
  for (const r of fw.rules) {
    if (r.port !== port || r.proto === 'udp') continue;
    if (r.from && !inCidr(from, r.from)) continue;
    return r.action !== 'deny';
  }
  return fw.defaultIncoming === 'allow';
}

// The managed machines' firewalls apply to connections from the workstation.
registerMachineGate((state, m, port) => {
  const from = state.net?.interfaces.find((i) => i.name !== 'lo')?.ip ?? '10.0.1.15';
  return fwAllows(m.firewall, port, from) ? null : 'timeout';
});

function parseRule(args: string[]): { rules: Omit<FwRule, 'action'>[]; error?: string } {
  const from = args.indexOf('from');
  if (from >= 0) {
    const src = args[from + 1];
    const pi = args.indexOf('port');
    const port = Number(args[pi + 1]);
    const proto = args.includes('proto') ? (args[args.indexOf('proto') + 1] as 'tcp') : 'any';
    if (!src || pi < 0 || !port) return { rules: [], error: 'ERROR: Wrong number of arguments' };
    return { rules: [{ port, proto, from: src, label: `${port}${proto !== 'any' ? '/' + proto : ''}` }] };
  }
  const spec = args.join(' ');
  const app = APPS[spec.toLowerCase()];
  if (app) return { rules: app.ports.map((p) => ({ port: p, proto: 'tcp', label: app.label })) };
  const m = /^(\d+)(?:\/(tcp|udp))?$/.exec(spec);
  if (!m) return { rules: [], error: `ERROR: Could not find a profile matching '${spec}'` };
  return { rules: [{ port: Number(m[1]), proto: (m[2] as 'tcp') ?? 'any', label: spec }] };
}

export const ufw: CommandDef = {
  name: 'ufw',
  summary: 'uncomplicated firewall: status, allow, deny, delete, enable',
  run(ctx) {
    const st = ctx.state;
    const args = ctx.args.filter((a) => a !== '--force');
    const force = ctx.args.includes('--force');
    const [cmd, ...rest] = args;
    if (st.user !== 'root') {
      ctx.err('ERROR: You need to be root to run this script\n');
      return 1;
    }
    const fw = (st.firewall ??= { enabled: false, defaultIncoming: 'deny', rules: [] });
    const both = (s: string) => `${s}\n${s.replace('Rule', 'Rule').replace(/$/, ' (v6)')}\n`;
    switch (cmd) {
      case 'status': {
        if (!fw.enabled) {
          ctx.out('Status: inactive\n');
          return 0;
        }
        const numbered = rest[0] === 'numbered';
        let out = `Status: active\n${rest[0] === 'verbose' ? `Logging: on (low)\nDefault: ${fw.defaultIncoming} (incoming), allow (outgoing), deny (routed)\nNew profiles: skip\n` : ''}\n`;
        out += numbered ? '     To                         Action      From\n     --                         ------      ----\n' : 'To                         Action      From\n--                         ------      ----\n';
        const rows = [...fw.rules.map((r) => [r.label, r.action.toUpperCase() + (rest[0] === 'verbose' ? ' IN' : ''), r.from ?? 'Anywhere']), ...fw.rules.filter((r) => !r.from).map((r) => [`${r.label} (v6)`, r.action.toUpperCase() + (rest[0] === 'verbose' ? ' IN' : ''), 'Anywhere (v6)'])];
        rows.forEach((r, i) => (out += `${numbered ? `[${String(i + 1).padStart(2)}] ` : ''}${r[0].padEnd(27)}${r[1].padEnd(12)}${r[2]}\n`));
        ctx.out(out + '\n');
        return 0;
      }
      case 'enable': {
        if (!force) {
          const ans = ctx.stdin.trim().split('\n')[0] ?? '';
          ctx.out(`Command may disrupt existing ssh connections. Proceed with operation (y|n)? ${ans}\n`);
          if (!/^y/i.test(ans)) {
            ctx.out('Aborted\n');
            return 0;
          }
        }
        fw.enabled = true;
        ctx.out('Firewall is active and enabled on system startup\n');
        return 0;
      }
      case 'disable':
        fw.enabled = false;
        ctx.out('Firewall stopped and disabled on system startup\n');
        return 0;
      case 'reset':
        st.firewall = { enabled: false, defaultIncoming: 'deny', rules: [] };
        ctx.out('Resetting all rules to installed defaults. Proceeding with operation (y|n)? y\n');
        return 0;
      case 'default': {
        const [policy, dir] = rest;
        if (!['allow', 'deny', 'reject'].includes(policy) || dir !== 'incoming') {
          if (dir === 'outgoing' || dir === 'routed') {
            ctx.out(`Default ${dir} policy changed to '${policy}'\n(be sure to update your rules accordingly)\n`);
            return 0;
          }
          ctx.err('ERROR: Invalid syntax\n');
          return 1;
        }
        fw.defaultIncoming = policy === 'allow' ? 'allow' : 'deny';
        ctx.out(`Default incoming policy changed to '${policy}'\n(be sure to update your rules accordingly)\n`);
        return 0;
      }
      case 'allow':
      case 'deny':
      case 'limit': {
        const r = parseRule(rest);
        if (r.error) {
          ctx.err(r.error + '\n');
          return 1;
        }
        let msg = '';
        for (const x of r.rules) {
          if (fw.rules.some((y) => y.port === x.port && y.from === x.from && y.action === cmd)) msg += both('Skipping adding existing rule');
          else {
            fw.rules.push({ ...x, action: cmd });
            msg += x.from ? 'Rule added\n' : both('Rule added');
          }
        }
        ctx.out(msg);
        return 0;
      }
      case 'delete': {
        if (/^\d+$/.test(rest[0] ?? '')) {
          const i = Number(rest[0]) - 1;
          if (!fw.rules[i]) {
            ctx.err('ERROR: Could not find rule \'' + rest[0] + "'\n");
            return 1;
          }
          fw.rules.splice(i, 1);
          ctx.out('Rule deleted\n');
          return 0;
        }
        const [action, ...spec] = rest;
        const r = parseRule(spec);
        const before = fw.rules.length;
        fw.rules = fw.rules.filter((x) => !(x.action === action && r.rules.some((y) => y.port === x.port && y.from === x.from)));
        if (fw.rules.length === before) {
          ctx.err('Could not delete non-existent rule\n');
          return 1;
        }
        ctx.out(both('Rule deleted'));
        return 0;
      }
    }
    ctx.err("ERROR: Invalid syntax\n\nUsage: ufw COMMAND\n\nCommands:\n enable | disable | reload | default ARG | status [verbose|numbered] | allow ARGS | deny ARGS | limit ARGS | delete RULE|NUM | reset\n");
    return 1;
  },
};

// ------------------------------------------------------------------ sshd

const SSHD_KEYS: Record<string, string[] | null> = {
  port: null,
  listenaddress: null,
  permitrootlogin: ['yes', 'no', 'prohibit-password', 'without-password', 'forced-commands-only'],
  passwordauthentication: ['yes', 'no'],
  pubkeyauthentication: ['yes', 'no'],
  kbdinteractiveauthentication: ['yes', 'no'],
  challengeresponseauthentication: ['yes', 'no'],
  permitemptypasswords: ['yes', 'no'],
  usepam: ['yes', 'no'],
  x11forwarding: ['yes', 'no'],
  printmotd: ['yes', 'no'],
  maxauthtries: null,
  allowusers: null,
  allowgroups: null,
  denyusers: null,
  acceptenv: null,
  subsystem: null,
  include: null,
  logingracetime: null,
  clientaliveinterval: null,
  clientalivecountmax: null,
  allowtcpforwarding: ['yes', 'no', 'local', 'remote', 'all'],
  authorizedkeysfile: null,
  hostkey: null,
};

const DEFAULTS: Record<string, string> = { port: '22', permitrootlogin: 'prohibit-password', passwordauthentication: 'yes', pubkeyauthentication: 'yes', permitemptypasswords: 'no', x11forwarding: 'no', maxauthtries: '6', usepam: 'yes', kbdinteractiveauthentication: 'no' };

/** Parse sshd_config: effective settings (first value wins, like sshd) or errors. */
export function sshdParse(text: string): { cfg: Record<string, string>; errors: string[] } {
  const cfg: Record<string, string> = {};
  const errors: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) {
      errors.push(`/etc/ssh/sshd_config line ${i + 1}: missing argument.`);
      return;
    }
    const k = m[1].toLowerCase();
    if (k === 'match') return;
    if (!(k in SSHD_KEYS)) {
      errors.push(`/etc/ssh/sshd_config: line ${i + 1}: Bad configuration option: ${m[1]}`);
      return;
    }
    const allowed = SSHD_KEYS[k];
    if (allowed && !allowed.includes(m[2].toLowerCase())) {
      errors.push(`/etc/ssh/sshd_config line ${i + 1}: unsupported option "${m[2]}".`);
      return;
    }
    if (!(k in cfg)) cfg[k] = m[2];
  });
  return { cfg, errors };
}

function readConf(state: SimState): string {
  try {
    return new Vfs(state.fs, { name: 'root', groups: ['root'] }).readFile('/etc/ssh/sshd_config');
  } catch {
    return '';
  }
}

/** The settings the running sshd uses. */
export function sshdEffective(state: SimState): Record<string, string> {
  return { ...DEFAULTS, ...sshdParse(state.sshdLoaded ?? readConf(state)).cfg };
}

const snapshot = (state: SimState, unit: string) => {
  if (unit !== 'ssh.service' && unit !== 'sshd.service') return undefined;
  const text = readConf(state);
  const { errors } = sshdParse(text);
  if (errors.length) return [{ msg: errors[0], prio: 3 }];
  state.sshdLoaded = text;
  return [];
};
reloadHooks.push(snapshot);
startHooks.push((state, unit) => {
  snapshot(state, unit);
});

export const sshd: CommandDef = {
  name: 'sshd',
  summary: 'OpenSSH daemon: sshd -t (test config), sshd -T (show effective config)',
  run(ctx) {
    if (!ctx.args.includes('-t') && !ctx.args.includes('-T')) {
      ctx.err('devquest: sshd runs as the ssh service; use sshd -t to test the config, then systemctl reload ssh\n');
      return 1;
    }
    if (ctx.state.user !== 'root') {
      ctx.err('sshd: no hostkeys available -- exiting.\n');
      return 1;
    }
    const { cfg, errors } = sshdParse(readConf(ctx.state));
    if (errors.length) {
      ctx.err(errors.join('\n') + `\n/etc/ssh/sshd_config: terminating, ${errors.length} bad configuration options\n`);
      return 255;
    }
    if (ctx.args.includes('-T')) {
      const all = { ...DEFAULTS, ...cfg };
      ctx.out(Object.keys(all).sort().map((k) => `${k} ${all[k].toLowerCase() === 'without-password' ? 'prohibit-password' : all[k]}`).join('\n') + '\n');
    }
    return 0;
  },
};
