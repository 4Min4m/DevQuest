/** Test helpers shared by simulator unit tests. */
import { createShell } from './index';
import type { Shell } from './shell/shell';
import { createInitialState, SimState } from './state';
import { identityOf } from './shell/identity';
import { Vfs } from './vfs/vfs';

export interface Run {
  out: string;
  err: string;
  code: number;
}

export interface TestShell {
  shell: Shell;
  state: SimState;
  run(line: string): Run;
  /** Run several lines, failing loudly if any of them writes to stderr. */
  setup(...lines: string[]): void;
  vfs(): Vfs;
  read(path: string): string;
}

export function makeShell(overrides: Partial<SimState> = {}): TestShell {
  const state = createInitialState(overrides);
  const shell = createShell(state);
  const run = (line: string): Run => {
    const r = shell.run(line);
    return {
      out: r.output.filter((c) => c.stream === 'stdout').map((c) => c.text).join(''),
      err: r.output.filter((c) => c.stream === 'stderr').map((c) => c.text).join(''),
      code: r.exitCode,
    };
  };
  const vfs = () => new Vfs(shell.state.fs, identityOf(shell.state), () => shell.state.clock);
  return {
    shell,
    state,
    run,
    setup(...lines) {
      for (const l of lines) {
        const r = run(l);
        if (r.err || r.code !== 0) throw new Error(`setup failed: ${l}\n${r.err}`);
      }
    },
    vfs,
    read: (p) => vfs().readFile(p),
  };
}
