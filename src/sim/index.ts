import { linuxCommands } from './commands/linux';
import { Shell } from './shell/shell';
import { createInitialState, SimState } from './state';

export { Shell } from './shell/shell';
export * from './state';
export type { RunResult, OutputChunk } from './shell/types';

/** A shell with every simulated Linux command registered. */
export function createShell(state: SimState = createInitialState()): Shell {
  return new Shell(state, linuxCommands);
}
