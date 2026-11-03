import type { SimState } from '../state';
import { resolvePath } from '../vfs/path';
import { isVfsError } from '../vfs/types';
import { Vfs } from '../vfs/vfs';
import { wordText } from './ast';
import type { Pipeline, Redirect, SimpleCommand, Word } from './ast';
import { complete, Completion } from './complete';
import { ExpandContext, expandWord } from './expand';
import type { GlobFs } from './glob';
import { homeOf, identityOf } from './identity';
import { parse, ParseError } from './parser';
import type { CommandContext, CommandDef, OutputChunk, RunResult, ShellApi, Stream } from './types';

/** Where a file descriptor's bytes end up. */
type Sink =
  | { kind: 'terminal'; stream: Stream }
  | { kind: 'pipe' }
  | { kind: 'null' }
  | { kind: 'file'; path: string };

/** Real commands we deliberately don't simulate (yet): say so instead of "not found". */
const NOT_SIMULATED = new Set([
  'sed', 'awk', 'vi', 'vim', 'nano', 'less', 'more', 'sudo', 'su', 'apt', 'apt-get', 'yum',
  'systemctl', 'journalctl', 'ssh', 'scp', 'wget', 'tar', 'gzip', 'ln', 'stat', 'file', 'top',
  'htop', 'tr', 'cut', 'xargs', 'tee', 'diff', 'which', 'man', 'ping', 'ip', 'ss', 'netstat',
  'lsof', 'free', 'uptime', 'date', 'git', 'python', 'python3', 'node', 'make', 'bash', 'sh',
  'docker', 'kubectl',
]);

/** Pseudo-PID of the interactive shell (`$$`). */
const SHELL_PID = 1001;

export class Shell {
  private readonly commands = new Map<string, CommandDef>();
  private output: OutputChunk[] = [];
  private clearRequested = false;

  constructor(public state: SimState, commands: CommandDef[] = []) {
    for (const c of commands) this.register(c);
  }

