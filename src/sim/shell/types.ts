import type { SimState } from '../state';
import type { Vfs } from '../vfs/vfs';

export type Stream = 'stdout' | 'stderr';

export interface OutputChunk {
  stream: Stream;
  text: string;
}

export interface CommandContext {
  /** Name the command was invoked as (argv[0]). */
  name: string;
  /** Arguments after the command name, fully expanded. */
  args: string[];
  /** Everything piped or redirected into the command (empty when none). */
  stdin: string;
  /** True when stdout goes to the terminal (not a pipe or file) — affects `ls` layout. */
  stdoutIsTTY: boolean;
  /** Variables visible to the command: exported vars plus `VAR=x cmd` prefixes. */
  env: Record<string, string>;
  state: SimState;
  vfs: Vfs;
  out(text: string): void;
  err(text: string): void;
  /** Resolve a user-supplied path against the cwd. */
  resolve(path: string): string;
  /** Access to the shell for builtins (help, history, clear). */
  shell: ShellApi;
}

export interface ShellApi {
  listCommands(): CommandDef[];
  requestClear(): void;
}

export interface CommandDef {
  name: string;
  /** One-line description shown by `help`. */
  summary: string;
  run(ctx: CommandContext): number;
}

export interface RunResult {
  output: OutputChunk[];
  exitCode: number;
  /** Set by `clear`: the UI should wipe the screen. */
  clear: boolean;
}
