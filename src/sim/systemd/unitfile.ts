/** Parsing of systemd unit files (the subset of keys DevOps Quest simulates). */

export interface UnitConfig {
  description: string;
  after: string[];
  execStart: string;
  execReload?: string;
  type: string;
  user?: string;
  group?: string;
  restart: 'no' | 'always' | 'on-failure' | 'on-abnormal' | 'on-success';
  environment: Record<string, string>;
  environmentFiles: string[];
  workingDirectory?: string;
  limitNofile?: number;
  wantedBy: string[];
  /** Problems systemd logs while loading ("Unknown key name ...", "Missing ExecStart="...). */
  warnings: string[];
  /** Set when systemd refuses to load the unit at all. */
  badSetting?: string;
}

const KNOWN: Record<string, string[]> = {
  Unit: ['Description', 'After', 'Before', 'Requires', 'Wants', 'Documentation'],
  Service: [
    'ExecStart', 'ExecReload', 'ExecStop', 'Type', 'User', 'Group', 'Restart', 'RestartSec', 'Environment',
    'EnvironmentFile', 'WorkingDirectory', 'LimitNOFILE', 'TimeoutStopSec', 'StandardOutput', 'StandardError',
  ],
  Install: ['WantedBy', 'RequiredBy', 'Alias'],
};

/** Parse `Environment=A=1 "B=two words"` into pairs. */
function envPairs(value: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(value))) {
    const item = m[1] ?? m[2] ?? m[3];
    const eq = item.indexOf('=');
    if (eq > 0) out.push([item.slice(0, eq), item.slice(eq + 1)]);
  }
  return out;
}

export function parseUnit(name: string, text: string, path = `/etc/systemd/system/${name}`): UnitConfig {
  const cfg: UnitConfig = {
    description: name,
    after: [],
    execStart: '',
    type: 'simple',
    restart: 'no',
    environment: {},
    environmentFiles: [],
    wantedBy: [],
    warnings: [],
  };
  let section = '';
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) return;
    const sec = /^\[(\w+)\]$/.exec(line);
    if (sec) {
      section = sec[1];
      if (!KNOWN[section]) cfg.warnings.push(`${path}:${i + 1}: Unknown section '${section}'. Ignoring.`);
      return;
    }
    const eq = line.indexOf('=');
    if (eq < 0) {
      cfg.warnings.push(`${path}:${i + 1}: Missing '=', ignoring line.`);
      return;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!KNOWN[section]?.includes(key)) {
      if (KNOWN[section]) cfg.warnings.push(`${path}:${i + 1}: Unknown key name '${key}' in section '${section}', ignoring.`);
      return;
    }
    switch (key) {
      case 'Description':
        cfg.description = value;
        break;
      case 'After':
        cfg.after.push(...value.split(/\s+/));
        break;
      case 'ExecStart':
        cfg.execStart = value.replace(/^[-@+!]+/, '');
        break;
      case 'ExecReload':
        cfg.execReload = value;
        break;
      case 'Type':
        cfg.type = value;
        break;
      case 'User':
        cfg.user = value;
        break;
      case 'Group':
        cfg.group = value;
        break;
      case 'Restart':
        if (['no', 'always', 'on-failure', 'on-abnormal', 'on-success'].includes(value)) cfg.restart = value as UnitConfig['restart'];
        else cfg.warnings.push(`${path}:${i + 1}: Failed to parse service restart specifier, ignoring: ${value}`);
        break;
      case 'Environment':
        for (const [k, v] of envPairs(value)) cfg.environment[k] = v;
        break;
      case 'EnvironmentFile':
        cfg.environmentFiles.push(value);
        break;
      case 'WorkingDirectory':
        cfg.workingDirectory = value;
        break;
      case 'LimitNOFILE': {
        const n = value === 'infinity' ? Infinity : Number(value.split(':').pop());
        if (Number.isFinite(n) || n === Infinity) cfg.limitNofile = n;
        else cfg.warnings.push(`${path}:${i + 1}: Invalid resource value, ignoring: LimitNOFILE=${value}`);
        break;
      }
      case 'WantedBy':
        cfg.wantedBy.push(...value.split(/\s+/));
        break;
    }
  });
  if (!cfg.execStart) {
    cfg.badSetting = `${name}: Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.`;
  } else if (!cfg.execStart.startsWith('/')) {
    cfg.badSetting = `${name}: Neither a valid executable name nor an absolute path: ${cfg.execStart.split(/\s+/)[0]}`;
  }
  return cfg;
}

/** "nginx" → "nginx.service"; other suffixes are kept. */
export function unitName(n: string): string {
  return /\.(service|socket|timer|target|mount)$/.test(n) ? n : `${n}.service`;
}