  register(def: CommandDef): void {
    this.commands.set(def.name, def);
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  commandNames(): string[] {
    return [...this.commands.keys()].sort();
  }

  /** Tab completion for the interactive terminal. */
  complete(line: string, cursor: number): Completion {
    return complete(line, cursor, {
      commands: this.commandNames(),
      vfs: this.vfs(),
      cwd: this.state.cwd,
      home: homeOf(this.state),
    });
  }

  /** Execute one line of input exactly like an interactive bash prompt would. */
  run(line: string): RunResult {
    this.output = [];
    this.clearRequested = false;
    const state = this.state;
    if (line.trim()) state.history.push(line);
    state.clock += 1000;

    let script;
    try {
      script = parse(line);
    } catch (e) {
      if (e instanceof ParseError) {
        this.emit('stderr', e.message + '\n');
        state.lastExit = 2;
        return this.result();
      }
      throw e;
    }

    for (const item of script.items) {
      if (item.op === '&&' && state.lastExit !== 0) continue;
      if (item.op === '||' && state.lastExit === 0) continue;
      state.lastExit = this.runPipeline(item.pipeline);
    }
    return this.result();
  }

  private result(): RunResult {
    return { output: this.output, exitCode: this.state.lastExit, clear: this.clearRequested };
  }

  private emit(stream: Stream, text: string): void {
    if (!text) return;
    const last = this.output[this.output.length - 1];
    if (last && last.stream === stream) last.text += text;
    else this.output.push({ stream, text });
  }

  private getVar = (name: string): string | undefined => {
    switch (name) {
      case '?':
        return String(this.state.lastExit);
      case '$':
        return String(SHELL_PID);
      case '0':
        return 'bash';
      case '#':
        return '0';
    }
    if (/^\d$/.test(name)) return '';
    return this.state.vars[name];
  };

  private vfs(): Vfs {
    const state = this.state;
    return new Vfs(state.fs, identityOf(state), () => state.clock);
  }

  private expandCtx(vfs: Vfs): ExpandContext {
    const fs: GlobFs = {
      readdir: (abs) => {
        try {
          return vfs.readdir(abs);
        } catch {
          return null;
        }
      },
      exists: (abs) => vfs.exists(abs),
    };
    return { getVar: this.getVar, home: homeOf(this.state), cwd: this.state.cwd, fs };
  }

  private runPipeline(pipeline: Pipeline): number {
    let stdin = '';
    let code = 0;
    pipeline.commands.forEach((cmd, i) => {
      const isLast = i === pipeline.commands.length - 1;
      const res = this.runSimple(cmd, stdin, isLast);
      stdin = res.piped;
      code = res.code;
    });
    return code;
  }

  private runSimple(cmd: SimpleCommand, stdin: string, isLast: boolean): { code: number; piped: string } {
    const state = this.state;
    const vfs = this.vfs();
    const ectx = this.expandCtx(vfs);

    const argv = cmd.words.flatMap((w) => expandWord(w, ectx));
    const assignments = cmd.assignments.map((a) => ({
      name: a.name,
      value: expandWord(a.value, ectx, { split: false, glob: false }).join(''),
    }));

    // --- set up file descriptors: 0 = stdin, 1 = stdout, 2 = stderr
    let piped = '';
    const sinks: Sink[] = [
      { kind: 'null' },
      isLast ? { kind: 'terminal', stream: 'stdout' } : { kind: 'pipe' },
      { kind: 'terminal', stream: 'stderr' },
    ];
    const redirectError = this.applyRedirects(cmd.redirects, sinks, vfs, ectx, (input) => (stdin = input));
    if (redirectError !== null) return { code: redirectError, piped: '' };

    const write = (fd: 1 | 2, text: string) => {
      const sink = sinks[fd];
      switch (sink.kind) {
        case 'terminal':
          this.emit(sink.stream, text);
          break;
        case 'pipe':
          piped += text;
          break;
        case 'file':
          try {
            vfs.writeFile(sink.path, text, { append: true });
          } catch {
            /* target vanished mid-command; drop output like a closed fd */
          }
          break;
        case 'null':
          break;
      }
    };

    if (argv.length === 0) {
      for (const a of assignments) state.vars[a.name] = a.value;
      return { code: 0, piped };
    }

    const name = argv[0];
    const def = this.commands.get(name);
    let code: number;
    if (!def) {
      code = this.commandNotFound(name, vfs, (t) => write(2, t));
    } else {
      const env: Record<string, string> = {};
      for (const k of state.exported) if (state.vars[k] !== undefined) env[k] = state.vars[k];
      for (const a of assignments) env[a.name] = a.value;
      const shellApi: ShellApi = {
        listCommands: () => this.commandNames().map((n) => this.commands.get(n)!),
        requestClear: () => {
          this.clearRequested = true;
        },
      };
      const ctx: CommandContext = {
        name,
        args: argv.slice(1),
        stdin,
        stdoutIsTTY: sinks[1].kind === 'terminal',
        env,
        state,
        vfs,
        out: (t) => write(1, t),
        err: (t) => write(2, t),
        resolve: (p) => resolvePath(state.cwd, p),
        shell: shellApi,
      };
      try {
        code = def.run(ctx);
      } catch (e) {
        write(2, `${name}: internal simulator error: ${(e as Error).message}\n`);
        code = 1;
      }
    }
    state.commandLog.push({ argv, exitCode: code });
    return { code, piped };
  }

  private commandNotFound(name: string, vfs: Vfs, err: (t: string) => void): number {
    if (name.includes('/')) {
      const abs = resolvePath(this.state.cwd, name);
      try {
        const node = vfs.lookup(abs);
        if (node.type === 'dir') {
          err(`bash: ${name}: Is a directory\n`);
          return 126;
        }
        if (!vfs.can(node, 1)) {
          err(`bash: ${name}: Permission denied\n`);
          return 126;
        }
        err(`devquest: running scripts ('${name}') is not supported in this simulator yet\n`);
        return 126;
      } catch (e) {
        err(`bash: ${name}: ${isVfsError(e) ? e.message : 'No such file or directory'}\n`);
        return 127;
      }
    }
    if (NOT_SIMULATED.has(name)) {
      err(`devquest: '${name}' is a real command, but it is not available in this simulator yet\n`);
      return 127;
    }
    err(`bash: ${name}: command not found\n`);
    return 127;
  }

  /** Returns null on success, or the exit status when a redirect failed (command is skipped). */
  private applyRedirects(
    redirects: Redirect[],
    sinks: Sink[],
    vfs: Vfs,
    ectx: ExpandContext,
    setStdin: (s: string) => void,
  ): number | null {
    for (const r of redirects) {
      const target = this.redirectTarget(r.target, ectx);
      if (target === null) {
        this.emit('stderr', `bash: ${wordText(r.target)}: ambiguous redirect\n`);
        return 1;
      }
      if (r.op === '>&' && /^\d+$/.test(target)) {
        const src = Number(target);
        if (src > 2) {
          this.emit('stderr', `bash: ${target}: Bad file descriptor\n`);
          return 1;
        }
        if (r.fd <= 2) sinks[r.fd] = { ...sinks[src] };
        continue;
      }
      if (r.op === '<') {
        try {
          setStdin(vfs.readFile(resolvePath(this.state.cwd, target)));
        } catch (e) {
          this.emit('stderr', `bash: ${target}: ${isVfsError(e) ? e.message : String(e)}\n`);
          return 1;
        }
        continue;
      }
      const both = r.op === '&>' || r.op === '&>>' || r.op === '>&';
      const append = r.op === '>>' || r.op === '&>>';
      let sink: Sink;
      if (target === '/dev/null') {
        sink = { kind: 'null' };
      } else {
        const path = resolvePath(this.state.cwd, target);
        try {
          if (append) vfs.writeFile(path, '', { append: true });
          else vfs.writeFile(path, '');
        } catch (e) {
          this.emit('stderr', `bash: ${target}: ${isVfsError(e) ? e.message : String(e)}\n`);
          return 1;
        }
        sink = { kind: 'file', path };
      }
      if (both) {
        sinks[1] = sink;
        sinks[2] = { ...sink };
      } else if (r.fd === 1 || r.fd === 2) {
        sinks[r.fd] = sink;
      }
    }
    return null;
  }

  private redirectTarget(word: Word, ectx: ExpandContext): string | null {
    const fields = expandWord(word, ectx);
    return fields.length === 1 ? fields[0] : null;
  }
}

