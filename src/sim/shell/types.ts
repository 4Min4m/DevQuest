import type { SimState } from '../state';
import type { Vfs } from '../vfs/vfs';

export type Stream = 'stdout' | 'stderr';

export interface OutputChunk {
  stream: Stream;
  text: string;
  /** Informational stderr (e.g. docker pull progress) — the UI shouldn't style it as an error. */
  note?: boolean;
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
  /** Informational text on stderr (progress, warnings) — same stream, not shown as an error. */
  note(text: string): void;
  /** Resolve a user-supplied path against the cwd. */
  resolve(path: string): string;
  /** Access to the shell for builtins (help, history, clear). */
  shell: ShellApi;
}

/** Ask the UI to open a text editor (nano). */
export interface EditRequest {
  /** Path as the user typed it (shown in the editor title). */
  display: string;
  content: string;
  /** Which editor the user asked for (nano, vi, vim). */
  editor: string;
  /** Write the new content; returns an error message (nano style) or null on success. */
  save(text: string): string | null;
}

export interface ShellApi {
  listCommands(): CommandDef[];
  requestClear(): void;
  /** Open an editor in the UI once the command finishes. */
  edit(req: EditRequest): void;
  /** A separate shell over another machine state (e.g. a container), sharing the command set. */
  spawn(state: SimState): ShellLike;
  /**
   * Hand the interactive terminal to a nested shell (`docker exec -it`) until the user
   * types `exit`; `onExit` receives the exit status.
   */
  attach(state: SimState, onExit: (code: number) => void): void;
}

/** The part of Shell other modules may drive. */
export interface ShellLike {
  run(line: string, stdin?: string): RunResult;
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
  /** Set by `nano`: the UI should open an editor. */
  edit?: EditRequest;
}
