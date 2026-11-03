import { registerHttpProvider } from '../net';
import { docker } from './cli';
import { DockerEngine } from './engine';

export { docker } from './cli';
export { DockerEngine, DockerError } from './engine';
export type * from './types';

/** Let curl reach published container ports and (inside containers) other containers. */
registerHttpProvider((state, req) => {
  const host = state.context?.host ?? state;
  if (!host.docker) return undefined;
  return new DockerEngine(host).http(state, req);
});

export const dockerCommands = [docker];
