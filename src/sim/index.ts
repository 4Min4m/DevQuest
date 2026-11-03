import { linuxCommands } from './commands/linux';
import { dockerCommands } from './docker';
import { Shell } from './shell/shell';
import { createInitialState, SimState } from './state';

export { Shell } from './shell/shell';
export * from './state';
export type { RunResult, OutputChunk } from './shell/types';

/** A shell with every simulated Linux command and the docker CLI registered. */
export function createShell(state: SimState = createInitialState()): Shell {
  return new Shell(state, [...linuxCommands, ...dockerCommands]);
}
