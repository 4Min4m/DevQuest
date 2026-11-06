import { linuxCommands } from './commands/linux';
import { dockerCommands } from './docker';
import { netCommands } from './netsim/commands';
import './netsim/resolve';
import { systemdCommands } from './systemd';
import { sudo } from './commands/linux/sudo';
import { perfCommands } from './commands/linux/perf';
import { gitCommands } from './git';
import { kubeCommands, setPodShellFactory } from './kube';
import { helmCommands } from './helm';
import { ciCommands, setRunnerShellFactory } from './ci';
import { argoCommands } from './argocd';
import { Shell } from './shell/shell';
import { createInitialState, SimState } from './state';

export { Shell } from './shell/shell';
export * from './state';
export type { RunResult, OutputChunk } from './shell/types';

/** A shell with every simulated Linux command and the docker CLI registered. */
export function createShell(state: SimState = createInitialState()): Shell {
  return new Shell(state, [...linuxCommands, sudo, ...systemdCommands, ...netCommands, ...perfCommands, ...gitCommands, ...kubeCommands, ...helmCommands, ...ciCommands, ...argoCommands, ...dockerCommands]);
}

// Commands inside pods (shell images, kubectl exec) run through the same shell.
setPodShellFactory((state) => createShell(state));
// CI runner machines too.
setRunnerShellFactory((state) => createShell(state));
