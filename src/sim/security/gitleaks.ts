/** Secret detection rules (shared with trivy) and gitleaks, which scans every commit in a repository's history. */
import { commitTree, findRepo, revList } from '../git/repo';
import type { CommandDef } from '../shell/types';
import type { Severity } from './vulndb';

interface Rule {
  id: string;
  title: string;
  re: RegExp;
  severity: Severity;
  group?: number;
}

const RULES: Rule[] = [
  { id: 'aws-access-token', title: 'AWS Access Key ID', re: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/, severity: 'CRITICAL', group: 1 },
  { id: 'aws-secret-access-key', title: 'AWS Secret Access Key', re: /aws_?secret_?access_?key["'\s]*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/i, severity: 'CRITICAL', group: 1 },
  { id: 'github-pat', title: 'GitHub Personal Access Token', re: /\b(ghp_[0-9a-zA-Z]{36})\b/, severity: 'CRITICAL', group: 1 },
  { id: 'slack-bot-token', title: 'Slack token', re: /\b(xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*)/, severity: 'HIGH', group: 1 },
  { id: 'stripe-access-token', title: 'Stripe Secret Key', re: /\b(sk_live_[0-9a-zA-Z]{24,99})\b/, severity: 'CRITICAL', group: 1 },
  { id: 'private-key', title: 'Asymmetric Private Key', re: /(-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----)/, severity: 'HIGH', group: 1 },
];

/** Documentation keys every scanner allowlists. */
const ALLOW = [/EXAMPLE/, /^x+$/i];

export interface SecretFinding {
  rule: string;
  title: string;
  severity: Severity;
  line: number;
  match: string;
  secret: string;
  masked: string;
  description: string;
}

function entropy(s: string): number {
  const f: Record<string, number> = {};
  for (const c of s) f[c] = (f[c] ?? 0) + 1;
  return -Object.values(f).reduce((a, n) => a + (n / s.length) * Math.log2(n / s.length), 0);
}

export function secretFindings(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  text.split('\n').forEach((line, i) => {
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (!m) continue;
      const secret = m[r.group ?? 0];
      if (ALLOW.some((a) => a.test(secret))) continue;
      out.push({ rule: r.id, title: r.title, severity: r.severity, line: i + 1, match: line.trim(), secret, masked: line.replace(secret, '*'.repeat(secret.length)).trim(), description: `${r.title} found` });
    }
  });
  return out;
}

export const gitleaks: CommandDef = {
  name: 'gitleaks',
  summary: 'detect secrets in git history (gitleaks git / detect) or files (gitleaks dir)',
  run(ctx) {
    const args = [...ctx.args];
    const flags: Record<string, string> = {};
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const m = /^--?([\w-]+)(?:=(.*))?$/.exec(args[i]);
      if (!m) {
        pos.push(args[i]);
        continue;
      }
      const bool = ['v', 'verbose', 'redact', 'no-git', 'no-banner'].includes(m[1]);
      flags[m[1]] = m[2] ?? (bool ? 'true' : args[++i] ?? '');
    }
    const [cmd, target] = pos;
    if (cmd === 'version') {
      ctx.out('8.21.2\n');
      return 0;
    }
    if (!['detect', 'git', 'dir', 'protect'].includes(cmd ?? '')) {
      ctx.err('Gitleaks scans code, past or present, for secrets\n\nUsage:\n  gitleaks [command]\n\nAvailable Commands:\n  dir         scan directories or files for secrets\n  git         scan git repositories for secrets\n  detect      (deprecated) detect secrets in code\n');
      return 1;
    }
    const verbose = flags.v === 'true' || flags.verbose === 'true';
    const redact = flags.redact === 'true';
    const source = ctx.resolve(flags.source ?? flags.s ?? target ?? '.');
    const t = new Date(ctx.state.clock);
    const clock = `${((t.getUTCHours() + 11) % 12) + 1}:${String(t.getUTCMinutes()).padStart(2, '0')}${t.getUTCHours() < 12 ? 'AM' : 'PM'}`;
    if (flags['no-banner'] !== 'true') ctx.note('\n    ○\n    │╲\n    │ ○\n    ○ ░\n    ░    gitleaks\n\n');
    let ignore = new Set<string>();
    try {
      ignore = new Set(ctx.vfs.readFile(`${source}/.gitleaksignore`).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
    } catch {
      /* none */
    }
    const found: { f: SecretFinding; file: string; commit?: string; author?: string; email?: string; date?: string; fp: string }[] = [];
    const add = (f: SecretFinding, file: string, c?: { sha: string; author: string; email: string; date: string }) => {
      const fp = c ? `${c.sha}:${file}:${f.rule}:${f.line}` : `${file}:${f.rule}:${f.line}`;
      if (!ignore.has(fp)) found.push({ f, file, commit: c?.sha, author: c?.author, email: c?.email, date: c?.date, fp });
    };
    let scanned = '';
    if (cmd === 'dir' || flags['no-git'] === 'true') {
      let n = 0;
      const walk = (d: string, rel: string) => {
        for (const name of ctx.vfs.readdir(d).sort()) {
          if (name === '.git') continue;
          const p = `${d}/${name}`;
          if (ctx.vfs.isDir(p)) walk(p, rel + name + '/');
          else {
            n++;
            try {
              for (const f of secretFindings(ctx.vfs.readFile(p))) add(f, rel + name);
            } catch {
              /* unreadable */
            }
          }
        }
      };
      if (ctx.vfs.isDir(source)) walk(source, '');
      scanned = `scanned ~${n * 512} bytes (${n} files)`;
    } else {
      const repo = findRepo(ctx.state, ctx.vfs, source);
      if (!repo) {
        ctx.err(`${clock} ERR [git] fatal: not a git repository (or any of the parent directories): .git\n${clock} ERR failed to scan Git repository error="stderr is not empty"\n${clock} WRN partial scan completed in 4.21ms\n${clock} WRN no leaks found in partial scan\n`);
        return 1;
      }
      const tips = [...Object.values(repo.heads)];
      const commits = revList(repo, tips);
      for (const sha of [...commits].reverse()) {
        const c = repo.objects.commits[sha];
        const tree = commitTree(repo, sha);
        const parent = c.parents[0] ? commitTree(repo, c.parents[0]) : {};
        for (const [file, e] of Object.entries(tree)) {
          if (parent[file]?.sha === e.sha) continue;
          const oldLines = new Set((parent[file] ? repo.objects.blobs[parent[file].sha] ?? '' : '').split('\n'));
          const text = repo.objects.blobs[e.sha] ?? '';
          for (const f of secretFindings(text)) if (!oldLines.has(text.split('\n')[f.line - 1])) add(f, file, { sha, author: c.author.name, email: c.author.email, date: new Date(c.author.time * 1000).toISOString().replace(/\.\d+Z$/, 'Z') });
        }
      }
      scanned = `${commits.length} commits scanned.`;
    }
    if (verbose) {
      for (const x of found) {
        const secret = redact ? 'REDACTED' : x.f.secret;
        const match = redact ? x.f.match.replace(x.f.secret, 'REDACTED') : x.f.match;
        ctx.out(`Finding:     ${match}\nSecret:      ${secret}\nRuleID:      ${x.f.rule}\nEntropy:     ${entropy(x.f.secret).toFixed(6)}\nFile:        ${x.file}\nLine:        ${x.f.line}\n${x.commit ? `Commit:      ${x.commit}\nAuthor:      ${x.author}\nEmail:       ${x.email}\nDate:        ${x.date}\n` : ''}Fingerprint: ${x.fp}\n\n`);
      }
    }
    ctx.note(`${clock} INF ${scanned}\n${clock} INF scan completed in 18.4ms\n`);
    if (found.length) {
      ctx.note(`${clock} WRN leaks found: ${found.length}\n`);
      return Number(flags['exit-code'] ?? 1);
    }
    ctx.note(`${clock} INF no leaks found\n`);
    return 0;
  },
};
